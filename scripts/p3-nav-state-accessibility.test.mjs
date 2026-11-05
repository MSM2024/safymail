import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=(p)=>readFileSync(new URL(p,import.meta.url),"utf8");
const web=read("../public/index.html");
const admin=read("../public/admin.html");
const css=read("../public/msm-mail-ui.css");
test("sidebar navigation communicates selected folder after changes",()=>{
 assert.ok(web.includes('data-folder="inbox" aria-current="page"'));
 assert.ok(web.includes('if(active)x.setAttribute("aria-current","page");else x.removeAttribute("aria-current");'));
 assert.ok(css.includes('.sidebar .folder[aria-current="page"]'));
});
test("admin active section updates accessible current state",()=>{
 assert.ok(admin.includes('data-tab="overview" class="active" aria-current="page"'));
 assert.ok(admin.includes('if(active)x.setAttribute("aria-current","page");else x.removeAttribute("aria-current");'));
 for(const section of ["accounts","domains","audit","configuration"])assert.ok(admin.includes('data-tab="'+section+'"'));
});
test("icon-only mobile actions stay accessible and main list status is announced",()=>{
 assert.ok(web.includes('id="logout" type="button" aria-label="Cerrar sesión" title="Cerrar sesión"'));
 assert.ok(web.includes('id="install-app" type="button" aria-label="Instalar aplicación" title="Instalar aplicación"'));
 assert.ok(web.includes('id="list-status" role="status" aria-live="polite"'));
 assert.ok(css.includes('.topbar #logout:focus-visible'));
 assert.ok(css.includes('@media(max-width:390px)'));
});
