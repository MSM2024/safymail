import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Script} from "node:vm";
const read=p=>readFileSync(new URL(p,import.meta.url),"utf8");
const web=read("../public/index.html"),admin=read("../public/admin.html");
const icons=read("../public/msm-mail-ui.js"),css=read("../public/msm-mail-ui.css");
test("icon enhancement script compiles and is present in both applications",()=>{
 assert.doesNotThrow(()=>new Script(icons,{filename:"msm-mail-ui.js"}));
 assert.match(web,/<script src="\/msm-mail-ui\.js" defer><\/script>/);
 assert.match(admin,/<script src="\/msm-mail-ui\.js" defer><\/script>/);
 assert.ok(icons.includes('document.querySelectorAll("[data-msm-icon]")'));
 assert.ok(icons.includes('new MutationObserver(refresh)'));
});
test("all platform icon placeholders map to a real SVG drawing",()=>{
 const keys=[...web.matchAll(/data-msm-icon="([^"]+)"/g),...admin.matchAll(/data-msm-icon="([^"]+)"/g)].map(x=>x[1]);
 assert.ok(keys.length>=16);
 for(const key of keys)assert.ok(icons.includes(key+":'")||icons.includes("'"+key+"':'"),"missing SVG path for "+key);
 assert.ok(icons.includes('aria-hidden="true" focusable="false"'));
 assert.ok(icons.includes('stroke="currentColor"'));
});
test("admin navigation has unified SVG labels rather than invented glyphs",()=>{
 for(const key of ["overview","companies","domains","accounts","aliases","users","access-hosts","audit","configuration"]){
  assert.ok(admin.includes('data-tab="'+key+'"'),key);
  assert.ok(admin.includes('data-msm-icon="'+key+'"'),key);
 }
 assert.doesNotMatch(admin,/>[◫▦◎✉♙⌘◷⚙]　/);
});
test("webmail retains operational form IDs and usable search semantics",()=>{
 for(const id of ["search","compose","compose-form","compose-modal","messages","reader","contact-form","security-modal","logout","install-app"]){
  assert.ok(web.includes('id="'+id+'"'),id);
 }
 assert.ok(web.includes('class="msm-search-wrap"'));
 assert.ok(web.includes('data-msm-icon="search"'));
 assert.ok(css.includes('.msm-search-wrap .search'));
 assert.ok(css.includes('.message-flags .star.on svg'));
 assert.ok(css.includes('@media(max-width:390px)'));
});
test("dynamic message flags retain their actions and aria labels",()=>{
 assert.ok(web.includes('aria-label="Alternar destacado"'));
 assert.ok(web.includes('aria-label="Alternar importante"'));
 assert.ok(icons.includes('root.querySelectorAll(".message-flags .star")'));
 assert.ok(icons.includes('root.querySelectorAll(".message-flags .important")'));
});
