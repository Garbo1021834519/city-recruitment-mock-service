import { DatabaseSync } from "node:sqlite";
import { scryptSync, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./connection.js";
import { migrateDatabase } from "./migrate.js";
import { ACTIVATION_STRATEGY_DEFAULTS } from "../modules/activation/activation.strategies.js";

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function seedDatabase(db: DatabaseSync): void {
  const fixtures = [
    { username: "local-admin", role: "admin", recruiter_type: "" },
    { username: "local-customer", role: "customer", recruiter_type: "service" },
    { username: "local-recruiter", role: "recruiter", recruiter_type: "" },
  ];
  const password = process.env.REA_LOCAL_SEED_PASSWORD ?? "local-demo-only";
  for (const user of fixtures) {
    db.prepare("INSERT OR IGNORE INTO users(username,password_hash,role,recruiter_type) VALUES (?,?,?,?)")
      .run(user.username, hashPassword(password), user.role, user.recruiter_type);
  }
  // Mock fixtures below are entirely fabricated placeholder data (fictional
  // district lists, synthetic phone numbers, made-up candidate names) — they
  // are not copied from or derived from the target production site. Purpose:
  // give list endpoints non-empty data so parity probes can compare item
  // shapes, not reproduce real business data.
  const mockCities = [
    { id: 1, city_name: "广州", province: "广东", districts: ["天河区", "白云区", "番禺区"] },
    { id: 2, city_name: "深圳", province: "广东", districts: ["南山区", "宝安区", "龙华区"] },
    { id: 3, city_name: "东莞", province: "广东", districts: ["南城区", "长安镇", "虎门镇"] },
  ];
  for (const city of mockCities) {
    db.prepare("INSERT OR IGNORE INTO cities(id,city_name,province,data_json) VALUES (?,?,?,?)")
      .run(city.id, city.city_name, city.province, JSON.stringify({ districts: city.districts, interview_site_name: `${city.city_name}示例面试点` }));
  }
  db.prepare("INSERT OR IGNORE INTO city_links(city_id,linked_city_id) VALUES (1,2)").run();
  db.prepare("INSERT OR IGNORE INTO city_links(city_id,linked_city_id) VALUES (2,3)").run();

  db.prepare("INSERT OR IGNORE INTO factories(id,factory_name,city_id) VALUES (1,'本地示例工厂',1)").run();
  db.prepare("INSERT OR IGNORE INTO factories(id,factory_name,city_id) VALUES (2,'示例电子厂',2)").run();
  db.prepare("INSERT OR IGNORE INTO service_positions(id,position_name,factory_id,city_id) VALUES (1,'本地示例岗位',1,1)").run();
  db.prepare("INSERT OR IGNORE INTO service_positions(id,position_name,factory_id,city_id) VALUES (2,'示例产线岗位',2,2)").run();
  db.prepare("INSERT OR IGNORE INTO knowledge_items(id,title,content) VALUES (1,'本地示例知识','仅供测试')").run();

  db.prepare("INSERT OR IGNORE INTO recruiters(id,username,city_id,data_json) VALUES (1,'mock-recruiter',1,?)")
    .run(JSON.stringify({ recruiter_id: "mock-recruiter", name: "示例招聘员", recruiter_type: "service" }));
  db.prepare("UPDATE users SET recruiter_id='mock-recruiter' WHERE username IN ('local-customer','local-recruiter') AND recruiter_id=''").run();
  const seedScope = db.prepare("INSERT OR IGNORE INTO user_scope_assignments(user_id,scope_type,scope_id) SELECT id,?,? FROM users WHERE username=?");
  for (const username of ["local-customer", "local-recruiter"]) {
    seedScope.run("recruiter", "mock-recruiter", username);
    seedScope.run("city", "1", username);
  }

  const candidates = [
    { customer_id: "mock-c1", nickname: "示例候选人A", name: "张三（示例）", phone: "13800000001", city: "广州" },
    { customer_id: "mock-c2", nickname: "示例候选人B", name: "李四（示例）", phone: "13800000002", city: "深圳" },
  ];
  for (const [index, c] of candidates.entries()) {
    db.prepare("INSERT OR IGNORE INTO candidate_events(id,device_code,customer_id,nickname,event_type,name,phone,city,status) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(9001 + index, "mock-device-1", c.customer_id, c.nickname, "invited", c.name, c.phone, c.city, "invited");
  }
  db.prepare("INSERT OR IGNORE INTO old_friend_records(id,account,customer_id,nickname,device_code,status) VALUES (9001,'mock-account-1','mock-c1','示例老友A','mock-device-1','active')").run();
  db.prepare("INSERT OR IGNORE INTO activation_strategies(id,strategy_name) VALUES (1,'本地示例策略')").run();
  const insertActivationStrategy = db.prepare("INSERT OR IGNORE INTO activation_strategy_rules(code,enabled,config_json) VALUES (?,?,?)");
  for (const strategy of ACTIVATION_STRATEGY_DEFAULTS) insertActivationStrategy.run(strategy.code, strategy.enabled ? 1 : 0, JSON.stringify(strategy.config));
  db.prepare("INSERT OR IGNORE INTO activation_config(id) VALUES (1)").run();
  db.prepare("INSERT OR IGNORE INTO activation_devices(id,device_name,status,data_json) VALUES (1,'本地示例设备','enabled','{}')").run();
  db.prepare("INSERT OR IGNORE INTO agent_devices(id,device_name,status,data_json) VALUES (1,'本地示例设备','enabled','{}')").run();
  const demoDevice = db.prepare("SELECT data_json FROM agent_devices WHERE id=1").get() as { data_json: string } | undefined;
  if (demoDevice) {
    let deviceData: Record<string, unknown> = {};
    try { deviceData = JSON.parse(demoDevice.data_json) as Record<string, unknown>; } catch { deviceData = {}; }
    if (!deviceData.device_code) {
      deviceData.device_code = "local-device-001";
      deviceData.recruiter_id = "mock-recruiter";
      db.prepare("UPDATE agent_devices SET data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=1").run(JSON.stringify(deviceData));
    }
  }
  for (const username of ["local-customer", "local-recruiter"]) seedScope.run("device", "local-device-001", username);
  db.prepare("INSERT OR IGNORE INTO agent_conversations(device_code,customer_id,nickname,city,district,last_msg,last_msg_at,unread) VALUES (?,?,?,?,?,?,?,?)")
    .run("local-device-001", 700001, "示例客户A", "广州", "天河区", "想了解一下长白班岗位", new Date().toISOString(), 1);
  db.prepare("INSERT OR IGNORE INTO agent_messages(id,device_code,customer_id,direction,content,status) VALUES (700001,?,?,?,?,?)")
    .run("local-device-001", 700001, "inbound", "想了解一下长白班岗位", "sent");
  db.prepare("INSERT OR IGNORE INTO agent_messages(id,device_code,customer_id,direction,content,status) VALUES (700002,?,?,?,?,?)")
    .run("local-device-001", 700001, "outbound", "可以的，我先给你发几个示例岗位。", "sent");
  const scripts = [
    [25, "有收到吗？收到回复下我呢", "寒暄召回"], [22, "这边还要找工作的么，这几天岗位都挺好的呢", "寒暄召回"], [16, "这边看的咋样啦，我们继续聊聊呗", "岗位推荐"],
  ] as const;
  for (const [id, content, category] of scripts) db.prepare("INSERT OR IGNORE INTO activation_scripts(id,script_name,content,status,data_json) VALUES (?,?,?,?,?)").run(id, category, content, "enabled", JSON.stringify({ category, is_active: true, used_count: 0 }));
  const knowledge = ["超龄", "可以不加班吗", "买社保吗", "有试用期吗", "合同签多久"]; for (const [index, question] of knowledge.entries()) db.prepare("INSERT OR IGNORE INTO knowledge_items(id,title,content,status,data_json) VALUES (?,?,?,?,?)").run(4176 + index, question, question, "enabled", JSON.stringify({ question, keywords: [], is_active: true, sort_order: 0 }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDatabase();
  migrateDatabase(db);
  seedDatabase(db);
  db.close();
  console.log("seed data ready");
}

