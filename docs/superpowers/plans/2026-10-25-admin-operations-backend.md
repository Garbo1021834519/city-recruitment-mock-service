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

### Task 1: Add Scope And Audit Storage

**Files:**
- Create: `src/db/migrations/010_admin_scopes_audit.sql`
- Modify: `tests/db.test.ts`

**Interfaces:**
- `user_scope_assignments(user_id, scope_type, scope_id)` supports `recruiter`, `city`, and `device` scopes with a unique assignment key.
- `admin_audit_logs(actor_user_id, action, resource_type, resource_id, summary_json, created_at)` records redacted administrative actions.

- [ ] Add a migration test asserting both tables, unique scope assignments, and cascading cleanup when a login user is removed.
- [ ] Run `npm test -- tests/db.test.ts`; expect the new table assertions to fail before migration exists.
- [ ] Add migration `010_admin_scopes_audit.sql` with foreign-keyed user assignments and audit rows. Audit actor IDs remain nullable so retained history survives account removal.
- [ ] Run `npm test -- tests/db.test.ts`; expect all database migration tests to pass.
- [ ] Commit as `feat: add admin scope and audit tables`.

### Task 2: Implement Admin Account Lifecycle

**Files:**
- Modify: `src/auth/auth.routes.ts`
- Create: `src/auth/admin-users.ts`
- Modify: `public/assets/UserView-DRk-CQqE.js`
- Modify: `tests/admin-users.test.ts`

**Interfaces:**
- `listAdminUsers(db, query)` supports `search`, `role`, `is_active`, `page`, and `page_size`, while the default response remains `{items,total}`.
- `replaceUserScopes(db, userId, scopes)` validates and transactionally replaces the recruiter, city, and device assignments.
- Admin routes: `PUT /api/v1/auth/users/:id`, `POST /api/v1/auth/users/:id/reset-password`, and `PUT /api/v1/auth/users/:id/scopes`.
- Existing `POST /api/v1/auth/users` and `DELETE /api/v1/auth/users/:id` remain compatible; DELETE continues to soft-disable.

- [ ] Add route tests for role/recruiter fields being saved, list filters, editing account fields, replacing scopes, password reset invalidating the old password, and updated password allowing login.
- [ ] Add negative tests for non-admin writes, missing recruiter references, invalid scope types/IDs, self-disable, and disabling the last active admin.
- [ ] Run `npm test -- tests/admin-users.test.ts`; expect missing update/reset/scope behavior to fail before implementation.
- [ ] Implement an admin-only service with transaction boundaries and scrypt password hashing. Keep recruiter and customer login users linked to valid recruiter records when `recruiter_id` is supplied.
- [ ] Write an audit row for create, update, reset, scope replacement, and disable; include only changed field names and assignment counts.
- [ ] Extend the existing admin user table actions to edit account role/association, show active state, reactivate a disabled user, and reset a password through the new endpoints. Keep the captured page and existing component layout.
- [ ] Run `npm test -- tests/admin-users.test.ts tests/auth.test.ts tests/permissions.test.ts`; expect all account and role tests to pass.
- [ ] Open `/users` as `local-admin` in Playwright and verify create, edit, disable/reactivate, reset, role counts, and error feedback against the local API.
- [ ] Commit as `feat: add admin account lifecycle and scopes`.

### Task 3: Enforce Business Scopes

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

- [ ] Add tests proving admin sees all cities/devices/conversations; recruiter and customer see only assigned records; an unassigned record is not readable by guessed ID.
- [ ] Run `npm test -- tests/user-scopes.test.ts`; expect cross-scope reads to fail before filtering exists.
- [ ] Implement the scope resolver using parameterized SQLite queries and the authenticated user's current database record.
- [ ] Apply it to city/factory/position lists and details, recruiter/resource lists, agent devices/conversations/messages/candidates/old-friends, and activation records/customer details.
- [ ] Seed explicit scopes for local demo accounts without widening them to all business records.
- [ ] Run scope, core, relations, resources, agent, activation, parity, and permission tests; expect no response-contract changes for admin or unauthorized-role behavior.
- [ ] Commit as `feat: enforce user business scopes`.

### Task 4: Repair Conversation Demo Flow

**Files:**
- Modify: `src/db/seed.ts`
- Modify: `src/modules/agent/agent.routes.ts`
- Modify: `tests/agent-conversations.test.ts`
- Modify: `public/assets/ConversationView-o6v-Nk0t.js` only if the browser test proves its error state conflates failures with empty results.

**Interfaces:**
- Seed device code: `local-device-001`.
- Fictional conversation fixture: customer ID `700001`, device `local-device-001`, with one inbound and one outbound message.
- Existing `GET /api/v1/agent/devices?my=true`, `/agent/conversations`, and `/agent/messages` response shapes remain unchanged.

- [ ] Add tests for a non-empty device code, conversation retrieval by device, matching message retrieval, and no cross-device leakage.
- [ ] Run `npm test -- tests/agent-conversations.test.ts`; expect the missing seeded conversation to fail before the fixture is added.
- [ ] Update the demo device's `data_json` only when its device code is empty; add conversation/messages with `INSERT OR IGNORE` so reseeding is safe.
- [ ] Add API error handling assertions; use Playwright to confirm successful list, real empty list, and 422/500 failure are distinguishable in the UI. Patch the built view only if the browser test confirms a failure-state bug and keep the edit narrowly scoped.
- [ ] Run `npm test -- tests/agent-conversations.test.ts tests/db.test.ts` and repeat the `/conversations` browser flow; expect 200 and the fictional conversation to render.
- [ ] Commit as `fix: seed a usable local conversation flow`.

### Task 5: Add Admin Overview

**Files:**
- Create: `src/modules/admin/admin.routes.ts`
- Modify: `src/server.ts`
- Modify: `public/assets/StatusDashboardView-CI6rL9RZ.js`
- Modify: `tests/admin-overview.test.ts`

**Interfaces:**
- `GET /api/v1/admin/overview` is admin-only and returns counts for users by role/status, recruiters, cities, positions, devices, conversations, pending activation records, retry/dead jobs, and rejected webhooks.
- The route returns aggregate counts only; it does not return candidate or message content.

- [ ] Add tests that create a small fixture set and assert exact counts, admin-only authorization, zero-valued empty sections, and absence of raw message/candidate fields.
- [ ] Run `npm test -- tests/admin-overview.test.ts`; expect route-not-found or permission assertions to fail before registration.
- [ ] Implement the aggregate queries and register the admin route.
- [ ] Connect the overview to the existing admin monitoring surface; keep `/api/v1/agent/status/dashboard` unchanged for the captured customer response contract.
- [ ] Run `npm test -- tests/admin-overview.test.ts tests/permissions.test.ts tests/response-serializers.test.ts` and verify the admin page in Playwright.
- [ ] Commit as `feat: add global admin operations overview`.

### Task 6: Verify And Push

**Files:**
- Modify: `docs/verification.md`
- Modify: `docs/superpowers/plans/2026-10-25-admin-operations-backend.md`

- [ ] Run `npm run build`.
- [ ] Run `npm test -- --maxWorkers=1 --minWorkers=1`.
- [ ] Log in as `local-admin`, create and edit a scoped recruiter account, verify its access, disable it, and verify it cannot log in or use its prior token.
- [ ] Run the authenticated read-only parity probe and confirm the existing customer response contract remains stable.
- [ ] Update verification notes with observed outcomes and limits; mark each completed plan checkbox only after its evidence passes.
- [ ] Review `git diff --check`, stage only files changed for this feature, and commit as `feat: build multi-user admin operations backend`.
- [ ] Push the current branch to its configured remote and record the pushed commit ID.
