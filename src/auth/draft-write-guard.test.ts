import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source=readFileSync(new URL("../index.ts",import.meta.url),"utf8");
function route(a:string,b:string){const x=source.indexOf(a),y=source.indexOf(b,x+a.length);assert.ok(x>=0&&y>x);return source.slice(x,y);}
for(const [label,start,end,action] of [
  ["delete",'app.delete("/api/drafts/:id"','app.post("/api/drafts"',"DELETE FROM messages"],
  ["update",'app.patch("/api/drafts/:id"','app.get("/api/contacts"',"UPDATE messages SET"]
] as const){
  test(`draft ${label} checks live mailbox permissions inside write`,()=>{
    const s=route(start,end);
    assert.match(s,/EXISTS \(/);
    assert.match(s,/ap\.account_id=ea\.id/);
    assert.match(s,/ap\.permission='read_write'/);
    assert.match(s,/ea\.company_id=\?/);
    assert.ok(s.includes(action));
    assert.match(s,/draft_not_found/);
    assert.match(s,/meta\.changes\?\?0/);
  });
}
