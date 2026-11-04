import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const auth = await read("src/middleware/auth.ts");
const api = await read("src/index.ts");
const sessionMigration = await read("migrations/0020_session_absolute_lifetime.sql");

assert.match(auth, /SESSION_TTL_SECONDS\s*=\s*60\s*\*\s*60\s*\*\s*12/, "Absolute session lifetime must remain 12 hours");
assert.match(auth, /SESSION_IDLE_SECONDS\s*=\s*60\s*\*\s*60\s*\*\s*2/, "Idle session lifetime must remain 2 hours");
assert.match(auth, /s\.last_seen_at>\?/, "Authentication must reject idle sessions");
assert.match(sessionMigration, /UPDATE auth_sessions[\s\S]*created_at, '\+12 hours'/, "Existing sessions must be capped at 12 hours");
assert.match(api, /Cache-Control", "private, no-store"/, "API responses must not be cached");
assert.match(api, /csrf_origin_rejected/, "Mutating API requests must validate Origin");
assert.match(api, /verifyResendWebhook\(rawBody, c\.req\.raw, c\.env\.RESEND_WEBHOOK_SECRET\)/, "Resend webhooks must validate signatures");
assert.match(api, /ap\.permission = 'read_write'/, "Message mutations must require write permission");
assert.match(api, /ap\.permission IN \('read_only','read_write'\)/, "Message and attachment reads must require read permission");
assert.match(api, /WHERE m\.direction = 'inbound' AND m\.folder = 'inbox'/, "Notification queries must remain limited to inbound inbox mail");
console.log("Session limits, API cache controls, CSRF, webhook signatures and mailbox permission guards are present.");
