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
  expand:'<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3m8 5h3a2 2 0 0 0 2-2v-3"/>',
  overview:'<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
  companies:'<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V4h8v3M3 13h18M9 12v3h6v-3"/>',
  domains:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-5 5-5 13 0 18M12 3c5 5 5 13 0 18"/>',
  accounts:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 7 9-7"/>',
  aliases:'<path d="M7 17 17 7M8 7h9v9"/><path d="M4 12v7a1 1 0 0 0 1 1h7"/>',
  users:'<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 7h5M18.5 4.5v5"/>',
  hostnames:'<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 7h.01M7 18h.01M16 10v4"/>',
  'access-hosts':'<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 7h.01M7 18h.01M16 10v4"/>',
  audit:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  configuration:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1 1 0 0 0 .2 1.1l-1.2 2.1a1 1 0 0 0-1.1.4l-1.9-.4a7 7 0 0 1-2 .9l-.8 1.8h-2.4l-.8-1.8a7 7 0 0 1-2-.9l-1.9.4a1 1 0 0 0-1.1-.4l-1.2-2.1a1 1 0 0 0 .2-1.1L3 13a7 7 0 0 1 0-2l1.4-2a1 1 0 0 0-.2-1.1l1.2-2.1a1 1 0 0 0 1.1-.4l1.9.4a7 7 0 0 1 2-.9l.8-1.8h2.4l.8 1.8a7 7 0 0 1 2 .9l1.9-.4a1 1 0 0 0 1.1.4l1.2 2.1a1 1 0 0 0-.2 1.1l1.4 2a7 7 0 0 1 0 2Z"/>',
  menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  install:'<path d="M12 3v12m-4-4 4 4 4-4M4 17v3h16v-3"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/>',
  mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 7 9-7"/>',
  cloud:'<path d="M7 19h11a5 5 0 0 0 0-10h-.3A7 7 0 0 0 4 11a4 4 0 0 0 3 8Z"/>',
  star:'<path d="m12 2 3.1 6.3 7 .9-5 4.9 1.2 7-6.3-3.3-6.3 3.3 1.2-7-5-4.9 7-.9L12 2Z"/>',
  important:'<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/>',
  back:'<path d="m15 18-6-6 6-6"/>',
  close:'<path d="M18 6 6 18M6 6l12 12"/>',
  shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>'
};
const icon=name=>drawings[name]?'<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">'+drawings[name]+'</svg>':"";
function enhanceIcons(){
 document.querySelectorAll("[data-msm-icon]").forEach(slot=>{const name=slot.getAttribute("data-msm-icon");if(drawings[name]&&!slot.querySelector("svg"))slot.innerHTML=icon(name);});
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
function enhanceDynamicIcons(){
 for(const root of [get("messages"),get("reader")]){
  if(!root||root.dataset.msmIconObserver==="1")continue;
  root.dataset.msmIconObserver="1";
  const refresh=()=>{
   root.querySelectorAll(".empty-icon").forEach(el=>{if(!el.querySelector("svg"))el.innerHTML=icon("mail");});
   root.querySelectorAll(".message-flags .star").forEach(el=>{if(!el.querySelector("svg"))el.innerHTML=icon("star");});
   root.querySelectorAll(".message-flags .important").forEach(el=>{if(!el.querySelector("svg"))el.innerHTML=icon("important");});
  };
  refresh();new MutationObserver(refresh).observe(root,{childList:true,subtree:true});
 }
}
function main(){enhanceIcons();enhanceComposer();enhanceDynamicIcons();}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",main,{once:true});else main();
})();