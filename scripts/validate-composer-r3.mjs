import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Script} from "node:vm";
const page=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const js=readFileSync(new URL("../public/msm-composer-r3.js",import.meta.url),"utf8");
const css=readFileSync(new URL("../public/msm-composer-r3.css",import.meta.url),"utf8");
const backend=readFileSync(new URL("../src/index.ts",import.meta.url),"utf8");
new Script(js,{filename:"public/msm-composer-r3.js"});
for(const tag of [
  'src="/msm-composer-r3.js"',
  'href="/msm-composer-r3.css"',
  'msm:mail-account-selected'
])assert.ok(page.includes(tag),"Missing composer R3 integration: "+tag);
for(const token of [
  'company_id:companyId',
  'contact.company_id===companyId',
  'credentials:"same-origin"',
  'cache:"no-store"',
  'textContent=contact.email',
  'event.key==="ArrowDown"',
  'event.key==="Escape"',
  'new DataTransfer()',
  'maxCount=5,maxFile=5*1024*1024,maxTotal=10*1024*1024',
  'fileInput.dispatchEvent(new Event("change"'
])assert.ok(js.includes(token),"Missing composer R3 behavior: "+token);
assert.ok(css.includes("@media(max-width:650px)"),"Missing mobile-specific styles");
assert.ok(!js.includes("innerHTML"),"Contact output must be built with textContent, not HTML");
assert.ok(backend.includes("c.get(\"hostCompanyId\")||requestedCompanyId"),"Contact lookup must support explicit company scope on shared hosts");
assert.ok(backend.includes("SELECT 1 FROM company_memberships WHERE user_id=? AND company_id=?"),"Contact scope must be membership-authorized");
assert.ok(page.includes('new URLSearchParams({company_id:state.account?.company_id||""})'),"Contacts modal must use selected company");
console.log("MSM MAIL Composer R3: static contract and JS syntax PASS");
