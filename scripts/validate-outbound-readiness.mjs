import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Script} from "node:vm";

const backend=readFileSync(new URL("../src/index.ts",import.meta.url),"utf8");
const page=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const scripts=[...page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
assert.ok(scripts.length,"webmail script missing");
for(const script of scripts)new Script(script[1],{filename:"public/index.html"});
const routeStart=backend.indexOf('app.get("/api/sending/readiness"');
const routeEnd=backend.indexOf('app.post("/api/messages/send"',routeStart);
assert.ok(routeStart>=0&&routeEnd>routeStart,"authenticated readiness route missing");
const route=backend.slice(routeStart,routeEnd);
assert.ok(route.includes("getSendAccount(c,accountId,user)"),"readiness must check sender authorization and domain verification");
assert.ok(route.includes("getOutboundPreflight(c.env)"),"readiness must use safe config helper");
assert.ok(!route.includes("RESEND_RELAY_TOKEN"),"readiness endpoint must not expose relay secrets");
assert.ok(page.includes('id="send-readiness"'),"composer readiness status missing");
assert.ok(page.includes('void refreshSendReadiness()'),"composer readiness refresh missing");
console.log("MSM MAIL send readiness contract and inline JS syntax PASS");
