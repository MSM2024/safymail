import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const html=readFileSync(new URL("../../public/index.html",import.meta.url),"utf8");
const start=html.indexOf("async function restoreForwardAttachments(");
const end=html.indexOf("async function readOutboundAttachments(",start);
assert.ok(start>0&&end>start,"forward helper exists");
const body=html.slice(start,end).trim();
function setup(fetchImpl:(url:string,opts:any)=>Promise<any>,current=1){
 const fileInput:{files:any[];dispatchEvent:(event:any)=>void;changed:number}={
  files:[],changed:0,dispatchEvent(){this.changed++;}
 };
 const status={textContent:""},modal={open:true};
 class DT{items={add:(file:any)=>{this.files.push(file)}};files:any[]=[];}
 class MockFile{constructor(public readonly parts:unknown[],public readonly name:string,public readonly opts:any){}}
 const context:any={
  fetch:fetchImpl,
  draftGeneration:current,
  $:(id:string)=>id==="draft-files"?fileInput:id==="compose-modal"?modal:status,
  DataTransfer:DT,File:MockFile,Event:class{},
  encodeURIComponent,Number,Error
 };
 return {
  load:runInNewContext("("+body+")",context) as (files:any[],generation:number)=>Promise<void>,
  fileInput,status,modal,context
 };
}
test("forward adds only authorized originals, with credentials and no cache",async()=>{
 const accessed:any[]=[];
 const attachment={id:"file-id",filename:"document.pdf",size_bytes:5,content_type:"application/pdf"};
 const env=setup(async(url,opts)=>{
  accessed.push({url,opts});return {ok:true,headers:{get:()=> "application/pdf"},arrayBuffer:async()=>new Uint8Array([37,80,68,70,45]).buffer};
 });
 await env.load([attachment],1);
 assert.equal(env.fileInput.files.length,1);
 assert.equal(env.fileInput.files[0].name,"document.pdf");
 assert.equal(env.fileInput.changed,1);
 assert.deepEqual(JSON.parse(JSON.stringify(accessed)),[{url:"/api/attachments/file-id",opts:{credentials:"same-origin",cache:"no-store"}}]);
});
test("forward rejects excessive attachment sizes before fetching",async()=>{
 let requests=0;
 const env=setup(async()=>{requests++;throw Error("unexpected fetch");});
 await assert.rejects(env.load([{id:"x",filename:"large.pdf",size_bytes:6*1024*1024}],1),/5 MB/);
 assert.equal(requests,0);
 assert.equal(env.fileInput.files.length,0);
});
test("forward aborts stale composer fetch without modifying the file input",async()=>{
 const env=setup(async()=>({ok:true,headers:{get:()=> "application/pdf"},
  arrayBuffer:async()=>new Uint8Array([37,80,68,70,45]).buffer
 }),2);
 await env.load([{id:"x",filename:"document.pdf",size_bytes:5}],1);
 assert.equal(env.fileInput.files.length,0);
});
test("UI waits for original downloads before send and blocks incomplete forwards",()=>{
 const send=html.split("async function sendMessage(){")[1]?.split("async function saveDraft(")[0]||"";
 const forward=html.split("function replyMessage(message,mode,originalAttachments=[])")[1]?.split("let draftId=null")[0]||"";
 assert.match(html,/\$\("forward"\)\.onclick=\(\)=>replyMessage\(x,"forward",d\.attachments\|\|\[\]\)/);
 assert.match(forward,/forwardAttachmentLoading=true/);
 assert.match(forward,/forwardAttachmentError=error\.message/);
 assert.match(send,/if\(forwardAttachmentLoading\)/);
 assert.match(send,/if\(forwardAttachmentError\)/);
});
