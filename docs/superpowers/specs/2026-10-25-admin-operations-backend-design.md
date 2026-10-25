# Admin Operations Backend Design

Date: 2026-10-25

## Goal

Make the existing application usable as a multi-user operations system. An administrator must be able to manage accounts and see system-wide business state. Recruiter and customer logins must be scoped to the business resources assigned to them. An operations contact in a conversation is a business record, not a login account.

This design keeps the captured Vue application, its current routes, and the `/api/v1` compatibility surface. It builds on the existing `admin`, `customer`, and `recruiter` roles instead of inventing new roles before their target behavior is known.

## Current Constraints

- `users` stores login accounts, while `recruiters` and `agent_conversations` store separate business records.
- User management currently lists, creates, and deactivates accounts. Creation does not bind a recruiter or scope; there is no edit or password reset flow.
- Agent devices store their public fields in `data_json`. The seeded device has no `device_code`, so the conversation screen requests `device_code=` and receives 422.
- Conversation and message records are keyed by device code, but no ownership relation connects a login account to a recruiter, city, or device.
- The admin menu exposes existing business pages, but several reports and integrations are placeholders. Page presence is not evidence of a complete operational workflow.

## Roles And Data Ownership

- `admin` is global. It can view and manage all login accounts, recruiters, cities, positions, devices, conversations, activation records, knowledge, reports, and system settings.
- `recruiter` is attached to one recruiter business record and can access only the assigned recruiter, cities, devices, and related conversations and activation data.
- `customer` is attached to an explicitly assigned business scope. It is not the same entity as a candidate or contact shown in a conversation.
- Candidate, old-friend, and conversation customer identifiers remain business identifiers. They are never used as login account IDs.

Add a normalized scope-assignment table for user-to-recruiter, user-to-city, and user-to-device grants. Admin bypasses scope filtering. Device records gain a stable `device_code` and recruiter ownership in structured columns or a normalized relation; message and conversation records continue to reference that stable code. Authorization is enforced by API handlers; hiding a menu item is only a user-experience aid.

## Admin Workflows

The existing `/users` page becomes the account control surface. It supports search, role and active-state filters, create, edit, recruiter/scope assignment, password reset, activate/deactivate, and last-updated information. Password hashes and reset credentials are never returned by list or detail APIs. An administrator cannot disable its own account or the last active administrator.

The admin landing view summarizes account counts, recruiter/city/position counts, device online state, active conversations, pending activation work, failed jobs, and recent webhook failures. Every value comes from SQLite queries; empty values render as zero with an explicit empty state, not fabricated sample totals.

Existing module routes remain available to admin as global operations. Recruiter and customer routes use the assignment scope for reads and writes. Admin mutations that affect access or external operations create an audit record containing actor ID, action, resource type/ID, timestamp, and a redacted change summary. Passwords, tokens, API keys, and message bodies are excluded.

## API And Storage Changes

- Preserve `GET /api/v1/auth/users` and its `{items,total}` envelope. Add filtering and pagination without changing the default response shape.
- Extend account creation to accept role and scope assignments, with validation that recruiter roles reference an existing recruiter.
- Add admin-only account update, password reset, and activate/deactivate endpoints. Keep the existing delete endpoint as a soft-disable compatibility alias.
- Add admin-only summary data for the landing view; summary fields are aggregate counts and health states, not raw candidate data.
- Add a migration for scope assignments, audit records, and any required normalized device identity fields. Migrations must preserve existing users, recruiters, devices, conversations, and message rows.
- Seed stable, clearly fictional device and conversation fixtures that join by `device_code`; make seed behavior idempotent and update the existing demo device safely.

## First End-To-End Acceptance Slice

1. Admin creates a recruiter login and assigns an existing recruiter, a city, and a demo device.
2. The recruiter can log in and sees only assigned devices and their conversations; its conversation list and message thread load without 422.
3. Admin can see the same records globally and can update the assignment.
4. Admin disables the recruiter account; subsequent login and existing-token API calls are rejected.
5. User and assignment changes appear in the audit log without secrets.
6. A request failure in the conversation view is shown as an error state, distinct from a successful empty list.

## Out Of Scope For The First Slice

- Claiming parity for target admin or recruiter behavior that has not been observed with an authorized target account.
- Importing production candidate or contact data. Fixtures remain fictional; real datasets require an owner-provided, appropriately sanitized export.
- Multi-tenant billing, arbitrary permission builders, and new roles beyond the three established role values.
- Switching SQLite to a network database. The first slice targets one durable local instance; deployment and horizontal scaling need a separate design.
- Automatically sending real messages. Live Dify selection and a continuously running worker are separate operational integration work and must be verified against an authorized test endpoint.

## Verification

- API tests cover account creation/update/reset/disable, recruiter existence validation, self-disable and last-admin protection, scope enforcement, and audit redaction.
- Browser flow tests cover admin account management and recruiter login, assigned device visibility, conversation loading, and the error-versus-empty state.
- Existing response-contract tests and the read-only parity probe must remain green for the captured customer surface.
- Build and the full test suite run after each implementation slice. No test writes to the target service.

## Delivery Sequence

1. Implement account lifecycle and scope schema with API tests.
2. Connect admin user management UI and aggregate landing view.
3. Add ownership filtering for recruiter/customer business routes.
4. Repair the local device/conversation fixture and verify the browser conversation flow.
5. Run parity and permission probes; record any target-role assumptions separately from verified behavior.
