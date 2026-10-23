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

- [x] Write failing tests for storage-field removal, aliases, defaults, null normalization, and stable arrays.
- [x] Run `npx vitest run tests/response-serializers.test.ts`; the first run failed because the module did not exist.
- [x] Implement pure functions with explicit field allowlists.
- [x] Run the focused test; serializer tests pass.

### Task 2: Wire core and resource routes

**Files:**
- Modify: `src/modules/core/core.routes.ts`
- Modify: `src/modules/resources/resource.routes.ts`
- Modify: `src/modules/agent/agent.routes.ts`
- Modify: `src/modules/relations/relations.routes.ts`

- [x] Add serializer and HTTP coverage for core resources, recruiter, city links, candidates, devices, evaluation, metrics, account summary and status dashboard.
- [x] Replace direct public row spreading with named serializers on the audited routes.
- [x] Ensure collection envelopes remain unchanged (`items`, `total`, and target-specific keys).
- [x] Run focused tests for serializers, core modules, remaining business, resources and relation workflows.

### Task 3: Normalize known dynamic fields

**Files:**
- Modify: `src/shared/response-serializers.ts`
- Modify: `tests/response-serializers.test.ts`
- Modify: `过程文件/parity/target-list-items.json` only if the evidence schema needs a documented normalization rule.

- [x] Normalize device `config.timeout` to the observed object `{enabled, interval_seconds, max_count, scripts}`, preserve timestamp strings, and serialize `queue_stale` as a string.
- [x] Normalize service-position booleans, arrays, base-section keys and recruiter public aliases/related cities.
- [x] Run focused tests and an authenticated read-only customer GET probe.

### Task 4: Phase 1 verification gate

**Files:**
- Modify: `docs/verification.md`
- Modify: `过程文件/当前进度.md`

- [x] Run the full Vitest suite with one worker and a 60-second hook timeout: 13 files, 41 tests passed.
- [x] Run `npm run build` successfully.
- [x] Run a new authenticated read-only GET probe; the older 149-contract probe is not rerun because it sends write requests.
- [x] Record all 61 authenticated GET results as 50 `verified`, 11 `data-dependent`, 0 `partial`, and 0 `target-internal-failure`.
- [x] Mark Phase 1 `verified`: no serializer-owned field, type, or HTTP status differences remain in the GET probe.

## Phase 1 Verification Evidence (2026-10-23)

- Probe: `node scripts/probe-readonly.ts http://47.107.245.246:8080 http://127.0.0.1:4222`, invoked through `过程文件/parity/run-readonly-probe.ps1` so credentials are entered interactively and cleared from the environment after the run.
- Scope: 61 authenticated GET contracts only. The target receives login plus GET requests; no target POST/PUT/PATCH/DELETE requests are sent.
- Output: `过程文件/parity/readonly-authenticated-diff.json`; stores status, field/type/array fingerprints, differences, and classifications, not response values or credentials.
- Result: 50 verified, 11 data-dependent, 0 partial, 0 target-internal-failure.
- Remaining data-dependent routes have target records/configuration while the local demo database has fewer or empty records. This does not claim record-value parity.
- Full tests: 13 files, 41 tests passed. Build: `npm run build` passed.

