import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const auth = readFileSync(new URL("../src/middleware/auth.ts", import.meta.url), "utf8");
assert.match(auth, /const SESSION_TTL_SECONDS=60\*60\*12;/);
assert.match(auth, /const SESSION_IDLE_SECONDS=60\*60\*2;/);
assert.ok(html.includes("expira a las 12 horas o tras 2 horas de inactividad"));
assert.ok(!html.includes("expira después de 30 días"));
console.log("Session expiry copy matches backend session policy.");
