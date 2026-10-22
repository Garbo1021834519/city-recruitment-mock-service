# 城市招聘配置管理 1:1 还原实施计划

> **给执行代理：**按任务顺序执行本计划；每个任务完成后运行该任务的验证命令，再进入下一任务。

**目标：** 在 `C:\CODE\城市招聘配置还原` 建立可启动的本地城市招聘配置管理系统，复现目标站点已观测的全部角色、路由、页面行为、API 契约、数据操作和导入导出流程。

**架构：** 复用目标站点的 Vue 构建资源作为前端，使用 Fastify 提供 `/api/v1` 兼容接口，使用 SQLite 保存业务数据，使用 JWT 和角色权限控制访问。REA 场景负责对目标站点和本地站点执行同样的路径、表单、筛选、分页和状态操作，并比较 URL、DOM、请求和响应形状。

**技术栈：** Node.js 22、TypeScript、Fastify、`@fastify/static`、`@fastify/multipart`、`node:sqlite`、`jsonwebtoken`、Vitest、REA 6.7.0。

## 全局约束

- 项目根目录固定为 `C:\CODE\城市招聘配置还原`。
- 原始抓包、下载脚本、临时响应和实验数据放在 `过程文件`；用户可运行的源代码、数据库迁移、静态资源和文档放在项目根目录的对应目录。
- 不保存明文密码、Cookie、JWT、Authorization 头或完整敏感响应；场景使用环境变量 secret 并在落盘证据中脱敏。
- API 前缀保持 `/api/v1`；错误对象保持 `detail` 字段；分页和筛选参数保留原始名字。
- 认证角色至少包含 `admin`、`customer`、`recruiter`；路由守卫与目标站点的静态条件一致。
- 每个任务必须有可重复的验证命令；未被实时证据证明的后端规则记录为 unknown，不用猜测填充。
- 不对目标站点执行删除、批量导入、状态切换或其他写操作；这些操作只在本地 SQLite 验证。

## 文件结构

计划完成后的主要结构如下：

```text
C:\CODE\城市招聘配置还原
├─ package.json
├─ tsconfig.json
├─ src/
│  ├─ server.ts
│  ├─ config.ts
│  ├─ auth/
│  │  ├─ auth.routes.ts
│  │  ├─ auth.service.ts
│  │  └─ rbac.ts
│  ├─ db/
│  │  ├─ connection.ts
│  │  ├─ migrate.ts
│  │  ├─ seed.ts
│  │  └─ migrations/001_init.sql
│  ├─ modules/
│  │  ├─ cities/
│  │  ├─ factories/
│  │  ├─ service-positions/
│  │  ├─ scheduling/
│  │  ├─ recruiters/
│  │  ├─ knowledge/
│  │  ├─ operations/
│  │  └─ activation/
│  └─ shared/
├─ public/
│  ├─ index.html
│  └─ assets/
├─ scripts/
│  ├─ collect-site-assets.mjs
│  ├─ extract-contracts.mjs
│  └─ run-scenario.mjs
├─ tests/
│  ├─ auth.test.ts
│  ├─ core-modules.test.ts
│  ├─ module-contracts.test.ts
│  └─ smoke.test.ts
├─ docs/superpowers/specs/
├─ docs/superpowers/plans/
└─ 过程文件/
```

### Task 1: 建立项目骨架和可重复工具链

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/config.ts`
- Create: `scripts/collect-site-assets.mjs`
- Create: `scripts/extract-contracts.mjs`
- Create: `过程文件/asset-manifest.json`
- Create: `过程文件/route-manifest.json`

**Interfaces:**

- `npm run dev` starts the local server through `tsx src/server.ts`.
- `npm run migrate` creates or upgrades `data/app.sqlite`.
- `npm run seed` inserts idempotent fixtures.
- `npm test` runs Vitest.
- `node scripts/collect-site-assets.mjs --origin http://47.107.245.246:8080` downloads only public HTML, JS, CSS and image/font resources into `过程文件/raw-assets` and writes SHA-256 metadata.
- `node scripts/extract-contracts.mjs` reads the downloaded bundles and writes route/API manifests without executing site code.

**Steps:**

- [ ] Create `package.json` with scripts `dev`, `build`, `start`, `migrate`, `seed`, `test`, `verify` and dependencies pinned to Node 22 compatible versions.
- [ ] Create `tsconfig.json` with `strict: true`, ESM output and source maps.
- [ ] Implement `collect-site-assets.mjs` with an allowlist for the target origin, a fixed `过程文件/raw-assets` output directory, SHA-256 hashing, and no credential-bearing URLs.
- [ ] Implement `extract-contracts.mjs` to parse the known `const Kee=[...]` route block, enumerate lazy chunks, detect `/api/v1/` strings, HTTP method calls, `FormData.append` names and `responseType` declarations, and emit JSON with source file and byte offsets.
- [ ] Run `npm install`, then run both scripts and confirm that the manifest contains 38 routes and the downloaded root bundle hash.

**Validation:**

```powershell
npm install
npm run test -- --runInBand
node scripts/collect-site-assets.mjs --origin http://47.107.245.246:8080
node scripts/extract-contracts.mjs
node -e "const x=require('./过程文件/route-manifest.json'); if(x.routes.length!==38) process.exit(1)"
```

Expected: the route manifest reports 38 routes, asset entries have URL/status/bytes/SHA-256, and no manifest value matches the supplied password or a JWT pattern.

### Task 2: SQLite schema, migrations, seed data, and shared query helpers

**Files:**

- Create: `src/db/connection.ts`
- Create: `src/db/migrate.ts`
- Create: `src/db/seed.ts`
- Create: `src/db/migrations/001_init.sql`
- Create: `src/shared/pagination.ts`
- Create: `src/shared/http-errors.ts`
- Test: `tests/db.test.ts`

**Interfaces:**

- `openDatabase(filename?: string): DatabaseSync` opens the configured database and enables foreign keys.
- `migrateDatabase(db): void` applies numbered migrations once.
- `seedDatabase(db): void` is idempotent and creates admin/customer/recruiter fixtures plus representative cities, factories, positions, knowledge records and operational records.
- `parsePagination(query): { page: number; pageSize: number; offset: number }` accepts `page`, `page_size`, `pageSize` only where the observed contract requires them.
- `httpError(status, detail): Error` produces Fastify errors with the target-compatible `detail` field.

**Steps:**

- [ ] Define tables for users, roles, cities, factories, service positions, holiday schedules, city links, recruiters, settings, knowledge items, unknown questions, agent devices, conversations, candidates, agent rules, agent evaluations, old friends, status records, activation strategies, activation devices and activation scripts.
- [ ] Add `created_at`, `updated_at`, soft status fields and JSON extension columns where the frontend references fields that are not yet fully observed.
- [ ] Add foreign keys and indexes for every list filter and relation used by the route chunks.
- [ ] Implement migrations and seed data with `INSERT ... ON CONFLICT` so repeated `npm run seed` does not duplicate rows.
- [ ] Add tests for fresh migration, repeated migration, repeated seed, foreign-key rejection and pagination boundaries.

**Validation:**

```powershell
npm run migrate
npm run seed
npm test -- tests/db.test.ts
```

Expected: migration and seed are idempotent; a fresh database contains at least one fixture for every module family.

### Task 3: Authentication, JWT, and role based access

**Files:**

- Create: `src/auth/auth.service.ts`
- Create: `src/auth/auth.routes.ts`
- Create: `src/auth/rbac.ts`
- Modify: `src/server.ts`
- Test: `tests/auth.test.ts`

**Interfaces:**

- `POST /api/v1/auth/login` accepts `{ username, password }` and returns `{ access_token, token_type: "bearer" }`.
- `GET /api/v1/auth/me` returns `{ username, role, recruiter_id, recruiter_type }`.
- `requireAuth(request, reply): Promise<AuthContext>` rejects missing or invalid tokens with 401 and `detail`.
- `requireRole(...roles): preHandler` rejects authenticated users with the wrong role using 403 and `detail`.
- `POST /api/v1/auth/logout` clears only local client state when the route exists in the extracted contract; the server remains stateless.

**Steps:**

- [ ] Hash seeded passwords with a one-way password hash and keep fixture credentials in a local seed configuration file excluded from evidence output.
- [ ] Implement JWT signing with a local development secret from `REA_LOCAL_JWT_SECRET`, refusing to start when the secret is absent in production mode.
- [ ] Implement login validation and `/auth/me` fields exactly as observed, including fallback role behavior only when the target code demonstrates it.
- [ ] Implement role mapping for route groups: recruiter is restricted to conversations and recruiter-featured routes; customer and admin retain their observed default routes.
- [ ] Add tests for success, bad password, missing token, expired token, role mismatch and `/auth/me` shape.

**Validation:**

```powershell
$env:REA_LOCAL_JWT_SECRET='local-test-secret'
npm test -- tests/auth.test.ts
```

Expected: auth tests pass and test output never prints a password or JWT.

### Task 4: Public static service and original route shell

**Files:**

- Create: `src/static/static.routes.ts`
- Create: `public/index.html`
- Copy: `过程文件/raw-assets/*` to `public/assets/`
- Modify: `src/server.ts`
- Test: `tests/smoke.test.ts`

**Interfaces:**

- `GET /` and every public route return the original `index.html`.
- `/assets/*` serves the captured JS/CSS/font/image files with correct MIME types.
- `/api/*` is handled by Fastify routes and never falls through to the SPA shell.

**Steps:**

- [ ] Copy only verified public assets from the asset manifest into `public/assets`.
- [ ] Create `index.html` referencing the local hashed root bundle and stylesheet.
- [ ] Add SPA fallback for all 38 route paths while preserving `/api` and `/assets` boundaries.
- [ ] Introduce one `API_BASE_URL` replacement point in the root bundle or a local reverse proxy so the copied chunks use the local API origin.
- [ ] Add smoke tests for `/login`, `/cities`, `/m`, one parameterized route, `/assets/index-*.js` and an unknown API path.

**Validation:**

```powershell
npm run build
npm run dev
npm test -- tests/smoke.test.ts
```

Expected: the local site loads the original login markup and each declared route resolves to the SPA shell.

### Task 5: Core modules: cities, factories, and service positions

**Files:**

- Create: `src/modules/cities/cities.routes.ts`
- Create: `src/modules/cities/cities.service.ts`
- Create: `src/modules/factories/factories.routes.ts`
- Create: `src/modules/factories/factories.service.ts`
- Create: `src/modules/service-positions/service-positions.routes.ts`
- Create: `src/modules/service-positions/service-positions.service.ts`
- Test: `tests/core-modules.test.ts`

**Interfaces:**

- Cities: `GET/POST /api/v1/cities`, `GET/PUT/DELETE /api/v1/cities/:id`, `PATCH /api/v1/cities/:id/status`, plus any exact import/export endpoints found by Task 1.
- Factories: matching list/detail/create/update/delete/status routes discovered from the factory chunks.
- Service positions: `GET/POST /api/v1/service-positions`, `GET/PUT/DELETE /api/v1/service-positions/:id`, toggle-featured/status routes discovered from the service position chunk.
- List responses preserve target collection keys, total counts, page fields and empty-result behavior.

**Steps:**

- [ ] Use the extracted contracts to write route-level tests before implementation for list, detail, create, update, delete and status transitions.
- [ ] Implement service methods with explicit allowed fields, stable ordering and target-compatible validation errors.
- [ ] Implement duplicate/clone operations only where the target chunk calls a dedicated endpoint or sends a distinct request body.
- [ ] Implement local-only destructive operations inside a transaction and return the observed success status/body.
- [ ] Verify the three modules against the local frontend using the original route chunks.

**Validation:**

```powershell
npm test -- tests/core-modules.test.ts
npm run verify -- --routes cities,cities/create,factories,service-positions
```

Expected: list filters, pagination, create/edit forms, clone, delete and status controls work against SQLite.

### Task 6: Configuration modules

**Files:**

- Create: `src/modules/scheduling/scheduling.routes.ts`
- Create: `src/modules/recruiters/recruiters.routes.ts`
- Create: `src/modules/knowledge/knowledge.routes.ts`
- Create: `src/modules/configuration/configuration.service.ts`
- Test: `tests/module-contracts.test.ts`

**Scope:** holiday schedules, city links, recruiters, settings, knowledge, unknown questions and import/export helpers.

**Steps:**

- [ ] Extract every endpoint and request field from the corresponding chunks before writing handlers.
- [ ] Implement list/detail/create/update/delete/status routes with table-specific schemas.
- [ ] Implement settings read/write with an allowlist so unknown keys are retained in the JSON extension column.
- [ ] Implement knowledge and unknown-question content fields, search and status transitions.
- [ ] Implement multipart imports and generated exports only on the local server; enforce file size/type limits and return deterministic test fixtures.
- [ ] Add contract tests for each extracted endpoint and one end-to-end scenario per route family.

**Validation:**

```powershell
npm test -- tests/module-contracts.test.ts
npm run verify -- --routes holiday-schedules,city-links,recruiters,settings,knowledge,unknown-questions
```

Expected: every declared configuration route has a handler and a test; unsupported fields fail with a useful `detail` message.

### Task 7: Operations and activation modules

**Files:**

- Create: `src/modules/operations/operations.routes.ts`
- Create: `src/modules/operations/operations.service.ts`
- Create: `src/modules/activation/activation.routes.ts`
- Create: `src/modules/activation/activation.service.ts`
- Test: `tests/operations.test.ts`

**Scope:** users, agent devices, conversations, candidates, agent rules, agent evaluations, old friends, status dashboard, activation dashboard/today/customer/strategies/devices/scripts and recruiter-featured.

**Steps:**

- [ ] Extract request/response shapes for all route chunks, including nested customer IDs and device/script parameters.
- [ ] Implement read-only dashboard aggregates first, then list/detail operations, then local mutation operations.
- [ ] Implement recruiter-only access to conversations and recruiter-featured using the same guard conditions as the root bundle.
- [ ] Implement activation route relationships and deterministic seed states so dashboard counts match local fixture data.
- [ ] Add tests for dashboard aggregates, role restrictions, nested customer lookup and list filters.

**Validation:**

```powershell
npm test -- tests/operations.test.ts
npm run verify -- --routes users,agent-devices,conversations,candidates,agent-rules,agent-evaluations,old-friends,status-dashboard,activation,recruiter-featured
```

Expected: all operations routes respond with schema-valid JSON and role checks match the declared route guard behavior.

### Task 8: Mobile route and cross-module frontend behavior

**Files:**

- Modify: `src/static/static.routes.ts`
- Create: `tests/mobile.test.ts`
- Create: `过程文件/local-scenarios/*.json`

**Steps:**

- [ ] Verify `/m` and `/account-summary` with the captured public route chunks and required API calls.
- [ ] Add mobile-specific API fixtures and ensure the mobile route does not inherit desktop-only redirects.
- [ ] Verify login redirect behavior for each role, including recruiter default `/conversations`, service default `/service-positions`, and customer/admin default `/cities` where proven.
- [ ] Add scenarios for logout, 401 handling, expired token and direct navigation to protected routes.

**Validation:**

```powershell
npm test -- tests/mobile.test.ts
npm run verify -- --routes /m,/account-summary
```

Expected: mobile and account summary pages load, protected navigation and role redirects match the target evidence.

### Task 9: REA differential verification and completion report

**Files:**

- Create: `scripts/run-scenario.mjs`
- Create: `scripts/compare-evidence.mjs`
- Create: `过程文件/comparisons/README.md`
- Create: `docs/verification.md`
- Modify: `package.json`

**Interfaces:**

- `npm run verify -- --origin <url> --scenario <file>` runs a REA browser scenario and stores sanitized evidence.
- `node scripts/compare-evidence.mjs <target.json> <local.json>` compares normalized URL, accessibility, DOM text, network method/path/status and selected JSON shapes.
- `npm run verify:routes` checks every route in `route-manifest.json` returns a successful document or a proven auth redirect.

**Steps:**

- [ ] Build one read-only scenario per route family with no target-side writes.
- [ ] Add secret declarations for credentials and verify all output is free of password, JWT, Cookie and Authorization values.
- [ ] Normalize dynamic timestamps, IDs and token values only through explicit rules recorded in the comparison file.
- [ ] Produce a difference report grouped by route, API contract, role and evidence level.
- [ ] Mark each feature as `verified`, `partial` or `unknown` with source evidence and reproduction command.
- [ ] Run the full test suite and local smoke server before claiming completion.

**Validation:**

```powershell
npm test
npm run build
npm run verify:routes
npm run verify -- --scenario 过程文件/local-scenarios/customer-readonly.json
```

Expected: all implemented routes pass smoke checks; comparison reports identify remaining differences instead of silently passing.

## Completion criteria

- `npm run dev` starts a local site and API without external services.
- All 38 routes resolve and all extracted `/api/v1` endpoints have either a compatible handler or a documented `unknown` entry.
- Three roles authenticate and receive the same redirect/permission behavior proven from the target bundle.
- SQLite migrations and seeds are repeatable.
- Core CRUD, filtering, pagination, status changes and local import/export flows work.
- REA scenarios produce sanitized evidence and a difference report.
- `docs/verification.md` states which behavior is verified, partial or unknown.


