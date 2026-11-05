import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html=readFileSync(new URL("../../public/index.html",import.meta.url),"utf8");
const start=html.indexOf("async function openMessage(m){");
const end=html.indexOf("function replyRecipients(",start);
assert.ok(start>=0&&end>start,"reader route markers must be present");
const reader=html.slice(start,end);

test("read-only account can render unread message if mark-read PATCH is forbidden",()=>{
 const patch=reader.indexOf('await api("/api/messages/"+encodeURIComponent(m.id),{method:"PATCH"');
 const localTry=reader.lastIndexOf("try{",patch);
 const catchPermission=reader.indexOf("}catch{",patch);
 const render=reader.indexOf("const h=document.createElement",patch);
 assert.ok(patch>=0&&localTry>=0&&catchPermission>patch&&render>catchPermission);
 assert.match(reader.slice(catchPermission,render),/read_only users may view messages/);
 assert.ok(reader.indexOf('x.is_read=1;m.is_read=1',patch)<catchPermission,"read flags update only after successful PATCH");
});
test("message metadata, body and attachments remain visible after rejected mark-read",()=>{
 assert.match(reader,/r\.append\(h\)/);
 assert.match(reader,/r\.append\(body\)/);
 assert.match(reader,/if\(d\.attachments\?\.length\)/);
});
