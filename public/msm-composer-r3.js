/* MSM MAIL · Composer enhancements R3: account-scoped contact suggestions and attachments. */
(()=>{
"use strict";
const ids=["draft-to","draft-cc","draft-bcc"];
const fileInput=document.getElementById("draft-files");
const form=document.getElementById("compose-form");
const status=document.getElementById("draft-status");
if(!fileInput||!form)return;
let companyId="",queryEpoch=0,openList=null;
const allowed=new Set(["pdf","docx","jpg","jpeg","png","gif","webp"]);
const maxCount=5,maxFile=5*1024*1024,maxTotal=10*1024*1024;
function announce(message){if(status)status.textContent=message;}
function clearList(){
 if(openList){openList.list.replaceChildren();openList.list.hidden=true;openList=null;}
}
document.addEventListener("msm:mail-account-selected",event=>{
 companyId=String(event.detail?.company_id||"");
 queryEpoch++;
 clearList();
});
function currentToken(input){
 const start=Math.max(input.value.lastIndexOf(",",input.selectionStart-1),input.value.lastIndexOf(";",input.selectionStart-1),input.value.lastIndexOf("\n",input.selectionStart-1))+1;
 return {start,term:input.value.slice(start,input.selectionStart).trim()};
}
for(const id of ids){
 const input=document.getElementById(id);if(!input)return;
 const host=input.parentElement;host.classList.add("msm-recipient-host");
 input.setAttribute("autocomplete","off");
 input.setAttribute("aria-autocomplete","list");
 const list=document.createElement("div");list.id=id+"-suggestions";list.className="msm-contact-suggestions";list.setAttribute("role","listbox");list.hidden=true;
 input.setAttribute("aria-controls",list.id);
 host.append(list);
 let timeout=null,items=[],active=0;
 function choose(contact){
   const token=currentToken(input);
   const end=input.selectionStart;
   const after=input.value.slice(end);
   const separator=after.trimStart().match(/^[,;\n]/)?"":", ";
   input.value=input.value.slice(0,token.start)+contact.email+separator+after;
   const pos=token.start+contact.email.length+separator.length;
   input.focus();input.setSelectionRange(pos,pos);
   input.dispatchEvent(new Event("input",{bubbles:true}));
   clearList();
 }
 function render(rows){
   list.replaceChildren();items=rows;active=0;
   rows.forEach((contact,index)=>{
     const button=document.createElement("button");button.type="button";button.className="msm-contact-suggestion";
     button.setAttribute("role","option");button.setAttribute("aria-selected",String(index===0));
     const name=document.createElement("strong");name.textContent=contact.display_name||contact.email;
     const address=document.createElement("small");address.textContent=contact.email;
     button.append(name,address);
     button.addEventListener("mousedown",event=>event.preventDefault());
     button.addEventListener("click",()=>choose(contact));
     list.append(button);
   });
   list.hidden=rows.length===0;
   openList=rows.length?{list,input}:null;
 }
 async function search(){
   const term=currentToken(input).term;
   const epoch=++queryEpoch;
   if(!companyId||term.length<2||term.length>120||!/^[\w.+@-]+$/i.test(term)){clearList();return;}
   try{
     const params=new URLSearchParams({company_id:companyId,q:term,limit:"12"});
     const response=await fetch("/api/contacts?"+params.toString(),{credentials:"same-origin",cache:"no-store"});
     if(!response.ok)throw Error("lookup_failed");
     const data=await response.json();
     if(epoch!==queryEpoch||document.activeElement!==input)return;
     const rows=(Array.isArray(data.contacts)?data.contacts:[])
       .filter(contact=>contact.company_id===companyId&&typeof contact.email==="string")
       .slice(0,8);
     render(rows);
   }catch{if(epoch===queryEpoch)clearList();}
 }
 input.addEventListener("input",()=>{
   clearTimeout(timeout);clearList();timeout=setTimeout(search,220);
 });
 input.addEventListener("keydown",event=>{
   if(list.hidden||!items.length)return;
   if(event.key==="Escape"){event.preventDefault();clearList();}
   if(event.key==="ArrowDown"||event.key==="ArrowUp"){
     event.preventDefault();active=(active+(event.key==="ArrowDown"?1:-1)+items.length)%items.length;
     [...list.children].forEach((button,index)=>button.setAttribute("aria-selected",String(index===active)));
   }
   if(event.key==="Enter"){
     event.preventDefault();choose(items[active]);
   }
 });
 input.addEventListener("blur",()=>setTimeout(()=>{if(openList?.input===input)clearList();},140));
}
function validateFiles(files){
 if(files.length>maxCount)return "Hasta cinco archivos por mensaje.";
 let total=0;
 for(const file of files){
   const extension=(file.name.split(".").pop()||"").toLowerCase();
   if(!allowed.has(extension))return "Formato no admitido: "+file.name;
   if(file.size>maxFile)return "Archivo superior a 5 MB: "+file.name;
   total+=file.size;
 }
 if(total>maxTotal)return "El total de adjuntos supera 10 MB.";
 return "";
}
const uploadLabel=fileInput.closest("label");
if(!uploadLabel)return;
const drop=document.createElement("div");drop.className="msm-attachment-drop";
drop.tabIndex=0;drop.setAttribute("role","button");
drop.setAttribute("aria-label","Adjuntar archivos o soltarlos aquí");
drop.textContent="Arrastra archivos aquí o pulsa para seleccionarlos";
uploadLabel.after(drop);
const selected=document.createElement("div");selected.className="msm-attachment-selected";drop.after(selected);
drop.addEventListener("click",()=>fileInput.click());
drop.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();fileInput.click();}});
for(const name of ["dragenter","dragover"]){
 drop.addEventListener(name,event=>{event.preventDefault();drop.classList.add("msm-drag-over");});
}
for(const name of ["dragleave","drop"])drop.addEventListener(name,()=>drop.classList.remove("msm-drag-over"));
drop.addEventListener("drop",event=>{
 event.preventDefault();
 const files=[...fileInput.files,...Array.from(event.dataTransfer?.files||[])];
 const reason=validateFiles(files);if(reason){announce(reason);return;}
 try{
   const transfer=new DataTransfer();
   files.forEach(file=>transfer.items.add(file));
   fileInput.files=transfer.files;
   fileInput.dispatchEvent(new Event("change",{bubbles:true}));
 }catch{announce("Selecciona los archivos con el botón del formulario.");}
});
function renderFiles(){
 selected.replaceChildren();
 const files=Array.from(fileInput.files||[]);
 const reason=validateFiles(files);
 if(reason)announce(reason);
 files.forEach((file,index)=>{
   const chip=document.createElement("span");chip.className="msm-attachment-chip";
   const name=document.createElement("span");name.textContent=file.name+" · "+(file.size/1024/1024).toFixed(2)+" MB";
   const remove=document.createElement("button");remove.type="button";remove.textContent="×";
   remove.setAttribute("aria-label","Quitar archivo "+file.name);
   remove.addEventListener("click",()=>{
     try{
       const transfer=new DataTransfer();
       files.forEach((item,n)=>{if(n!==index)transfer.items.add(item);});
       fileInput.files=transfer.files;
       fileInput.dispatchEvent(new Event("change",{bubbles:true}));
     }catch{announce("Para quitar archivos, vuelve a seleccionarlos.");}
   });
   chip.append(name,remove);selected.append(chip);
 });
}
fileInput.addEventListener("change",renderFiles);
document.getElementById("compose-modal")?.addEventListener("close",()=>{
 queryEpoch++;clearList();selected.replaceChildren();
});
})();
