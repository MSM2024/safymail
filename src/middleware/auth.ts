import type { Context, MiddlewareHandler } from "hono";
import type { Env, AppVariables, AuthenticatedUser } from "../types";
type AppContext=Context<{Bindings:Env;Variables:AppVariables}>;
const SESSION_COOKIE="__Host-emc_session";
const SESSION_TTL_SECONDS=60*60*12;
const SESSION_IDLE_SECONDS=60*60*2;
const PBKDF2_ITERATIONS=100_000;
function base64Url(bytes:Uint8Array):string{return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");}
function fromBase64Url(value:string):Uint8Array{const normalized=value.replace(/-/g,"+").replace(/_/g,"/");return Uint8Array.from(atob(normalized+"=".repeat((4-normalized.length%4)%4)),c=>c.charCodeAt(0));}
async function digest(value:string):Promise<Uint8Array>{return new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));}
function constantTimeEqual(a:Uint8Array,b:Uint8Array):boolean{if(a.length!==b.length)return false;let mismatch=0;for(let i=0;i<a.length;i++)mismatch|=a[i]^b[i];return mismatch===0;}
export async function hashPassword(password:string):Promise<{hash:string;salt:string}>{
 const saltBytes=crypto.getRandomValues(new Uint8Array(16)),salt=base64Url(saltBytes),saltBuffer=new ArrayBuffer(saltBytes.byteLength);new Uint8Array(saltBuffer).set(saltBytes);
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveBits"]);
 const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt:saltBuffer,iterations:PBKDF2_ITERATIONS,hash:"SHA-256"},key,256);
 return{hash:base64Url(new Uint8Array(bits)),salt};
}
export async function verifyPassword(password:string,salt:string,expectedHash:string):Promise<boolean>{try{
 const saltBytes=fromBase64Url(salt),expected=fromBase64Url(expectedHash),saltBuffer=new ArrayBuffer(saltBytes.byteLength);new Uint8Array(saltBuffer).set(saltBytes);
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveBits"]);
 const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt:saltBuffer,iterations:PBKDF2_ITERATIONS,hash:"SHA-256"},key,256);
 return constantTimeEqual(new Uint8Array(bits),expected);
 }catch{return false;}}
function cookieValue(request:Request,name:string):string|null{for(const part of(request.headers.get("Cookie")||"").split(";")){const i=part.indexOf("=");if(i>=0&&part.slice(0,i).trim()===name)return part.slice(i+1).trim();}return null;}
export function getSessionToken(request:Request):string|null{const token=cookieValue(request,SESSION_COOKIE);return token&&/^[A-Za-z0-9_-]{40,64}$/.test(token)?token:null;}
export async function createSession(c:AppContext,userId:string,mfaVerified=false):Promise<void>{
 const token=base64Url(crypto.getRandomValues(new Uint8Array(32))),tokenHash=base64Url(await digest(token)),expiresAt=new Date(Date.now()+SESSION_TTL_SECONDS*1000).toISOString();
 await c.env.DB.prepare("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at,mfa_verified,last_seen_at) VALUES(?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
  .bind(crypto.randomUUID(),userId,tokenHash,expiresAt,mfaVerified?1:0).run();
 c.header("Set-Cookie",SESSION_COOKIE+"="+token+"; Path=/; Max-Age="+SESSION_TTL_SECONDS+"; HttpOnly; Secure; SameSite=Strict",{append:true});
}
export async function revokeSession(c:AppContext):Promise<void>{const token=getSessionToken(c.req.raw);if(token){const tokenHash=base64Url(await digest(token));await c.env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash=?").bind(tokenHash).run();}
 c.header("Set-Cookie",SESSION_COOKIE+"=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict",{append:true});}
export const requireSession:MiddlewareHandler<{Bindings:Env;Variables:AppVariables}>=async(c,next)=>{
 const token=getSessionToken(c.req.raw);if(!token)return c.json({error:"unauthorized",message:"Inicia sesión para continuar."},401);
 try{
  const tokenHash=base64Url(await digest(token));
  const row=await c.env.DB.prepare(`SELECT u.id,u.email,u.display_name,u.is_superadmin,s.mfa_verified
   FROM auth_sessions s JOIN users u ON u.id=s.user_id
   WHERE s.token_hash=? AND s.expires_at>? AND s.last_seen_at>? AND u.status='active' LIMIT 1`)
   .bind(tokenHash,new Date().toISOString(),new Date(Date.now()-SESSION_IDLE_SECONDS*1000).toISOString()).first<{id:string;email:string;display_name:string;is_superadmin:number;mfa_verified:number}>();
  if(!row)return c.json({error:"unauthorized",message:"La sesión expiró. Inicia sesión nuevamente."},401);
  await c.env.DB.prepare("UPDATE auth_sessions SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash=?").bind(tokenHash).run();
  c.set("user",{id:row.id,email:row.email,displayName:row.display_name,isSuperadmin:row.is_superadmin===1,mfaVerified:row.mfa_verified===1});
  await next();
 }catch{return c.json({error:"authentication_unavailable"},503);}
};
export async function getUserCompanies(c:AppContext,user:AuthenticatedUser){
 if(user.isSuperadmin){const result=await c.env.DB.prepare("SELECT id,name,slug,status FROM companies ORDER BY name").all();return result.results;}
 const result=await c.env.DB.prepare(`SELECT co.id,co.name,co.slug,co.status FROM companies co
  INNER JOIN company_memberships cm ON cm.company_id=co.id WHERE cm.user_id=? AND co.status='active' ORDER BY co.name`).bind(user.id).all();
 return result.results;
}
