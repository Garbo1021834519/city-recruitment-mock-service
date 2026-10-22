#!/usr/bin/env node
// Full-surface unauthenticated differential probe: target vs local.
// Reads 过程文件/api-contracts.json, probes every contract on both origins,
// fingerprints each response, writes a ranked divergence report.
//
// Usage: node 过程文件/parity/probe-unauthenticated.mjs [targetUrl] [localUrl]

import fs from "node:fs";
import path from "node:path";

const TARGET = process.argv[2] ?? "http://47.107.245.246:8080";
const LOCAL = process.argv[3] ?? "http://127.0.0.1:8090";
const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "过程文件", "parity");
fs.mkdirSync(path.join(OUT_DIR, "evidence"), { recursive: true });

const contracts = JSON.parse(
  fs.readFileSync(path.join(ROOT, "过程文件", "api-contracts.json"), "utf8"),
).paths;

// Turn FastAPI-style "/cities/{city_id}/history/{history_id}" and local
// "/cities/:id/history/:id" into a concrete probe URL with plausible ids.
function concrete(route) {
  const cleaned = route.replace(/\?.*$/, "");
  return cleaned.replace(/\{[^}]+\}|:[A-Za-z_]+/g, "999999");
}

// Response fingerprint: status, content-type family, top-level key set,
// item key set (first array element), and shape family.
function fingerprint(status, contentType, bodyText) {
  const ct = (contentType ?? "").split(";")[0].trim();
  let shape = null;
  let keys = null;
  let itemKeys = null;
  try {
    const body = JSON.parse(bodyText);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      keys = Object.keys(body).sort();
      const arrKey = Object.keys(body).find((k) => Array.isArray(body[k]) && body[k].length);
      const arr = Array.isArray(body) ? body : arrKey ? body[arrKey] : null;
      if (Array.isArray(arr) && arr.length && arr[0] && typeof arr[0] === "object") {
        itemKeys = Object.keys(arr[0]).sort();
      }
      shape = "object";
    } else if (Array.isArray(body)) {
      shape = "array";
      if (body.length && body[0] && typeof body[0] === "object") itemKeys = Object.keys(body[0]).sort();
    } else {
      shape = typeof body;
    }
  } catch {
    shape = bodyText.length ? "non-json" : "empty";
  }
  return { status, ct, shape, keys, itemKeys };
}

async function probe(origin, method, urlPath) {
  const init = { method, headers: {}, redirect: "manual" };
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    init.headers["Content-Type"] = "application/json";
    init.body = "{}";
  }
  const started = Date.now();
  let res;
  try {
    res = await fetch(origin + urlPath, init);
  } catch (err) {
    return { status: 0, ct: "network-error", text: String(err), ms: Date.now() - started };
  }
  const text = await res.text();
  return {
    status: res.status,
    ct: res.headers.get("content-type") ?? "",
    text: text.length > 4000 ? text.slice(0, 4000) : text,
    ms: Date.now() - started,
  };
}

function compare(contract, t, l) {
  const tf = fingerprint(t.status, t.ct, t.text);
  const lf = fingerprint(l.status, l.ct, l.text);
  const diffs = [];
  if (tf.status !== lf.status) diffs.push(`status ${tf.status} != ${lf.status}`);
  if (tf.ct !== lf.ct) diffs.push(`content-type "${tf.ct}" != "${lf.ct}"`);
  if (tf.keys || lf.keys) {
    const tk = new Set(tf.keys ?? []);
    const lk = new Set(lf.keys ?? []);
    const missing = [...tk].filter((k) => !lk.has(k));
    const extra = [...lk].filter((k) => !tk.has(k));
    if (missing.length) diffs.push(`missing keys: ${missing.join(",")}`);
    if (extra.length) diffs.push(`extra keys: ${extra.join(",")}`);
  }
  return {
    method: contract.method,
    path: contract.path,
    probePath: concrete(contract.path),
    target: { status: tf.status, keys: tf.keys, sample: t.text.slice(0, 240) },
    local: { status: lf.status, keys: lf.keys, sample: l.text.slice(0, 240) },
    diffs,
  };
}

const results = [];
const concurrency = 12;
let cursor = 0;

async function worker() {
  while (cursor < contracts.length) {
    const i = cursor++;
    const c = contracts[i];
    const p = concrete(c.path);
    if (!p.startsWith("/api/")) continue;
    const [t, l] = await Promise.all([probe(TARGET, c.method, p), probe(LOCAL, c.method, p)]);
    results.push(compare(c, t, l));
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

const diverged = results.filter((r) => r.diffs.length);
const identical = results.length - diverged.length;
const statusHistogram = {};
for (const r of results) {
  const k = `target ${r.target.status} / local ${r.local.status}`;
  statusHistogram[k] = (statusHistogram[k] ?? 0) + 1;
}

const report = {
  generatedAt: new Date().toISOString(),
  target: TARGET,
  local: LOCAL,
  contractCount: results.length,
  identicalStatusAndShape: identical,
  diverged: diverged.length,
  statusHistogram,
  divergences: diverged,
  matches: results.filter((r) => !r.diffs.length).map((r) => `${r.method} ${r.path} -> ${r.target.status}`),
};

fs.writeFileSync(path.join(OUT_DIR, "unauthenticated-diff.json"), JSON.stringify(report, null, 2));

console.log(`contracts probed: ${report.contractCount}`);
console.log(`identical status+shape: ${identical}`);
console.log(`diverged: ${diverged.length}`);
console.log("\nstatus histogram (target / local):");
for (const [k, v] of Object.entries(statusHistogram).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log(`\nreport: ${path.join(OUT_DIR, "unauthenticated-diff.json")}`);
