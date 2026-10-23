import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const originIndex = argv.indexOf("--origin");
  const origin = originIndex >= 0 ? argv[originIndex + 1] : "http://47.107.245.246:8080";
  if (!origin || origin.startsWith("-")) throw new Error("Usage: node scripts/collect-site-assets.mjs --origin http://host:port");
  const url = new URL(origin);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("origin must be a credential-free HTTP(S) origin");
  return { origin: url.origin, output: path.resolve(process.cwd(), "过程文件", "raw-assets") };
}

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function resourceNames(text) {
  const values = new Set();
  for (const match of text.matchAll(/(?:import\(|(?:src|href)=)["'](?:\.\/)?([^"']+\.(?:js|css|png|svg|ico|woff2?|ttf|webp))(?:["')?])/gi)) values.add(match[1]);
  for (const match of text.matchAll(/\.\/([A-Za-z0-9_./-]+\.(?:js|css|png|svg|ico|woff2?|ttf|webp))/gi)) values.add(match[1]);
  // Vite's preload dependency table stores lazy assets as `assets/file.css`
  // strings without a leading `./`; include those CSS/JS entries as well.
  for (const match of text.matchAll(/["']assets\/([A-Za-z0-9_.-]+\.(?:js|css|png|svg|ico|woff2?|ttf|webp))["']/gi)) values.add(match[1]);
  return [...values]
    .map((x) => x.replace(/^\/+/, "").replace(/^assets\//, ""))
    .filter((x) => !x.includes(".."));
}

async function fetchResource(url, origin) {
  const parsed = new URL(url);
  if (parsed.origin !== origin) throw new Error(`cross-origin resource rejected: ${parsed.origin}`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`credential-bearing resource rejected: ${url}`);
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "" };
}

async function main() {
  const { origin, output } = parseArgs(process.argv.slice(2));
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  const entry = await fetchResource(`${origin}/cities`, origin);
  await fs.writeFile(path.join(output, "index.html"), entry.bytes);
  const html = entry.bytes.toString("utf8");
  const queue = resourceNames(html);
  const seen = new Set();
  const assets = [{ path: "index.html", url: `${origin}/cities`, status: 200, bytes: entry.bytes.length, sha256: sha256(entry.bytes), content_type: entry.contentType }];
  while (queue.length) {
    const relative = queue.shift();
    if (seen.has(relative)) continue;
    seen.add(relative);
    const url = `${origin}/assets/${relative}`;
    const result = await fetchResource(url, origin);
    const destination = path.join(output, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, result.bytes);
    assets.push({ path: path.relative(process.cwd(), destination), url, status: 200, bytes: result.bytes.length, sha256: sha256(result.bytes), content_type: result.contentType });
    if (/\.js$/i.test(relative)) queue.push(...resourceNames(result.bytes.toString("utf8")));
  }
  await fs.writeFile(path.join(path.dirname(output), "asset-manifest.json"), `${JSON.stringify({ generated_at: new Date().toISOString(), origin, assets }, null, 2)}\n`);
  const root = assets.find((asset) => asset.path.endsWith("index-BGyFQL9Q.js"));
  if (root) await fs.writeFile(path.join(path.dirname(output), "root-bundle.js"), await fs.readFile(path.join(process.cwd(), root.path)));
  console.log(JSON.stringify({ origin, asset_count: assets.length, javascript: assets.filter((a) => a.path.endsWith(".js")).length, stylesheets: assets.filter((a) => a.path.endsWith(".css")).length }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
