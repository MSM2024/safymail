import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
const css=readFileSync(new URL("../public/msm-mail-ui.css",import.meta.url),"utf8");
const composer=readFileSync(new URL("../public/msm-composer-r3.css",import.meta.url),"utf8");

test("P3 workspace preserves existing mailbox and composer controls",()=>{
 for(const id of ["messages","reader","search","compose","compose-modal","compose-form","draft-to","draft-cc","draft-bcc","draft-subject","draft-body","draft-files","save-draft","send-message","list-status"]){
  assert.ok(html.includes('id="'+id+'"'),"missing "+id);
 }
 assert.ok(html.includes('href="/msm-mail-ui.css"'));
 assert.ok(html.includes('href="/msm-composer-r3.css"'));
});
test("premium workspace styles apply to real list, reader and dialog selectors",()=>{
 for(const selector of [".list-head",".quick-filters",".message.unread",".message.active",".reader-head",".reader-body","#compose-modal .modal-head","#compose-modal .compose-footer"]){
  assert.ok(css.includes(selector+"{"),"missing "+selector);
 }
 assert.ok(css.includes("--msm-workspace-navy"));
 assert.ok(css.includes("--msm-workspace-border"));
});
test("mobile layout and real composer retain scroll, accessible inputs and safe heights",()=>{
 assert.ok(css.includes(".content.message-open .reader{display:flex}"));
 assert.ok(css.includes(".content.message-open .reader .mobile-back{display:inline-flex"));
 assert.ok(css.includes("#compose-modal .compose-form{min-height:0;overflow-y:auto"));
 assert.ok(css.includes("#compose-modal .compose-form input,#compose-modal .compose-form textarea{font-size:16px}"));
 assert.ok(css.includes("@media(max-width:650px) and (max-height:560px)"));
 assert.ok(composer.includes(".msm-contact-suggestions"));
 assert.ok(composer.includes(".msm-attachment-drop"));
});
test("keyboard focus and reduced motion remain supported",()=>{
 assert.ok(css.includes(".quick-filter:focus-visible"));
 assert.ok(css.includes(".btn:focus-visible"));
 assert.ok(css.includes("@media(prefers-reduced-motion:reduce)"));
});
