import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
if (mode !== "local" && mode !== "remote") {
  console.error("Usage: node scripts/apply-migrations.mjs <local|remote>");
  process.exit(2);
}
const configPath = path.join(root, "installation.json");
const wranglerPath = path.join(root, "wrangler.toml");
if (!fs.existsSync(configPath) || !fs.existsSync(wranglerPath)) {
  console.error("Run npm run configure:installation first. No migrations were applied.");
  process.exit(1);
}
let config;
try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); }
catch {
  console.error("installation.json is invalid JSON. No migrations were applied.");
  process.exit(1);
}
const databaseName = config.resources?.d1DatabaseName;
if (typeof databaseName !== "string" || !/^[a-z0-9][a-z0-9_-]{0,61}[a-z0-9]$/i.test(databaseName)) {
  console.error("resources.d1DatabaseName is missing or invalid. No migrations were applied.");
  process.exit(1);
}
const args = ["wrangler", "d1", "migrations", "apply", databaseName, mode === "remote" ? "--remote" : "--local"];
const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", args, {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32"
});
process.exit(result.status ?? 1);
