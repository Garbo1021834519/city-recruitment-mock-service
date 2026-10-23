# Response Serializers Implementation Plan

> **For agentic workers:** Execute the tasks in order. Each task ends with a focused test; do not start Phase 2 until the Phase 1 gate passes.

**Goal:** Replace direct database row spreading with explicit public response serializers and remove all code-fixable customer parity field differences.

**Architecture:** Add pure serializer functions in `src/shared/response-serializers.ts`. Route handlers keep SQL and state changes, then pass rows or aggregate objects through serializers. Tests exercise serializers directly and run representative HTTP responses through `buildServer()`.

**Tech Stack:** TypeScript, Node `node:sqlite`, Fastify, Vitest.

## Global Constraints

- Keep public paths and request contracts unchanged.
- Never expose `data_json` or other storage-only fields.
- Use deterministic empty values matching target shape: `[]`, `{}`, `null`, or `""` as recorded by parity evidence.
- Keep fixture data separate from response shape logic.

### Task 1: Define serializer contracts

**Files:**
- Create: `src/shared/response-serializers.ts`
- Create: `tests/response-serializers.test.ts`

**Interfaces:**
- `serializeCity(row): Record<string, unknown>`
- `serializeFactory(row): Record<string, unknown>`
- `serializeServicePosition(row): Record<string, unknown>`
- `serializeRecruiter(row): Record<string, unknown>`
- `serializeCandidate(row): Record<string, unknown>`
- `serializeAgentDevice(row): Record<string, unknown>`
- `serializeCityLinks(value): Record<string, unknown>`
- `serializeEvaluationOverview(value): Record<string, unknown>`
- `serializeMetrics(value): Record<string, unknown>`
- `serializeStatusDashboard(value): Record<string, unknown>`

- [ ] Write failing tests for storage-field removal, aliases, defaults, null normalization, and stable arrays.
- [ ] Run `npx vitest run tests/response-serializers.test.ts`; expect failure because the module does not exist.
- [ ] Implement pure functions with explicit field allowlists.
- [ ] Run the focused test; expect all serializer tests to pass.

### Task 2: Wire core and resource routes

**Files:**
- Modify: `src/modules/core/core.routes.ts`
- Modify: `src/modules/resources/resource.routes.ts`
- Modify: `src/modules/agent/agent.routes.ts`
- Modify: `src/modules/relations/relations.routes.ts`

- [ ] Add HTTP tests for cities, factories, service positions, recruiters, candidates, devices, city links, evaluation, metrics and status dashboard.
- [ ] Replace `output()` and direct row returns with the named serializers.
- [ ] Ensure collection envelopes remain unchanged (`items`, `total`, and target-specific keys).
- [ ] Run `npm test -- tests/response-serializers.test.ts tests/core-modules.test.ts tests/remaining-business.test.ts`.

### Task 3: Normalize known dynamic fields

**Files:**
- Modify: `src/shared/response-serializers.ts`
- Modify: `tests/response-serializers.test.ts`
- Modify: `过程文件/parity/target-list-items.json` only if the evidence schema needs a documented normalization rule.

- [ ] Normalize device `last_online`/`last_offline` to `null` when absent and `queue_stale` to boolean.
- [ ] Normalize service position boolean/array fields.
- [ ] Normalize recruiter public aliases and city list.
- [ ] Run the focused tests and the customer probe.

### Task 4: Phase 1 verification gate

**Files:**
- Modify: `docs/verification.md`
- Modify: `过程文件/当前进度.md`

- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `node 过程文件/parity/probe-unauthenticated.mjs` against the local service.
- [ ] Run the authenticated probe with credentials supplied through environment variables.
- [ ] Record remaining differences as data-dependent or target-internal failures.
- [ ] Mark Phase 1 `verified` only if no serializer-owned field differences remain.

