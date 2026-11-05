import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const css=readFileSync(new URL("../public/msm-mail-ui.css",import.meta.url),"utf8");
const admin=readFileSync(new URL("../public/admin.html",import.meta.url),"utf8");
test("message rows can be activated from keyboard without capturing nested star actions",()=>{
 assert.ok(html.includes('el.tabIndex=0;el.setAttribute("aria-label"'));
 assert.ok(html.includes('if(e.target!==el)return;'));
 assert.ok(html.includes('e.key==="Enter"||e.key===" "'));
 assert.ok(html.includes('e.preventDefault();openMessage(m);'));
 assert.ok(html.includes('e.stopPropagation();toggle(m,{is_starred:!m.is_starred})'));
 assert.ok(css.includes('.message[tabindex="0"]:focus-visible'));
});
test("mobile drawer exposes expanded state and closes on navigation",()=>{
 assert.ok(html.includes('aria-controls="sidebar" aria-expanded="false"'));
 assert.ok(html.includes('$("menu").setAttribute("aria-expanded",String(open))'));
 const closed='$("menu").setAttribute("aria-expanded","false")';
 assert.ok(html.split(closed).length>=3,"account and folder selection must close the drawer");
 assert.ok(css.includes('#menu{min-width:44px;min-height:44px'));
});
test("preserve premium auth, composer and admin baseline contracts",()=>{
 for(const id of ["auth-screen","mfa-form","compose-modal","reader","messages","contact-form","security-modal"]){
  assert.ok(html.includes('id="'+id+'"'),id);
 }
 for(const id of ["tabs","notice","create-form","data"]){
  assert.ok(admin.includes('id="'+id+'"'),id);
 }
 assert.ok(css.includes('@media(prefers-reduced-motion:reduce)'));
});
