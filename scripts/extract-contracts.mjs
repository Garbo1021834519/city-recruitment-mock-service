import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const routePattern = /path:"([^"]+)"(?:,name:"([^"]+)")?.{0,240}?import\("\.\/([^\"]+\.js)"\)/g;
const apiMethodPattern = /\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/gi;
const apiTemplatePattern = /\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete)\(\s*`([^`]*\/api\/v1\/[^`]*)`/gi;
const formPattern = /\.append\(\s*["']([^"']+)["']/g;
const responseTypePattern = /responseType\s*:\s*["']([^"']+)["']/g;

export function extractRouteManifest(source) {
  return [...source.matchAll(routePattern)].map((match) => ({
    path: match[1],
    name: match[2] ?? null,
    chunk: match[3],
  }));
}

function normalizeApiPath(raw) {
  return raw
    .replace(/\$\{[^}]+\}/g, ":id")
    .replace(/\/+$/, "")
    .replace(/^([^/])/, "/$1");
}

export function extractApiContracts(source) {
  const paths = [];
  const seen = new Set();
  const add = (method, rawPath) => {
    const pathValue = normalizeApiPath(rawPath);
    if (!pathValue.includes("/api/v1/")) return;
    const key = `${method.toUpperCase()} ${pathValue}`;
    if (seen.has(key)) return;
    seen.add(key);
    paths.push({ method: method.toUpperCase(), path: pathValue });
  };
  for (const match of source.matchAll(apiMethodPattern)) add(match[1], match[2]);
  for (const match of source.matchAll(apiTemplatePattern)) add(match[1], match[2]);
  return {
    paths: paths.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`)),
    form_fields: [...new Set([...source.matchAll(formPattern)].map((m) => m[1]))].sort(),
    response_types: [...new Set([...source.matchAll(responseTypePattern)].map((m) => m[1]))].sort(),
  };
}

export function aggregateApiContracts(sources) {
  const results = sources.map((source) => extractApiContracts(source));
  return {
    paths: [...new Map(results.flatMap((result) => result.paths).map((item) => [`${item.method} ${item.path}`, item])).values()]
      .sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`)),
    form_fields: [...new Set(results.flatMap((result) => result.form_fields))].sort(),
    response_types: [...new Set(results.flatMap((result) => result.response_types))].sort(),
  };
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function writeJson(filename, value) {
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const root = process.cwd();
  const sourceFile = process.argv[2] ?? path.join(root, "过程文件", "raw-assets", "index-BGyFQL9Q.js");
  const source = await fs.readFile(sourceFile, "utf8");
  const routeManifest = {
    generated_at: new Date().toISOString(),
    source_file: path.relative(root, sourceFile),
    routes: extractRouteManifest(source),
  };
  const assetDirectory = path.dirname(sourceFile);
  const assetNames = (await fs.readdir(assetDirectory)).filter((name) => name.endsWith(".js"));
  const assetSources = await Promise.all(assetNames.map((name) => fs.readFile(path.join(assetDirectory, name), "utf8")));
  const contracts = aggregateApiContracts(assetSources);
  const output = path.join(root, "过程文件");
  await fs.mkdir(output, { recursive: true });
  await writeJson(path.join(output, "route-manifest.json"), routeManifest);
  await writeJson(path.join(output, "api-contracts.json"), {
    generated_at: routeManifest.generated_at,
    source_files: assetNames,
    ...contracts,
  });
  const digest = sha256(await fs.readFile(sourceFile));
  await writeJson(path.join(output, "asset-manifest.json"), {
    generated_at: routeManifest.generated_at,
    assets: [{ path: routeManifest.source_file, bytes: Buffer.byteLength(source), sha256: digest }],
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
