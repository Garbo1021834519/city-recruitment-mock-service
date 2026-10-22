/**
 * Request-body / query contracts captured from the target on 2026-10-21 by
 * POSTing `{}` to every write endpoint and recording the 422 payloads.
 * Source evidence: 过程文件/parity/target-422-contracts.json
 *
 * These are enforced *after* authentication, because the target validates
 * inside the route (403 for anonymous callers) rather than before it. Fastify
 * route schemas run in preValidation — before auth — so using them for these
 * routes would turn anonymous 403s into 422s and break parity.
 */

export type FieldType = "string" | "number" | "boolean" | "array" | "object" | "file";

export interface RouteContract {
  method: string;
  /** Fastify-style pattern: "/api/v1/cities/:id" */
  path: string;
  query?: Record<string, FieldType>;
  body?: Record<string, FieldType>;
}

export interface ValidationIssue {
  type: string;
  loc: (string | number)[];
  msg: string;
  input: unknown;
}

/** Field order matches the order the target reports them in. */
export const ROUTE_CONTRACTS: RouteContract[] = [
  // Read endpoints that require device scoping on the target (422 when absent).
  { method: "GET", path: "/api/v1/agent/conversations", query: { device_code: "string" } },
  { method: "GET", path: "/api/v1/agent/messages", query: { device_code: "string", customer_id: "string" } },
  { method: "GET", path: "/api/v1/agent/evaluation/detail", query: { device_code: "string" } },
  { method: "PATCH", path: "/api/v1/cities/:id/status", body: { recruitment_status: "string" } },
  { method: "POST", path: "/api/v1/activation/devices/batch-toggle", body: { device_codes: "array", enabled: "boolean" } },
  { method: "POST", path: "/api/v1/activation/scripts", body: { content: "string" } },
  { method: "POST", path: "/api/v1/activation/scripts/import", body: { file: "file" } },
  { method: "POST", path: "/api/v1/agent/candidates/:id/mark", query: { device_code: "string" }, body: { status: "string" } },
  { method: "POST", path: "/api/v1/agent/devices", body: { device_code: "string" } },
  { method: "POST", path: "/api/v1/agent/followup-config", body: { recruiter_id: "string" } },
  { method: "POST", path: "/api/v1/agent/manual-reply", body: { device_code: "string", customer_id: "number" } },
  { method: "POST", path: "/api/v1/agent/reminder-config", body: { recruiter_id: "string" } },
  { method: "POST", path: "/api/v1/agent/takeover", body: { device_code: "string", customer_id: "number", takeover: "boolean" } },
  { method: "POST", path: "/api/v1/auth/login", body: { username: "string", password: "string" } },
  { method: "POST", path: "/api/v1/cities", body: { city_name: "string" } },
  { method: "POST", path: "/api/v1/cities/:id/factories", body: { factory_id: "number" } },
  { method: "POST", path: "/api/v1/factories", body: { factory_name: "string" } },
  { method: "POST", path: "/api/v1/holiday-schedules", body: { city_name: "string", year: "number", holiday_name: "string", start_date: "string", end_date: "string" } },
  { method: "POST", path: "/api/v1/import-export/factories/import", body: { file: "file" } },
  { method: "POST", path: "/api/v1/import-export/import", body: { file: "file" } },
  { method: "POST", path: "/api/v1/import-export/service-positions/import", body: { file: "file" } },
  { method: "POST", path: "/api/v1/knowledge", body: { question: "string", answer: "string" } },
  { method: "POST", path: "/api/v1/knowledge/batch/delete", body: { ids: "array" } },
  { method: "POST", path: "/api/v1/knowledge/batch/import", body: { items: "array" } },
  { method: "POST", path: "/api/v1/knowledge/batch/update", body: { ids: "array" } },
  { method: "POST", path: "/api/v1/recruiters", body: { recruiter_id: "string", name: "string" } },
  { method: "POST", path: "/api/v1/recruiters/:id/cities", body: { city_id: "number" } },
  { method: "POST", path: "/api/v1/recruiters/:id/cities/batch", body: { city_ids: "array" } },
  { method: "POST", path: "/api/v1/recruiters/:id/service-cities/batch", body: { city_names: "array" } },
  { method: "POST", path: "/api/v1/service-positions", body: { position_name: "string" } },
  { method: "POST", path: "/api/v1/service-positions/:id/holidays", body: { year: "number", holiday_name: "string", start_date: "string", end_date: "string" } },
  { method: "POST", path: "/api/v1/service-positions/holidays-import", body: { file: "file" } },
  { method: "POST", path: "/api/v1/service-positions/jingcai-import", query: { recruiter_id: "string" }, body: { file: "file" } },
  { method: "POST", path: "/api/v1/unknown-questions/:id/convert", body: { question: "string", answer: "string" } },
  { method: "POST", path: "/api/v1/upload/image", body: { file: "file" } },
  { method: "POST", path: "/api/v1/upload/video", body: { file: "file" } },
  { method: "PUT", path: "/api/v1/activation/config/paused", body: { paused: "boolean" } },
  { method: "PUT", path: "/api/v1/activation/customers/:id/summary", body: { summary: "string" } },
  { method: "PUT", path: "/api/v1/agent/conversations/:id/reset-disqualified", query: { device_code: "string" } },
  { method: "PUT", path: "/api/v1/agent/conversations/:id/restart", query: { device_code: "string" } },
  { method: "PUT", path: "/api/v1/agent/device/:id/workflow", body: { file: "file" } },
  { method: "PUT", path: "/api/v1/recruiter-featured/cities/:id", body: { position_ids: "array" } },
];

/** Pydantic's `type` label for a value that does not match the expected type. */
const TYPE_LABEL: Record<FieldType, string> = {
  string: "string_type",
  number: "int_type",
  boolean: "bool_type",
  array: "list_type",
  object: "dict_type",
  file: "missing",
};

function matchesType(value: unknown, expected: FieldType): boolean {
  if (expected === "file") return false; // resolved separately via multipart detection
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  if (expected === "number") return typeof value === "number";
  if (expected === "boolean") return typeof value === "boolean";
  return typeof value === "string";
}

function toRegex(routeUrl: string): RegExp {
  const body = routeUrl
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "[^/]+");
  return new RegExp(`^${body}/?$`);
}

const MATCHERS = ROUTE_CONTRACTS.map((contract) => ({
  contract,
  regex: toRegex(contract.path),
}));

export function matchContract(method: string, pathname: string): RouteContract | undefined {
  return MATCHERS.find((m) => m.contract.method === method && m.regex.test(pathname))?.contract;
}

/**
 * Validate a request against its contract.
 * `isMultipart` lets file fields pass when the request really is multipart;
 * a JSON body declaring `file` still fails, matching the target's 422.
 */
export function collectValidationErrors(
  contract: RouteContract,
  body: unknown,
  query: unknown,
  isMultipart: boolean,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const bodyObj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const queryObj = query && typeof query === "object" ? (query as Record<string, unknown>) : {};

  for (const [field, expected] of Object.entries(contract.query ?? {})) {
    const value = queryObj[field];
    if (value === undefined || value === null || value === "") {
      issues.push({ type: "missing", loc: ["query", field], msg: "Field required", input: null });
    } else if (!matchesType(value, expected)) {
      issues.push({ type: TYPE_LABEL[expected], loc: ["query", field], msg: `Input should be a valid ${expected}`, input: value });
    }
  }

  for (const [field, expected] of Object.entries(contract.body ?? {})) {
    const value = bodyObj[field];
    if (expected === "file") {
      if (!isMultipart) issues.push({ type: "missing", loc: ["body", field], msg: "Field required", input: bodyObj });
      continue;
    }
    if (value === undefined || value === null) {
      issues.push({ type: "missing", loc: ["body", field], msg: "Field required", input: bodyObj });
    } else if (!matchesType(value, expected)) {
      issues.push({ type: TYPE_LABEL[expected], loc: ["body", field], msg: `Input should be a valid ${expected}`, input: value });
    }
  }

  return issues;
}
