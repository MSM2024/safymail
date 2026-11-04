const CACHE_NAME="europe-mail-shell-v1";
const SHELL_URLS=["/","/index.html","/manifest.webmanifest","/icons/europe-mail.svg","/icons/europe-mail-192.png","/icons/europe-mail-512.png"];
self.addEventListener("install",event=>{event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(SHELL_URLS)).then(()=>self.skipWaiting()));});
self.addEventListener("activate",event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith("europe-mail-shell-")&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener("fetch",event=>{
 const request=event.request;
 if(request.method!=="GET")return;
 const url=new URL(request.url);
 if(url.origin!==self.location.origin)return;
 if(url.pathname.startsWith("/api/")||url.pathname.startsWith("/admin")||url.pathname.startsWith("/api/attachments/"))return;
 if(request.mode==="navigate"){
  event.respondWith(fetch(request).then(response=>{
   if(response.ok&&response.type==="basic"){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put("/",copy));}
   return response;
  }).catch(async()=> (await caches.match("/"))||new Response("Sin conexión. Conéctate a Internet para consultar tu correo.",{status:503,headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}})));
  return;
 }
 if(url.pathname.startsWith("/icons/")||url.pathname==="/manifest.webmanifest"){
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));}return response;})));
 }
});
