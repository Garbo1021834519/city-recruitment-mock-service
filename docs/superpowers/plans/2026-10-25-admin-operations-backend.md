# Admin Operations Backend Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in the current authorized workspace. Use test-first changes and keep user-generated artifacts unstaged.

**Goal:** Make the existing application a multi-user operations system with working admin account lifecycle, explicit business scopes, a functional admin overview, and a conversation flow that loads from stable demo device data.

**Architecture:** Keep Fastify, SQLite, the captured Vue routes, and the existing `/api/v1` contracts. Add normalized user scope and audit tables, resolve scope from the authenticated user, and filter business reads at their route boundary; admin remains global. Preserve the existing user-management UI contract while making its current recruiter fields persist and adding only compatible endpoints needed for administration.

**Tech Stack:** Node.js 22 `node:sqlite`, TypeScript, Fastify 5, Vue production assets already in `public/assets`, Vitest, Playwright CLI.

## Global Constraints

- Use the existing `admin`, `customer`, and `recruiter` role values.
- Keep conversation customers separate from login accounts.
- Never return password hashes, passwords, JWTs, Dify keys, or message bodies in audit summaries.
- Admin reads are global; non-admin business reads must be restricted to explicit user scopes.
- Seed data is fictional and idempotent; do not write to the target service.
- Preserve existing API envelopes and the captured customer-facing response shapes.
- Do not stage or commit existing generated assets or parity artifacts unless a changed source explicitly requires them.

---

### Task 1: Add Scope And Audit Storage [Completed]

**Files:**
- Create: `src/db/migrations/010_admin_scopes_audit.sql`
- Modify: `tests/db.test.ts`

**Interfaces:**
- `user_scope_assignments(user_id, scope_type, scope_id)` supports `recruiter`, `city`, and `device` scopes with a unique assignment key.
- `admin_audit_logs(actor_user_id, action, resource_type, resource_id, summary_json, created_at)` records redacted administrative actions.

- [x] Add a migration test asserting both tables, unique scope assignments, and cascading cleanup when a login user is removed.
- [x] Run `npm test -- tests/db.test.ts`; it failed on missing tables before the migration existed.
- [x] Add migration `010_admin_scopes_audit.sql` with foreign-keyed user assignments and audit rows. Audit actor IDs remain nullable so retained history survives account removal.
- [x] Run `npm test -- tests/db.test.ts`; all 3 database tests passed.
- [x] Commit as `feat: add admin scope and audit tables`.

### Task 2: Implement Admin Account Lifecycle [Completed]

**Files:**
- Modify: `src/auth/auth.routes.ts`
- Create: `src/auth/admin-users.ts`
- Modify: `public/index.html`
- Create: `public/admin-enhancements.js`
- Modify: `tests/admin-users.test.ts`

**Interfaces:**
- `listAdminUsers(db, query)` supports `search`, `role`, `is_active`, `page`, and `page_size`, while the default response remains `{items,total}`.
- `replaceUserScopes(db, userId, scopes)` validates and transactionally replaces the recruiter, city, and device assignments.
- Admin routes: `PUT /api/v1/auth/users/:id`, `POST /api/v1/auth/users/:id/reset-password`, and `PUT /api/v1/auth/users/:id/scopes`.
- Existing `POST /api/v1/auth/users` and `DELETE /api/v1/auth/users/:id` remain compatible; DELETE continues to soft-disable.

- [x] Add route tests for role/recruiter fields being saved, list filters, editing account fields, replacing scopes, password reset invalidating the old password, and updated password allowing login.
- [x] Add negative tests for non-admin writes, missing recruiter references, invalid scope types/IDs, self-disable, and disabling the last active admin.
- [x] Run `npm test -- tests/admin-users.test.ts`; it failed before the new routes and passed after implementation.
- [x] Implement an admin-only service with transaction boundaries and scrypt password hashing. Keep recruiter and customer login users linked to valid recruiter records when `recruiter_id` is supplied.
- [x] Write an audit row for create, update, reset, scope replacement, and disable; include only changed field names and assignment counts.
- [x] Add an admin-only enhancement module to the existing `/users` page for account role/association editing, active state, reactivate, scope assignments, and password reset. Keep the captured page and existing component layout.
- [x] Run `npm test -- tests/admin-users.test.ts tests/auth.test.ts tests/permissions.test.ts`; 8 tests passed.
- [x] Open `/users` as `local-admin` in Playwright and verify create, edit, disable/reactivate, reset, role counts, and error feedback against the local API.
- [x] Commit as `feat: add admin account lifecycle and scopes`.

### Task 3: Enforce Business Scopes [Completed]

**Files:**
- Create: `src/auth/user-scopes.ts`
- Modify: `src/modules/core/core.routes.ts`
- Modify: `src/modules/agent/agent.routes.ts`
- Modify: `src/modules/activation/activation.routes.ts`
- Modify: `src/modules/relations/relations.routes.ts`
- Modify: `tests/user-scopes.test.ts`

**Interfaces:**
- `getUserScope(db, auth)` returns `{isAdmin, recruiterIds, cityIds, deviceCodes}`.
- `scopeAllowsDevice(db, scope, deviceCode)` checks explicit device grants or recruiter-derived device ownership.
- `scopeAllowsCity(scope, cityId)` checks explicit city grants or recruiter-city grants.
- Admin routes bypass filtering. Non-admin list and detail reads return only assigned resources; inaccessible details use the route's existing not-found semantics.

- [x] Add tests proving admin sees all cities/devices/conversations; recruiter and customer see only assigned records; an unassigned record is not readable by guessed ID.
- [x] Run `npm test -- tests/user-scopes.test.ts`; it failed before filtering and passed after implementation.
- [x] Implement the scope resolver using parameterized SQLite queries and the authenticated user's current database record.
- [x] Apply it to city/factory/position lists and details, recruiter/resource lists, agent devices/conversations/messages/candidates/old-friends, and activation records/customer details.
- [x] Seed explicit scopes for local demo accounts without widening them to all business records.
- [x] Run scope, core, relations, resources, agent, activation, and permission tests; 13 focused tests passed and the build passed.
- [x] Commit as `feat: enforce user business scopes`.

### Task 4: Repair Conversation Demo Flow [Completed]

**Files:**
- Modify: `src/db/seed.ts`
- Modify: `src/modules/agent/agent.routes.ts`
- Modify: `tests/agent-conversations.test.ts`
- Modify: `public/assets/ConversationView-o6v-Nk0t.js` only if the browser test proves its error state conflates failures with empty results.

**Interfaces:**
- Seed device code: `local-device-001`.
- Fictional conversation fixture: customer ID `700001`, device `local-device-001`, with one inbound and one outbound message.
- Existing `GET /api/v1/agent/devices?my=true`, `/agent/conversations`, and `/agent/messages` response shapes remain unchanged.

- [x] Add tests for a non-empty device code, conversation retrieval by device, matching message retrieval, and no cross-device leakage.
- [x] Run `npm test -- tests/agent-conversations.test.ts`; the missing fixture failed first, then the 2 tests passed after seeding.
- [x] Update the demo device's `data_json` only when its device code is empty; add conversation/messages with `INSERT OR IGNORE` so reseeding is safe.
- [x] Add API error handling assertions; Playwright confirmed successful list and message thread, while missing device code remains a 422 contract response.
- [x] Run `npm test -- tests/agent-conversations.test.ts tests/db.test.ts` and repeat the `/conversations` browser flow; 200 and the fictional conversation rendered.
- [x] Commit as `fix: seed a usable local conversation flow`.

### Task 5: Add Admin Overview [Completed]

**Files:**
- Create: `src/modules/admin/admin.routes.ts`
- Modify: `src/server.ts`
- Modify: `public/admin-enhancements.js`
- Modify: `tests/admin-overview.test.ts`

**Interfaces:**
- `GET /api/v1/admin/overview` is admin-only and returns counts for users by role/status, recruiters, cities, positions, devices, conversations, pending activation records, retry/dead jobs, and rejected webhooks.
- The route returns aggregate counts only; it does not return candidate or message content.

- [x] Add tests that create a small fixture set and assert exact counts, admin-only authorization, zero-valued empty sections, and absence of raw message/candidate fields.
- [x] Run `npm test -- tests/admin-overview.test.ts`; the route failed with 404 before registration, then the 2 tests passed.
- [x] Implement the aggregate queries and register the admin route.
- [x] Connect the overview cards to the existing admin monitoring surface through the enhancement module; `/api/v1/agent/status/dashboard` remains unchanged for the captured customer response contract.
- [x] Run `npm test -- tests/admin-overview.test.ts tests/permissions.test.ts tests/response-serializers.test.ts`; 13 tests passed and Playwright showed the cards.
- [x] Commit as `feat: add global admin operations overview`.

### Task 6: Verify And Push [Completed]

**Files:**
- Modify: `docs/verification.md`
- Modify: `docs/superpowers/plans/2026-10-25-admin-operations-backend.md`

- [x] Run `npm run build`.
- [x] Run `npm test -- --maxWorkers=1 --minWorkers=1`; 24 test files and 95 tests passed.
- [x] Log in as `local-admin`, create and edit a scoped recruiter account, verify its access, disable it, and verify it cannot log in or use its prior token; Playwright verified reset, 401 for the old token, reactivation, and the admin overview cards.
- [x] Run the authenticated read-only parity probe and confirm the existing customer response contract remains stable; Phase 7 reported 45 `verified`, 16 `data-dependent`, 0 `partial`, and 0 `target-internal-failure`.
- [x] Update verification notes with observed outcomes and limits; mark each completed plan checkbox only after its evidence passes.
- [x] Review `git diff --check`, stage only files changed for this feature, and commit as `feat: build multi-user admin operations backend` (`5bb181a`).
- [x] Push the current branch to its configured remote; `5bb181a` is on `origin/main`.
