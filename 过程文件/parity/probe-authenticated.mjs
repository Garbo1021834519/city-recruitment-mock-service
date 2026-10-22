#!/usr/bin/env node
// Authenticated differential probe: target vs local.
//
// Credentials are read from the environment (REA_TARGET_USER / REA_TARGET_PASS)
// and never written to disk, logged, or embedded in the report. Only response
// status, key sets and value *types* are recorded — never values.
//
// Usage:
//   REA_TARGET_USER=yihong REA_TARGET_PASS='...' \
//     node 过程文件/parity/probe-authenticated.mjs [targetUrl] [localUrl]
//
// Local credentials default to the seeded local-admin account.

import fs from "node:fs";
import path from "node:path";

const TARGET = process.argv[2] ?? "http://47.107.245.246:8080";
const LOCAL = process.argv[3] ?? "http://127.0.0.1:8090";
const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "过程文件", "parity");

const TARGET_USER = process.env.REA_TARGET_USER;
const TARGET_PASS = process.env.REA_TARGET_PASS;
const LOCAL_USER = process.env.REA_LOCAL_USER ?? "local-admin";
const LOCAL_PASS = process.env.REA_LOCAL_PASS ?? "local-demo-only";

if (!TARGET_USER || !TARGET_PASS) {
  console.error("Missing REA_TARGET_USER / REA_TARGET_PASS in the environment.");
  process.exit(2);
}

const contracts = JSON.parse(
  fs.readFileSync(path.join(ROOT, "过程文件", "api-contracts.json"), "utf8"),
).paths;

function concrete(route) {
  return route.replace(/\?.*$/, "").replace(/\{[^}]+\}|:[A-Za-z_]+/g, "999999");
}

/** Describe a value by type only — never echo data values into evidence. */
function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Shape fingerprint: key -> type, plus first-element shape for arrays. */
function shapeOf(body) {
  if (Array.isArray(body)) {
    return {
      __kind: "array",
      __len: body.length > 0 ? "non-empty" : "empty",
      item: body.length && body[0] && typeof body[0] === "object" ? shapeOf(body[0]) : typeOf(body[0]),
    };
  }
  if (body && typeof body === "object") {
    const out = {};
    for (const key of Object.keys(body).sort()) {
      const v = body[key];
      if (Array.isArray(v)) {
        out[key] = {
          __kind: "array",
          __len: v.length > 0 ? "non-empty" : "empty",
          item: v.length && v[0] && typeof v[0] === "object" ? shapeOf(v[0]) : typeOf(v[0]),
        };
      } else if (v && typeof v === "object") {
        out[key] = shapeOf(v);
      } else {
        out[key] = typeOf(v);
      }
    }
    return out;
  }
  return typeOf(body);
}

async function login(origin, username, password) {
  const res = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login failed on ${origin}: HTTP ${res.status}`);
  const body = await res.json();
  if (!body.access_token) throw new Error(`login on ${origin} returned no access_token`);
  return body.access_token;
}

async function call(origin, token, method, route) {
  const init = { method, headers: { Authorization: `Bearer ${token}` }, redirect: "manual" };
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    init.headers["Content-Type"] = "application/json";
    init.body = "{}";
  }
  try {
    const res = await fetch(origin + concrete(route), init);
    const text = await res.text();
    let shape = null;
    let detail = null;
    try {
      const parsed = JSON.parse(text);
      shape = shapeOf(parsed);
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
    } catch {
      shape = text.length ? "non-json" : "empty";
    }
    return { status: res.status, shape, detail };
  } catch (err) {
    return { status: 0, shape: String(err), detail: null };
  }
}

/** Structural difference between two shapes, recursing through objects. */
function diffShapes(a, b, at = "") {
  const out = [];
  if (a === null || b === null) return a === b ? out : [`${at || "<root>"}: ${a} != ${b}`];
  if (typeof a !== "object" || typeof b !== "object") {
    return a === b ? out : [`${at || "<root>"}: ${a} != ${b}`];
  }
  if (Array.isArray(a) || Array.isArray(b)) return out;
  for (const k of Object.keys(a)) if (!(k in b)) out.push(`${at}${k}: missing locally`);
  for (const k of Object.keys(b)) if (!(k in a)) out.push(`${at}${k}: extra locally`);
  for (const k of Object.keys(a)) if (k in b) out.push(...diffShapes(a[k], b[k], `${at}${k}.`));
  return out;
}

const [targetToken, localToken] = await Promise.all([
  login(TARGET, TARGET_USER, TARGET_PASS),
  login(LOCAL, LOCAL_USER, LOCAL_PASS),
]);

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < contracts.length) {
    const c = contracts[cursor++];
    const p = concrete(c.path);
    if (!p.startsWith("/api/")) continue;
    const [t, l] = await Promise.all([
      call(TARGET, targetToken, c.method, c.path),
      call(LOCAL, localToken, c.method, c.path),
    ]);
    const diffs = [];
    if (t.status !== l.status) diffs.push(`status ${t.status} != ${l.status}`);
    if (t.status === l.status && t.status < 400) diffs.push(...diffShapes(t.shape, l.shape));
    results.push({ method: c.method, path: c.path, target: t, local: l, diffs });
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

const diverged = results.filter((r) => r.diffs.length);
const report = {
  generatedAt: new Date().toISOString(),
  target: { origin: TARGET, user: TARGET_USER },
  local: { origin: LOCAL, user: LOCAL_USER },
  contractCount: results.length,
  identical: results.length - diverged.length,
  diverged: diverged.length,
  divergences: diverged,
};
fs.writeFileSync(path.join(OUT_DIR, "authenticated-diff.json"), JSON.stringify(report, null, 2));

console.log(`contracts: ${results.length}  identical: ${report.identical}  diverged: ${report.diverged}`);
for (const d of diverged.slice(0, 25)) {
  console.log(`\n${d.method} ${d.path}  [${d.target.status} vs ${d.local.status}]`);
  for (const line of d.diffs.slice(0, 6)) console.log(`  - ${line}`);
}
console.log(`\nreport: ${path.join(OUT_DIR, "authenticated-diff.json")}`);
