import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const page=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const css=readFileSync(new URL("../public/msm-mail-ui.css",import.meta.url),"utf8");
test("P3 overrides are loaded by existing mail page, not a separate route",()=>{
 assert.ok(page.includes('href="/msm-mail-ui.css"'));
 assert.ok(page.includes('href="/msm-composer-r3.css"'));
});
test("message reader retains an actual back button and mobile visibility override",()=>{
 assert.ok(page.includes('back.className="btn mobile-back"'));
 assert.ok(page.includes('classList.remove("message-open")'));
 assert.match(css,/\.content\.message-open \.reader \.mobile-back\{display:inline-flex/);
 assert.match(css,/\.content\.message-open \.list-panel\{display:none/);
 assert.match(css,/\.content\.message-open \.reader\{display:flex/);
});
test("short-height, mobile and desktop layouts avoid clipped login and workspace",()=>{
 assert.ok(css.includes(".app{min-height:0}"));
 assert.ok(css.includes(".auth-screen{min-height:0;overflow-y:auto"));
 assert.ok(css.includes(".auth-card input{min-width:0;font-size:16px}"));
 assert.ok(css.includes("@media(max-width:650px) and (max-height:560px)"));
 assert.ok(css.includes("height:calc(100dvh - 58px)"));
});
test("preserve reduced-motion and keyboard accessibility",()=>{
 assert.ok(css.includes(".mobile-back{display:none}"));
 assert.ok(css.includes("@media(prefers-reduced-motion:reduce)"));
 assert.ok(css.includes(".search:focus-visible"));
});
