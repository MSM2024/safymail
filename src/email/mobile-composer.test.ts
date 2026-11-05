import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const css=readFileSync(new URL("../../public/msm-mail-ui.css",import.meta.url),"utf8");
const mobile=css.slice(css.indexOf("/* P1 mobile viewport:"));
test("mobile composer uses dynamic viewport and safe-area insets",()=>{
 assert.match(mobile,/@media\(max-width:650px\)/);
 assert.match(mobile,/height:100dvh;max-height:100dvh/);
 assert.match(mobile,/safe-area-inset-top/);
 assert.match(mobile,/safe-area-inset-bottom/);
 assert.match(mobile,/overflow-y:auto;overflow-x:hidden/);
 assert.match(mobile,/overscroll-behavior:contain/);
});
test("mobile composer preserves touch targets and adapts short screens",()=>{
 assert.match(mobile,/min-height:44px/);
 assert.match(mobile,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
 assert.match(mobile,/@media\(max-width:650px\) and \(max-height:560px\)/);
 assert.match(mobile,/textarea\{min-height:92px;max-height:23dvh\}/);
});
