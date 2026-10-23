# 本地还原验证记录

更新时间：2026-10-23

## 已验证

- Node.js 22 环境下可安装依赖；使用内置 `node:sqlite`，不要求 Visual Studio C++ 工具链。
- `npm run dev` 启动 Fastify 静态服务和 SQLite API。
- `/login`、`/cities`、`/m`、`/service-positions` 等 SPA 路由返回原站入口页面。
- 从目标站点获取 57 个同源前端资源，提取 38 条路由和 149 个 `/api/v1` 接口契约。
- 本地登录返回 `{access_token, token_type:"bearer"}`；`/api/v1/auth/me` 返回用户名、角色、招聘员字段。
- 城市、工厂、服务岗位已实现 SQLite 列表、详情、创建、更新、删除、状态或精选切换。
- 知识库、未知问题、节假日、招聘员、设备、候选人、规则、评估、老客、激活策略/设备/脚本等资源已有 SQLite CRUD 路由。
- 设置、城市关联、导入导出、上传接口已接入本地服务。
- 7 个测试文件、17 个测试断言通过；TypeScript 构建通过。

## 当前本地账号

这些是本地种子账号，只用于复刻系统测试：

| 用户名 | 密码 | 角色 | 用途 |
|---|---|---|---|
| `local-admin` | `local-demo-only` | `admin` | 管理模块测试 |
| `local-customer` | `local-demo-only` | `customer` | 客户角色测试 |
| `local-recruiter` | `local-demo-only` | `recruiter` | 招聘员路由守卫测试 |

## 启动

```powershell
cd C:\CODE\城市招聘配置还原
npm install
npm run migrate
npm run seed
npm run dev
```

浏览器打开 `http://127.0.0.1:8080/login`。

可修改端口和数据库路径：

```powershell
$env:REA_PORT="8090"
$env:REA_DATABASE_PATH="C:\CODE\城市招聘配置还原\data\app.sqlite"
npm run dev
```

## 证据边界

目标站点目前只用 `yihong` 账号做过真实登录和页面观测。admin/recruiter 的菜单、默认落点和部分权限来自前端静态路由守卫，并使用本地种子角色验证；由于没有目标站点对应的真实角色账号，不能声称这些角色的运行时结果已经与生产完全一致。

当前“149 个接口都有 handler”表示页面不会因为未发现路由而直接 404；业务字段和状态机已经在核心城市/工厂/岗位及通用资源表中落地，其余复杂激活/Agent 流程仍需要更多目标端运行证据逐项比对。

目标站点使用 HTTP，且登录流程会把访问令牌保存到浏览器存储。复刻服务只在本机监听，JWT 使用本地开发密钥；部署到其他环境前必须替换密钥、启用 HTTPS 和持久化密码策略。

## 第二阶段验收（2026-10-21）

- 用 `playwright-cli` 实际打开本地 `/login`，使用 `local-admin` 登录成功。
- 浏览器访问城市列表、城市新增表单并提交“测试城市”，保存后回到列表，列表数量和状态卡片更新。
- 修复了 `CityForm` 初始化时 `Cannot access 'q' before initialization` 的运行时错误；修复后表单加载无错误。
- 浏览器打开 `/activation/today`，激活名单筛选、批量操作按钮、表格和分页正常显示。
- 浏览器打开 `/conversations`，设备列表、客户列表和消息区域正常显示；空数据状态显示“暂无设备/暂无客户”。
- 第二阶段测试覆盖 Agent 设备和人工回复、激活记录审核/发送状态机；全套测试为 8 个测试文件、19 个断言，全部通过。

## 全量数据源与权限取证（2026-10-21）

- 使用隔离浏览器登录目标站，访问 30 个代表性路由，66 个步骤全部完成，证据文件不含明文密码或 JWT。
- 目标站 `yihong` 的真实权限：`GET /api/v1/auth/users` 返回 403 `Admin access required`；`GET /api/v1/recruiter-featured/cities` 返回 403 `主推设置仅对招聘员账号开放`。
- 真实接口响应字段已用于本地模型：Agent 状态看板的设备/消息/队列/错误/小时统计，激活配置的 `paused/schedule_time/freeze_days/auto_review`，激活设备的限额字段，招聘员及其城市关系，语料库的 `content/category/is_active/used_count`，知识库的 `question/keywords/is_active/sort_order`，系统设置和 Agent 地址。
- 本地权限回归：admin 可访问用户管理，customer 被拒绝；recruiter 可访问主推城市，customer 被拒绝。

## 剩余业务模块还原（2026-10-21）

按业务目的补齐了以下链路：

- Agent 提醒/跟进规则：控制面试提醒时间、跟进间隔、最大次数和话术。
- 候选人：从会话事件生成候选记录，支持邀约筛选和状态标记。
- 老友：保存释放客户，支持释放、取消释放和删除，避免重复触达。
- 评估/报表：提供评估概览、详情、执行入口和账号汇总结构。
- 激活策略：按沉默、到期、误判和暂停四类策略输出规则字段。
- 激活脚本：提供分类、启用状态、使用次数、统计和随机抽取。
- 激活仪表盘：提供待审核、已发送、回复率、冷冻数量、趋势和策略效果。

目标站真实响应字段来源记录在 `过程文件/remaining-response-shapes.json`；抓包中的设备密钥、客户数据和令牌已删除。

## Response Serializer Phase 1 验收（2026-10-23）

- 新增独立响应 serializer，覆盖城市、工厂、服务岗位、招聘员、候选人、Agent 设备、城市关联、评估概览、指标、状态看板和账号汇总。
- 修正字段契约：服务岗位 `base_sections` 固定 18 个字符串键；招聘员关联城市返回目标字段；城市关联用城市名作键、城市名字符串作值；账号汇总补齐 7 个数值指标。
- 新增只读认证 GET parity 探针 `scripts/probe-readonly.ts`。通过 `过程文件/parity/run-readonly-probe.ps1` 交互输入目标账号；目标端只接收登录和 GET，不执行写接口。报告只保存响应结构指纹，不保存响应值或令牌。
- 61 条 GET 结果：50 `verified`，11 `data-dependent`，0 `partial`，0 `target-internal-failure`。数据依赖差异来自目标真实记录/配置和本地演示 SQLite 数据量不同，不代表业务数据完全一致。
- 本次完整验证：13 个测试文件、41 个测试通过；`npm run build` 通过。
- 基线证据：`过程文件/parity/readonly-authenticated-diff-phase1.json`（使用新建空 SQLite 数据库重跑，避免后续转换测试数据污染 Phase 1 基线）。
- Phase 1 状态：`verified`。Phase 2（`unknown-question -> knowledge-item` 转换闭环）可开始。

## Unknown Question Conversion Phase 2 验收（2026-10-23）

- 数据库迁移 006 为未知问题增加 `converted_knowledge_id`、`converted_at` 和关联索引；转换元数据不进入未知问题公开响应。
- 转换接口 `POST /api/v1/unknown-questions/:id/convert` 在 SQLite `BEGIN IMMEDIATE` 事务内创建知识库条目并更新原问题状态为前端使用的 `resolved`。
- 新建知识条目写入 `question`、`answer`、`keywords`、`sort_order`、`recruiter_id`，通过现有知识库 serializer 出现在 `/api/v1/knowledge`。
- 不存在的问题返回 404；缺少/空白答案返回 422；已转换/非 pending 问题返回 409；知识插入失败或来源状态更新未实际生效时回滚整个事务。
- API 测试覆盖转换可见性、关联 ID/时间、重复转换、缺 answer、404 和两种失败回滚；4/4 通过。浏览器在本地 `/unknown-questions` 点击“转知识库”，页面状态变为“已处理”，新条目及关键词出现在 `/knowledge`。
- 完整验证：14 个测试文件、45 个测试通过；`npm run build` 通过。
- Phase 2 完成后的只读 GET parity：61 条，48 `verified`、13 `data-dependent`、0 `partial`、0 `target-internal-failure`。新增的数据依赖差异为本地转换知识条目的非空关键词和未知问题测试记录；目标站没有进行任何写请求。
- 证据：`过程文件/parity/readonly-authenticated-diff-phase2.json`。Phase 2 状态：`verified`。

## Activation Rule Engine Phase 3 验收（2026-10-23）

- 新增纯函数规则引擎 `src/modules/activation/activation.rules.ts`，统一输出 `{matched, reason, strategy, next_push_at, eligible}`，并将“规则命中”和“当前是否可执行”分开。
- 四种策略已实现：`no_reply`（坐席最后发言后的沉默窗口和首次对话年龄）、`date_trigger`（邀约面试日期窗口且未签到）、`misjudge`（不符合事件后 72 小时内客户新消息）、`paused`（暂停意图话术和静默期）。
- 新增迁移 007 的 `activation_strategy_rules` 表；策略按前端使用的 code 持久化，`PUT /api/v1/activation/strategies/:code` 和 `POST /api/v1/activation/strategies/:code/test` 共用同一规则配置和快照读取逻辑。
- 覆盖停用策略、全局暂停、冷却期、未知 code、缺 customer_id、无匹配边界；规则与 API 测试共 10 个通过。策略预览页面用本地合成客户 ID 验证，显示可读的“激活依据”摘要，不发送消息。
- 主体实现后的完整验证曾通过 16 个测试文件、55 个测试；类型修复后的新鲜定向验证为 5 个测试文件、27 个测试通过，`npm run build` 通过。之后两次全量重跑在本机 Node/Vitest 进程资源异常时卡在权限测试登录 helper（5 秒测试超时），未将其计为通过。
- Phase 3 只读 GET parity：61 条，48 `verified`、13 `data-dependent`、0 `partial`、0 `target-internal-failure`。策略列表和 activation config 没有剩余结构差异。
- 证据：`过程文件/parity/readonly-authenticated-diff-phase3.json`。Phase 3 状态：`verified`。Phase 4 SQLite 调度器尚未开始。

## SQLite Scheduler Phase 4 验收（2026-10-24）

- 新增迁移 008：`jobs`、`job_attempts`、`job_locks`，任务记录 kind、payload、run_at、attempts、max_attempts、last_error、locked_until、completed_at。
- `JobStore` 负责入队、到期领取、过期锁回收、成功、失败、重试、dead-letter 和命名锁；所有状态转移使用 SQLite 事务。
- `Scheduler` 使用可注入 Clock，支持指数退避；`JobExecutor` 以 kind 注册处理器，未知 kind 会进入可重试失败路径。
- 调度器测试覆盖：单次领取互斥、重试退避、成功、dead-letter、进程重启后锁回收、命名 leader 锁和 typed executor，共 6 个行为测试；数据库迁移回归通过。
- 已接入 `activation.scan` 和 `message.send`：扫描四种规则快照生成幂等 `activation_records`；开启自动审核时创建发送任务；发送任务写入本地 `agent_messages` 并更新激活记录，重复任务不会重复发送。
- 新增 admin-only `POST /api/v1/activation/scheduler/run` 作为本地手动调度入口；`JobBackend` 接口为 Redis/Celery 适配保留边界，当前实现仍是 SQLite。
- 业务接线测试覆盖扫描幂等、自动审核、任务发送、重复消息保护和 HTTP 触发，共 4 个测试；调度器/数据库测试 8 个通过。
- Phase 4 只读 GET parity：61 条，47 `verified`、14 `data-dependent`、0 `partial`、0 `target-internal-failure`。新增 data-dependent 项为本地激活记录/动态 dashboard 集合，不是结构差异。
- Phase 4 状态：`verified`。下一步进入 Phase 5 `DifyProvider`。

## 复杂业务第二轮验收（2026-10-21）

业务链路与目标页面验证：

- 候选人管理：浏览器打开 `/candidates`，显示事件筛选、面试日期筛选、导出按钮和候选人表格；接口支持创建、分页和状态标记。
- 郎职师运营：浏览器打开 `/account-summary`，显示设备、求职者、邀约、待邀约、不符合、签到和邀约率汇总卡片。
- 激活策略：浏览器打开 `/activation/strategies`，真实显示四类策略、触发条件、发送时段、三档推送、每日限额和调度引擎配置。
- Agent 规则：提醒规则和跟进规则保存到 `agent_configs`，读取字段与目标页面一致。
- 老友管理：记录、账号列表、释放/取消释放/删除接口落到 `old_friend_records`。
- 评估与报表：提供 overview/detail/run 和 account-summary 数据结构。

全套测试：10 个测试文件、23 个断言通过；TypeScript 构建通过。

## 关系和批量操作补齐（2026-10-21）

- 城市关联批量保存和招聘员城市分配已落库。
- 知识库批量更新/删除已落库并返回更新/删除计数。
- Agent workflow 支持读取、保存和删除。
- Agent report metrics 返回消息、会话、候选人和邀约统计。
- Agent 设备种子与 workflow 流程打通。
- 全套测试已达到 11 个测试文件、26 个断言并全部通过。

## 关系与规则页面回归（2026-10-21）

- `/agent-rules` 浏览器加载成功，面试提醒/追问设置控件和禁用状态与接口数据一致。
- `/candidates`、`/account-summary`、`/activation/strategies` 已在此前回归中通过。
- 城市关联、招聘员城市分配、知识库批量操作、Agent workflow 和 metrics 已补齐并通过接口测试。

## 关系、历史、假期和写操作补齐（2026-10-21）

- 城市编辑自动保存历史快照，支持历史列表、详情和恢复。
- 城市关联和招聘员城市关系落库，支持批量保存、查询和删除。
- 服务岗位假期支持列表、创建、编辑和删除。
- 激活配置、策略测试、设备编辑/批量开关、脚本增删改均已接入 SQLite。
- 语料库列表现在返回目标站使用的 `active_total`、`categories`、`used_count`、`last_used_at` 字段。
- 剩余业务测试和全套测试均通过。
