const role = () => localStorage.getItem("role");
const token = () => localStorage.getItem("token");

async function api(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token() || ""}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`);
  return body;
}

function addStyles() {
  if (document.getElementById("admin-enhancements-style")) return;
  const style = document.createElement("style");
  style.id = "admin-enhancements-style";
  style.textContent = `
    .admin-enhance-button{height:32px;padding:0 12px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;color:#303133;cursor:pointer;font:inherit}
    .admin-enhance-button:hover{border-color:#409eff;color:#409eff}
    .admin-ops-mask{position:fixed;inset:0;z-index:4000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(22,26,42,.48)}
    .admin-ops-modal{display:flex;flex-direction:column;width:min(980px,100%);max-height:min(820px,92vh);overflow:hidden;background:#fff;border:1px solid #e4e7ed;border-radius:6px;box-shadow:0 10px 36px rgba(0,0,0,.2);color:#303133}
    .admin-ops-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px;border-bottom:1px solid #ebeef5}
    .admin-ops-head h2{margin:0;font-size:18px;font-weight:600}
    .admin-ops-close{width:32px;height:32px;border:0;background:transparent;color:#606266;font-size:22px;cursor:pointer}
    .admin-ops-body{overflow:auto;padding:16px 20px}
    .admin-ops-table-wrap{overflow:auto;border:1px solid #ebeef5;border-radius:4px}
    .admin-ops-table{width:100%;border-collapse:collapse;font-size:13px;white-space:nowrap}
    .admin-ops-table th,.admin-ops-table td{padding:9px 10px;border-bottom:1px solid #ebeef5;text-align:left}
    .admin-ops-table th{background:#f5f7fa;color:#606266;font-weight:600}
    .admin-ops-actions{display:flex;gap:6px}
    .admin-ops-actions button{padding:5px 8px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;color:#303133;cursor:pointer}
    .admin-ops-actions button:hover{border-color:#409eff;color:#409eff}
    .admin-ops-actions button.danger{color:#c45656}
    .admin-ops-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 18px;max-width:720px}
    .admin-ops-field{display:flex;flex-direction:column;gap:6px;min-width:0}
    .admin-ops-field.wide{grid-column:1/-1}
    .admin-ops-field label{font-size:13px;color:#606266}
    .admin-ops-field input,.admin-ops-field select,.admin-ops-field textarea{box-sizing:border-box;width:100%;min-height:34px;padding:6px 9px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;color:#303133;font:inherit}
    .admin-ops-field textarea{min-height:82px;resize:vertical;font-family:ui-monospace,Consolas,monospace}
    .admin-ops-note{color:#909399;font-size:12px;line-height:1.5}
    .admin-ops-error{min-height:20px;color:#c45656;font-size:13px}
    .admin-ops-footer{display:flex;justify-content:flex-end;gap:8px;padding-top:16px}
    .admin-ops-primary{border-color:#409eff!important;background:#409eff!important;color:#fff!important}
    .admin-overview{margin:0 0 16px;padding:0}
    .admin-overview h3{margin:0 0 10px;font-size:16px;font-weight:600;color:#303133}
    .admin-overview-grid{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:10px}
    .admin-overview-card{min-height:72px;padding:12px;border:1px solid #ebeef5;border-radius:4px;background:#fff}
    .admin-overview-value{font-size:22px;font-weight:600;color:#303133}
    .admin-overview-label{margin-top:4px;color:#909399;font-size:12px}
    @media(max-width:760px){.admin-ops-mask{padding:8px}.admin-ops-modal{max-height:96vh}.admin-ops-head,.admin-ops-body{padding:12px}.admin-ops-form{grid-template-columns:1fr}.admin-ops-field.wide{grid-column:auto}.admin-overview-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  `;
  document.head.append(style);
}

function button(label, action, className = "") {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", action);
  return element;
}

function field(label, name, value, type = "text", options) {
  const wrapper = document.createElement("div");
  wrapper.className = "admin-ops-field";
  const caption = document.createElement("label");
  caption.textContent = label;
  caption.htmlFor = `admin-field-${name}`;
  const input = options ? document.createElement("select") : document.createElement("input");
  input.id = caption.htmlFor;
  input.name = name;
  if (options) {
    for (const [optionValue, optionLabel] of options) {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = optionLabel;
      input.append(option);
    }
  } else {
    input.type = type;
  }
  input.value = value ?? "";
  wrapper.append(caption, input);
  return wrapper;
}

function openUserManager() {
  addStyles();
  const mask = document.createElement("div");
  mask.className = "admin-ops-mask";
  mask.setAttribute("role", "presentation");
  const modal = document.createElement("section");
  modal.className = "admin-ops-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "admin-ops-title");
  mask.append(modal);
  document.body.append(mask);
  mask.addEventListener("click", (event) => { if (event.target === mask) mask.remove(); });

  const render = async (selectedId = null) => {
    modal.replaceChildren();
    const head = document.createElement("div");
    head.className = "admin-ops-head";
    const title = document.createElement("h2");
    title.id = "admin-ops-title";
    title.textContent = selectedId ? "编辑账号与权限" : "账号与权限";
    const close = button("×", () => mask.remove(), "admin-ops-close");
    close.setAttribute("aria-label", "关闭");
    head.append(title, close);
    const body = document.createElement("div");
    body.className = "admin-ops-body";
    body.textContent = "正在加载账号...";
    modal.append(head, body);

    try {
      const result = await api("/api/v1/auth/users?page=1&page_size=1000");
      const users = Array.isArray(result.items) ? result.items : [];
      if (selectedId === null) {
        body.replaceChildren();
        const tableWrap = document.createElement("div");
        tableWrap.className = "admin-ops-table-wrap";
        const table = document.createElement("table");
        table.className = "admin-ops-table";
        const headRow = document.createElement("tr");
        for (const label of ["用户名", "角色", "招聘员", "状态", "更新时间", "操作"]) {
          const th = document.createElement("th"); th.textContent = label; headRow.append(th);
        }
        const thead = document.createElement("thead"); thead.append(headRow);
        const tbody = document.createElement("tbody");
        for (const user of users) {
          const tr = document.createElement("tr");
          for (const value of [user.username, user.role === "admin" ? "管理员" : user.role === "recruiter" ? "招聘员" : "客户", user.recruiter_id || "-", Number(user.is_active) ? "启用" : "已停用", user.updated_at || user.created_at || "-"]) {
            const td = document.createElement("td"); td.textContent = String(value ?? "-"); tr.append(td);
          }
          const actions = document.createElement("td");
          const actionBar = document.createElement("div"); actionBar.className = "admin-ops-actions";
          actionBar.append(button("编辑", () => render(Number(user.id))));
          actionBar.append(button(Number(user.is_active) ? "停用" : "恢复", async () => {
            try {
              if (Number(user.is_active)) await api(`/api/v1/auth/users/${user.id}`, { method: "DELETE" });
              else await api(`/api/v1/auth/users/${user.id}`, { method: "PUT", body: JSON.stringify({ is_active: true }) });
              await render();
            } catch (error) { window.alert(error.message); }
          }, Number(user.is_active) ? "danger" : ""));
          actionBar.append(button("重置密码", () => renderPasswordReset(Number(user.id), user.username)));
          actions.append(actionBar); tr.append(actions); tbody.append(tr);
        }
        table.append(thead, tbody); tableWrap.append(table); body.append(tableWrap);
        if (!users.length) { const empty = document.createElement("p"); empty.textContent = "暂无账号"; body.append(empty); }
      } else {
        const user = users.find((item) => Number(item.id) === selectedId);
        if (!user) throw new Error("账号不存在");
        const scopesResult = await api(`/api/v1/auth/users/${selectedId}/scopes`);
        body.replaceChildren();
        const form = document.createElement("form"); form.className = "admin-ops-form";
        form.append(field("角色", "role", user.role, "text", [["admin", "管理员"], ["customer", "客户"], ["recruiter", "招聘员"]]));
        form.append(field("状态", "is_active", Number(user.is_active) ? "true" : "false", "text", [["true", "启用"], ["false", "停用"]]));
        form.append(field("招聘员 ID", "recruiter_id", user.recruiter_id || ""));
        form.append(field("账号类型", "recruiter_type", user.recruiter_type || "service", "text", [["factory", "普工招聘"], ["metro", "地铁安检"], ["service", "服务员"]]));
        const scopeField = document.createElement("div");
        scopeField.className = "admin-ops-field wide";
        const scopeLabel = document.createElement("label");
        scopeLabel.textContent = "数据范围";
        scopeLabel.htmlFor = "admin-field-scopes";
        const scopeInput = document.createElement("textarea");
        scopeInput.id = "admin-field-scopes";
        scopeInput.name = "scopes";
        scopeInput.value = (scopesResult.scopes || []).map((scope) => `${scope.type}:${scope.id}`).join("\n");
        scopeField.append(scopeLabel, scopeInput);
        const note = document.createElement("span"); note.className = "admin-ops-note"; note.textContent = "每行一个范围，格式为 recruiter:ID、city:ID 或 device:编码；admin 账号不受范围限制。";
        scopeField.append(note); form.append(scopeField);
        const error = document.createElement("div"); error.className = "admin-ops-error wide";
        const footer = document.createElement("div"); footer.className = "admin-ops-footer wide";
        footer.append(button("返回", () => render()));
        const save = button("保存", async () => {
          error.textContent = "";
          const values = new FormData(form);
          const scopes = String(values.get("scopes") || "").split(/[\n,]/).map((line) => line.trim()).filter(Boolean).map((line) => {
            const [type, ...parts] = line.split(":"); return { type, id: parts.join(":").trim() };
          });
          try {
            await api(`/api/v1/auth/users/${selectedId}`, { method: "PUT", body: JSON.stringify({ role: values.get("role"), is_active: values.get("is_active") === "true", recruiter_id: values.get("recruiter_id"), recruiter_type: values.get("recruiter_type") }) });
            await api(`/api/v1/auth/users/${selectedId}/scopes`, { method: "PUT", body: JSON.stringify({ scopes }) });
            await render();
          } catch (caught) { error.textContent = caught.message; }
        }, "admin-ops-primary");
        footer.append(save); form.append(error, footer); form.addEventListener("submit", (event) => event.preventDefault()); body.append(form);
      }
    } catch (error) {
      body.replaceChildren();
      const message = document.createElement("div"); message.className = "admin-ops-error"; message.textContent = error.message;
      body.append(message);
    }
  };

  const renderPasswordReset = (userId, username) => {
    modal.replaceChildren();
    const head = document.createElement("div"); head.className = "admin-ops-head";
    const title = document.createElement("h2"); title.id = "admin-ops-title"; title.textContent = `重置密码：${username}`;
    head.append(title, button("×", () => mask.remove(), "admin-ops-close"));
    const body = document.createElement("div"); body.className = "admin-ops-body";
    const form = document.createElement("form"); form.className = "admin-ops-form";
    form.append(field("新密码（至少 8 位）", "password", "", "password"));
    const error = document.createElement("div"); error.className = "admin-ops-error wide";
    const footer = document.createElement("div"); footer.className = "admin-ops-footer wide"; footer.append(button("返回", () => render(userId)));
    footer.append(button("确认重置", async () => {
      const password = form.elements.namedItem("password").value;
      try { await api(`/api/v1/auth/users/${userId}/reset-password`, { method: "POST", body: JSON.stringify({ password }) }); await render(); }
      catch (caught) { error.textContent = caught.message; }
    }, "admin-ops-primary"));
    form.append(error, footer); form.addEventListener("submit", (event) => event.preventDefault()); body.append(form); modal.append(head, body);
  };

  render();
}

async function addAdminOverview() {
  if (role() !== "admin") return;
  const dashboard = document.querySelector(".dashboard");
  if (!dashboard || dashboard.querySelector(".admin-overview")) return;
  addStyles();
  const section = document.createElement("section");
  section.className = "admin-overview";
  const heading = document.createElement("h3"); heading.textContent = "后台运营总览";
  const grid = document.createElement("div"); grid.className = "admin-overview-grid";
  section.append(heading, grid);
  const stats = dashboard.querySelector(".stats-row");
  dashboard.insertBefore(section, stats || dashboard.children[1] || null);
  try {
    const overview = await api("/api/v1/admin/overview");
    const labels = [["total_users", "系统账号"], ["active_users", "启用账号"], ["recruiters", "招聘员"], ["cities", "城市"], ["positions", "岗位"], ["devices", "坐席设备"], ["conversations", "会话"], ["pending_activations", "待处理激活"], ["retry_jobs", "重试任务"], ["dead_jobs", "失败任务"], ["rejected_webhooks", "拒绝的回调"]];
    for (const [key, label] of labels) {
      const card = document.createElement("div"); card.className = "admin-overview-card";
      const value = document.createElement("div"); value.className = "admin-overview-value"; value.textContent = String(overview[key] ?? 0);
      const caption = document.createElement("div"); caption.className = "admin-overview-label"; caption.textContent = label;
      card.append(value, caption); grid.append(card);
    }
  } catch (error) {
    const message = document.createElement("p"); message.className = "admin-ops-error"; message.textContent = `后台总览加载失败：${error.message}`; section.append(message);
  }
}

function boot() {
  if (role() !== "admin") return;
  if (location.pathname.startsWith("/users")) {
    const header = document.querySelector(".user-page .page-header");
    if (header && !header.querySelector("[data-admin-user-tools]")) {
      const tools = button("账号与权限", openUserManager, "admin-enhance-button");
      tools.dataset.adminUserTools = "true";
      header.append(tools);
    }
  }
  if (location.pathname.startsWith("/status-dashboard")) addAdminOverview();
}

const observer = new MutationObserver(boot);
observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("popstate", boot);
boot();
