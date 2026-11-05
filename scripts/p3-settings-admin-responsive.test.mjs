import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const mail=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const css=readFileSync(new URL("../public/msm-mail-ui.css",import.meta.url),"utf8");
const admin=readFileSync(new URL("../public/admin.html",import.meta.url),"utf8");

test("contacts preserve API and form controls while using responsive semantic rows",()=>{
 for(const id of ["contacts-modal","contact-form","contact-list","contact-status","contact-email","contact-name","contact-notes"])
   assert.ok(mail.includes('id="'+id+'"'),id);
 assert.ok(mail.includes('className="contact-item"'));
 assert.ok(mail.includes('className="contact-email"'));
 assert.ok(mail.includes('role="status" aria-live="polite"'));
 assert.ok(mail.includes('del.setAttribute("aria-label"'));
 assert.ok(mail.includes('/api/contacts'));
});
test("contacts and security dialogs support internal scrolling and small viewports",()=>{
 for(const target of ["#contacts-modal[open],#security-modal[open]","#security-modal .security-content",".contacts-content","#contact-list",".contact-item","#security-modal .security-secret"]){
  assert.ok(css.includes(target),target);
 }
 assert.ok(css.includes("max-height:calc(100dvh - 24px)"));
 assert.ok(css.includes("@media(max-width:650px)"));
 assert.ok(mail.includes('id="security-content"'));
 assert.ok(mail.includes('/api/security/totp/confirm'));
});
test("admin retains all original tabs and secure controls with mobile horizontal navigation",()=>{
 for(const tab of ["overview","companies","domains","accounts","aliases","users","access-hosts","audit","configuration"])
   assert.ok(admin.includes('data-tab="'+tab+'"'),tab);
 for(const id of ["notice","stats","dashboard-panel","settings-panel","create-panel","list-panel","data","logout"])
   assert.ok(admin.includes('id="'+id+'"'),id);
 assert.ok(admin.includes('role="region" tabindex="0" aria-label="Tabla de registros administrativos"'));
 assert.ok(admin.includes(".admin-app .tabs{display:flex;gap:5px;overflow-x:auto"));
 assert.ok(admin.includes(".admin-app .table-wrap{"));
 assert.ok(admin.includes(".admin-app :is(button,input,select,a):focus-visible"));
});
