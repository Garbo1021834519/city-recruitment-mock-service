import type { DatabaseSync } from "node:sqlite";
import type { AuthUser } from "./auth.service.js";

export interface UserScope {
  userId: number;
  isAdmin: boolean;
  recruiterIds: string[];
  recruiterDbIds: number[];
  cityIds: number[];
  deviceCodes: string[];
}

type RecruiterRow = { id: number; username: string; data_json: string };

function parseData(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

export function getUserScope(db: DatabaseSync, auth: AuthUser): UserScope {
  if (auth.role === "admin") return { userId: auth.id, isAdmin: true, recruiterIds: [], recruiterDbIds: [], cityIds: [], deviceCodes: [] };
  const rows = db.prepare("SELECT scope_type,scope_id FROM user_scope_assignments WHERE user_id=?").all(auth.id) as Array<{ scope_type: string; scope_id: string }>;
  const wantedRecruiterIds = new Set(rows.filter((row) => row.scope_type === "recruiter").map((row) => row.scope_id));
  if (auth.recruiter_id) wantedRecruiterIds.add(auth.recruiter_id);
  const recruiterRows = db.prepare("SELECT id,username,data_json FROM recruiters").all() as RecruiterRow[];
  const recruiterIds = new Set<string>();
  const recruiterDbIds = new Set<number>();
  for (const recruiter of recruiterRows) {
    const data = parseData(recruiter.data_json);
    const publicId = String(data.recruiter_id ?? recruiter.username);
    const matches = wantedRecruiterIds.has(publicId) || wantedRecruiterIds.has(recruiter.username) || wantedRecruiterIds.has(String(recruiter.id));
    if (!matches) continue;
    recruiterIds.add(publicId);
    recruiterIds.add(recruiter.username);
    recruiterIds.add(String(recruiter.id));
    recruiterDbIds.add(recruiter.id);
  }
  for (const id of wantedRecruiterIds) recruiterIds.add(id);

  const cityIds = new Set<number>();
  for (const row of rows.filter((scope) => scope.scope_type === "city")) {
    const id = Number(row.scope_id);
    if (Number.isSafeInteger(id) && id > 0) cityIds.add(id);
  }
  if (recruiterDbIds.size) {
    const placeholders = [...recruiterDbIds].map(() => "?").join(",");
    const cities = db.prepare(`SELECT city_id FROM recruiter_cities WHERE is_enabled=1 AND recruiter_id IN (${placeholders})`).all(...recruiterDbIds) as Array<{ city_id: number }>;
    for (const row of cities) cityIds.add(Number(row.city_id));
  }

  const deviceCodes = new Set(rows.filter((row) => row.scope_type === "device").map((row) => row.scope_id));
  if (recruiterIds.size) {
    const devices = db.prepare("SELECT data_json FROM agent_devices").all() as Array<{ data_json: string }>;
    for (const row of devices) {
      const data = parseData(row.data_json);
      if (recruiterIds.has(String(data.recruiter_id ?? "")) && typeof data.device_code === "string" && data.device_code) deviceCodes.add(data.device_code);
    }
  }
  return { userId: auth.id, isAdmin: false, recruiterIds: [...recruiterIds], recruiterDbIds: [...recruiterDbIds], cityIds: [...cityIds], deviceCodes: [...deviceCodes] };
}

export function canAccessCity(scope: UserScope, cityId: number): boolean {
  return scope.isAdmin || scope.cityIds.includes(Number(cityId));
}

export function canAccessDevice(scope: UserScope, deviceCode: string): boolean {
  return scope.isAdmin || scope.deviceCodes.includes(deviceCode);
}

export function canAccessRecruiter(scope: UserScope, recruiterId: string): boolean {
  return scope.isAdmin || scope.recruiterIds.includes(recruiterId) || scope.recruiterDbIds.includes(Number(recruiterId));
}

export function cityConstraint(scope: UserScope, column: string): { sql: string; values: number[] } {
  if (scope.isAdmin) return { sql: "", values: [] };
  if (!scope.cityIds.length) return { sql: " AND 1=0", values: [] };
  return { sql: ` AND ${column} IN (${scope.cityIds.map(() => "?").join(",")})`, values: scope.cityIds };
}

export function recruiterConstraint(scope: UserScope, column: string): { sql: string; values: string[] } {
  if (scope.isAdmin) return { sql: "", values: [] };
  if (!scope.recruiterIds.length) return { sql: " AND 1=0", values: [] };
  return { sql: ` AND ${column} IN (${scope.recruiterIds.map(() => "?").join(",")})`, values: scope.recruiterIds };
}

export function deviceConstraint(scope: UserScope, column: string): { sql: string; values: string[] } {
  if (scope.isAdmin) return { sql: "", values: [] };
  if (!scope.deviceCodes.length) return { sql: " AND 1=0", values: [] };
  return { sql: ` AND ${column} IN (${scope.deviceCodes.map(() => "?").join(",")})`, values: scope.deviceCodes };
}
