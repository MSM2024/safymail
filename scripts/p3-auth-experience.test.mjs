import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const css=readFileSync(new URL("../public/msm-mail-ui.css",import.meta.url),"utf8");
test("existing login and MFA routes remain unchanged",()=>{
 for(const route of ["/api/auth/bootstrap","/api/auth/login","/api/auth/mfa/verify"])assert.ok(html.includes(route));
 assert.ok(html.includes('id="auth-form"'));
 assert.ok(html.includes('id="mfa-form"'));
});
test("distinct login and MFA visual surfaces and live errors",()=>{
 assert.ok(html.includes('data-auth-surface="main"'));
 assert.ok(html.includes('data-auth-surface="mfa"'));
 for(const id of ["auth-error","mfa-error"])assert.ok(html.includes('id="'+id+'" role="alert" aria-live="polite"'));
 assert.ok(css.includes('.auth-card[data-auth-surface="mfa"] #mfa-code'));
});
test("premium mobile auth remains scrollable and accessible",()=>{
 assert.ok(css.includes(".auth-screen{min-height:0;overflow-y:auto"));
 assert.ok(css.includes(".auth-card input{min-width:0;font-size:16px}"));
 assert.ok(css.includes("@media(max-width:650px) and (max-height:560px)"));
 assert.ok(css.includes(".auth-card input:focus-visible"));
 assert.ok(css.includes("@media(prefers-reduced-motion:reduce)"));
});
