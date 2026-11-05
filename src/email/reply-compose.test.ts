import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html=readFileSync(new URL("../../public/index.html",import.meta.url),"utf8");
const start=html.indexOf("function replyRecipients(message, mailboxAddress, mode){");
const end=html.indexOf("function replyMessage(message,mode",start);
assert.ok(start>=0 && end>start,"recipient helper must exist");
const getRecipients=runInNewContext("("+html.slice(start,end).trim()+")") as
  (m:Record<string,unknown>,self:string,mode:string)=>{to:string[];cc:string[]};
const result=(m:Record<string,unknown>,mode:string)=>JSON.parse(JSON.stringify(
  getRecipients(m,"ceo@msmmystore.com",mode)));

test("outbound Reply addresses actual recipient rather than sender's own account",()=>{
 const m={direction:"outbound",from_address:"ceo@msmmystore.com",to_addresses:'["client@example.com"]'};
 assert.deepEqual(result(m,"reply"),{to:["client@example.com"],cc:[]});
});
test("inbound Reply uses sender and avoids copying original recipients",()=>{
 const m={direction:"inbound",from_address:"Customer <client@example.com>",to_addresses:'["ceo@msmmystore.com","colleague@example.com"]',cc_addresses:'["cc@example.com"]'};
 assert.deepEqual(result(m,"reply"),{to:["client@example.com"],cc:[]});
});
test("Reply All preserves external CC and recipients, excluding own address and duplicates",()=>{
 const m={direction:"inbound",from_address:"Customer <client@example.com>",
  to_addresses:'["ceo@msmmystore.com","colleague@example.com","client@example.com"]',
  cc_addresses:'["cc@example.com","COLLEAGUE@example.com","ceo@msmmystore.com"]'};
 assert.deepEqual(result(m,"replyAll"),{to:["client@example.com"],cc:["colleague@example.com","cc@example.com"]});
});
test("outbound Reply All retains original external recipients and CC only",()=>{
 const m={direction:"outbound",from_address:"ceo@msmmystore.com",
   to_addresses:'["client@example.com","peer@example.com"]',
   cc_addresses:'["ceo@msmmystore.com","manager@example.com","CLIENT@example.com"]'};
 assert.deepEqual(result(m,"replyAll"),{to:["client@example.com","peer@example.com"],cc:["manager@example.com"]});
});
test("composer reply buttons and reference headers remain connected",()=>{
 assert.match(html,/id="reply-all">Responder a todos/);
 assert.match(html,/\$\("reply-all"\)\.onclick=\(\)=>replyMessage\(x,"replyAll"\)/);
 assert.match(html,/state\.replyHeaders=\{\.\.\.\(message\.message_id_header\?\{in_reply_to:message\.message_id_header\}/);
});
