/* MSM MAIL · UI restructuring round 1 · progressive enhancement */
(()=>{
"use strict";
const get=id=>document.getElementById(id);
const drawings={
  inbox:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h5l2 3h4l2-3h5"/>',
  sent:'<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  drafts:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L10 16l-4 1 1-4Z"/><path d="M3 21h18"/>',
  archive:'<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8M10 12h4"/>',
  spam:'<path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v4M12 17h.01"/>',
  trash:'<path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v7m4-7v7"/>',
  compose:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L10 16l-4 1 1-4Z"/>',
  contacts:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  expand:'<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3m8 5h3a2 2 0 0 0 2-2v-3"/>'
};
const icon=name=>'<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">'+drawings[name]+'</svg>';
function enhanceIcons(){
 document.querySelectorAll(".folder[data-folder]").forEach(button=>{
   const placeholder=button.querySelector(".folder-icon");
   if(placeholder&&drawings[button.dataset.folder])placeholder.innerHTML=icon(button.dataset.folder);
 });
 const contacts=get("contacts-open")?.querySelector(".folder-icon");
 if(contacts)contacts.innerHTML=icon("contacts");
 const compose=get("compose");
 if(compose&&!compose.querySelector("svg")){
   compose.innerHTML=icon("compose")+"<span>Redactar correo</span>";
   compose.setAttribute("aria-label","Redactar un mensaje");
 }
}
function enhanceComposer(){
 const dialog=get("compose-modal"),head=dialog?.querySelector(".modal-head");
 if(!dialog||!head||head.querySelector(".msm-compose-toolbar"))return;
 dialog.setAttribute("aria-label","Redactor de correo");
 const tools=document.createElement("div");tools.className="msm-compose-toolbar";
 const expand=document.createElement("button");
 expand.type="button";expand.title="Expandir redactor";
 expand.setAttribute("aria-label","Expandir redactor");
 expand.innerHTML=icon("expand");
 expand.addEventListener("click",()=>{
   const expanded=dialog.classList.toggle("msm-expanded");
   const title=expanded?"Reducir redactor":"Expandir redactor";
   expand.title=title;expand.setAttribute("aria-label",title);
 });
 tools.append(expand);
 const close=get("close-compose");
 if(close)head.insertBefore(tools,close);else head.append(tools);
 dialog.addEventListener("close",()=>{dialog.classList.remove("msm-expanded");expand.title="Expandir redactor";expand.setAttribute("aria-label",expand.title);});
 ["draft-to","draft-cc","draft-bcc"].forEach(id=>get(id)?.setAttribute("autocomplete","off"));
}
function main(){enhanceIcons();enhanceComposer();}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",main,{once:true});else main();
})();