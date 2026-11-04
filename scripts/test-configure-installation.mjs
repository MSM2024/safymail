import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mail-center-config-test-"));
try {
  const scriptsDir = path.join(temp, "scripts");
  fs.mkdirSync(scriptsDir);
  const generatorPath = path.join(scriptsDir, "configure-installation.mjs");
  fs.copyFileSync(path.join(projectRoot, "scripts/configure-installation.mjs"), generatorPath);
  fs.copyFileSync(path.join(projectRoot, "wrangler.template.toml"), path.join(temp, "wrangler.template.toml"));
  const configPath = path.join(temp, "installation.json");
  const config = {
    appName: "Test Mail Center",
    workerName: "test-mail-center",
    environment: "test",
    domain: "example.com",
    adminEmail: "admin@example.com",
    resendRegion: "eu-west-1",
    controlPlaneUrl: "https://control.example.com",
    installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    cloudflare: { accountId: "a".repeat(32), zoneId: "b".repeat(32) },
    resources: {
      d1DatabaseName: "test-mail-center",
      d1DatabaseId: "11111111-2222-4333-8444-555555555555",
      kvNamespaceId: "c".repeat(32)
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const run = () => spawnSync(process.execPath, [generatorPath, configPath], { encoding: "utf8" });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  const generated = fs.readFileSync(path.join(temp, "wrangler.toml"), "utf8");
  assert.match(generated, /name = "test-mail-center"/);
  assert.match(generated, /database_id = "11111111-2222-4333-8444-555555555555"/);
  assert.match(generated, /id = "cccccccccccccccccccccccccccccccc"/);
  assert.doesNotMatch(generated, /\{\{[A-Z_]+\}\}/);

  config.resources.d1DatabaseId = "4f618dfc-9f9c-444e-8162-4d4448525cf5";
  fs.writeFileSync(configPath, JSON.stringify(config));
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /original Europe Mail Center environments/);

  config.resources.d1DatabaseId = "REPLACE_AFTER_D1_PROVISIONING";
  fs.writeFileSync(configPath, JSON.stringify(config));
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UUID-like D1 ID/);
  console.log("Installer configuration tests passed.");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
