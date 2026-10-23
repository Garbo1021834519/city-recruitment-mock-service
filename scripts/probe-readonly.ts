import fs from "node:fs";
import path from "node:path";
import { classifyParity, concreteRoute, diffShapes, shapeOf, type Shape } from "../src/shared/parity.js";

const root = process.cwd();
const target = process.argv[2] ?? "http://47.107.245.246:8080";
const local = process.argv[3] ?? "http://127.0.0.1:4222";
const username = process.env.REA_TARGET_USER;
const password = process.env.REA_TARGET_PASS;
const localUsername = process.env.REA_LOCAL_USER ?? "local-customer";
const localPassword = process.env.REA_LOCAL_PASS ?? "local-demo-only";
const reportFilename = process.env.REA_PARITY_OUTPUT ?? "readonly-authenticated-diff.json";

if (!username || !password) throw new Error("Set REA_TARGET_USER and REA_TARGET_PASS in the process environment.");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(reportFilename)) throw new Error("REA_PARITY_OUTPUT must be a plain JSON filename.");

const contracts = JSON.parse(fs.readFileSync(path.join(root, "过程文件", "api-contracts.json"), "utf8")) as {
  paths: Array<{ method: string; path: string }>;
};
const routes = [...new Map(contracts.paths
  .filter((contract) => contract.method.toUpperCase() === "GET" && contract.path.startsWith("/api/"))
  .map((contract) => [concreteRoute(contract.path), contract.path]))
  .entries()]
  .map(([url, route]) => ({ url, route }));

async function login(origin: string, user: string, pass: string): Promise<string> {
  const response = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user, password: pass }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Login failed: HTTP ${response.status}`);
  const result = await response.json() as { access_token?: string };
  if (!result.access_token) throw new Error("Login response did not include an access token.");
  return result.access_token;
}

async function read(origin: string, token: string, url: string): Promise<{ status: number; shape: Shape }> {
  try {
    const response = await fetch(`${origin}${url}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    if (!contentType.includes("json")) return { status: response.status, shape: body ? "non-json" : "empty" };
    try {
      return { status: response.status, shape: shapeOf(JSON.parse(body)) };
    } catch {
      return { status: response.status, shape: "invalid-json" };
    }
  } catch {
    return { status: 0, shape: "network-error" };
  }
}

const [targetToken, localToken] = await Promise.all([
  login(target, username, password),
  login(local, localUsername, localPassword),
]);

let cursor = 0;
const results: Array<{
  method: "GET";
  path: string;
  target: { status: number; shape: Shape };
  local: { status: number; shape: Shape };
  differences: string[];
  classification: string;
}> = [];

async function worker() {
  while (cursor < routes.length) {
    const { url, route } = routes[cursor++];
    const [targetResult, localResult] = await Promise.all([
      read(target, targetToken, url),
      read(local, localToken, url),
    ]);
    const differences = targetResult.status === localResult.status
      ? diffShapes(targetResult.shape, localResult.shape)
      : [`status ${targetResult.status} != ${localResult.status}`];
    results.push({
      method: "GET",
      path: route,
      target: targetResult,
      local: localResult,
      differences,
      classification: classifyParity({ targetStatus: targetResult.status, localStatus: localResult.status, diffs: differences }),
    });
  }
}

await Promise.all(Array.from({ length: 4 }, worker));
results.sort((a, b) => a.path.localeCompare(b.path));
const counts = Object.fromEntries(["verified", "partial", "data-dependent", "target-internal-failure"].map((name) => [
  name,
  results.filter((result) => result.classification === name).length,
]));
const report = {
  generatedAt: new Date().toISOString(),
  mode: "authenticated-read-only-get",
  target: new URL(target).origin,
  local: new URL(local).origin,
  contractCount: results.length,
  counts,
  results,
};
const outputDirectory = path.join(root, "过程文件", "parity");
fs.mkdirSync(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, reportFilename);
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`mode: ${report.mode}`);
console.log(`GET contracts: ${results.length}`);
console.log(`classification: ${JSON.stringify(counts)}`);
for (const result of results.filter((item) => item.classification !== "verified")) {
  console.log(`${result.classification} GET ${result.path} (${result.target.status} vs ${result.local.status})`);
  for (const difference of result.differences.slice(0, 4)) console.log(`  ${difference}`);
}
console.log(`report: ${outputPath}`);
