import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
function segment(a,b){const start=html.indexOf(a),end=html.indexOf(b,start+a.length);assert.ok(start>=0&&end>start);return html.slice(start,end);}
test("mailbox search rejects results from superseded requests",()=>{
 const load=segment("async function load(){","async function loadMore(){");
 assert.match(load,/const requestEpoch=\+\+listRequestEpoch/);
 assert.match(load,/if\(requestEpoch!==listRequestEpoch\)return;state\.messages=/);
 assert.match(load,/if\(requestEpoch===listRequestEpoch\)error/);
 assert.match(load,/\$\("load-more"\)\.disabled=false/);
});
test("pagination cannot append stale data or restore disabled buttons on new query",()=>{
 const more=segment("async function loadMore(){","async function selectAccount(a)");
 assert.match(more,/const requestEpoch=listRequestEpoch/);
 assert.match(more,/if\(requestEpoch!==listRequestEpoch\)return;state\.messages\.push/);
 assert.match(more,/if\(requestEpoch===listRequestEpoch\)\$\("list-status"\)\.textContent/);
 assert.match(more,/finally\{if\(requestEpoch===listRequestEpoch\)/);
});
test("Escape closes mobile sidebar and restores trigger focus and aria state",()=>{
 assert.ok(html.includes('event.key!=="Escape"||!$("sidebar").classList.contains("open")'));
 assert.ok(html.includes('$("menu").setAttribute("aria-expanded","false")'));
 assert.ok(html.includes('$("menu").focus();'));
});
test("existing mailbox, compose and login APIs remain connected",()=>{
 for(const item of ['/api/messages?','/api/auth/login','id="compose-modal"','id="auth-screen"','id="reader"']){
  assert.ok(html.includes(item),item);
 }
});
