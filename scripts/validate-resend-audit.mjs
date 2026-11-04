import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source=readFileSync(new URL("./msm-resend-readonly-audit.ps1",import.meta.url),"utf8");
assert.ok(/^[\x00-\x7F]*$/.test(source),"PowerShell 5.1 audit must remain ASCII-safe");
assert.ok(source.includes("AUDIT COMPLETE - No changes or email sends were performed."));
assert.ok(!/wrangler\s+(?:secret\s+put|deploy|d1\s+migrations\s+apply)/i.test(source),"Audit must not modify remote data");
console.log("MSM Resend audit PowerShell 5.1 encoding and read-only guard PASS");
