import type { Env } from "../types";
export interface ResendRelayResult { ok:boolean; status:number; providerId?:string; error?:string; }
export async function sendViaResendRelay(env:Env,payload:Record<string,unknown>,idempotencyKey:string):Promise<ResendRelayResult>{
 if(!env.CONTROL_PLANE_URL||!env.INSTALLATION_ID||!env.RESEND_RELAY_TOKEN)return{ok:false,status:503,error:"resend_relay_not_configured"};
 let endpoint:URL;
 try{endpoint=new URL("/internal/installations/"+encodeURIComponent(env.INSTALLATION_ID)+"/resend/send",env.CONTROL_PLANE_URL);if(endpoint.protocol!=="https:"&&endpoint.hostname!=="localhost"&&endpoint.hostname!=="127.0.0.1")return{ok:false,status:503,error:"resend_relay_https_required"};}catch{return{ok:false,status:503,error:"resend_relay_invalid_url"};}
 try{const transport = env.CONTROL_PLANE_SERVICE ? env.CONTROL_PLANE_SERVICE.fetch.bind(env.CONTROL_PLANE_SERVICE) : fetch;
 const response=await transport(endpoint.toString(),{method:"POST",headers:{Authorization:"Bearer "+env.RESEND_RELAY_TOKEN,"Content-Type":"application/json","Idempotency-Key":idempotencyKey},body:JSON.stringify(payload),redirect:"error",signal:AbortSignal.timeout(20000)});const result=await response.json().catch(()=>({} as any)) as {id?:string;error?:string};return response.ok&&typeof result.id==="string"?{ok:true,status:response.status,providerId:result.id}:{ok:false,status:response.status,error:typeof result.error==="string"?result.error:"resend_relay_failed"};}catch{return{ok:false,status:503,error:"resend_relay_unavailable"};}
}

export interface RelayConnectivityDiagnostic {
  reachable: boolean;
  bindingPresent: boolean;
  status?: number;
  errorType?: "timeout" | "type_error" | "abort" | "other";
}

// Read-only diagnostic: only GET /health. No message payload, token, or retry.
export async function diagnoseRelayConnectivity(env: Env): Promise<RelayConnectivityDiagnostic> {
  const bindingPresent = Boolean(env.CONTROL_PLANE_SERVICE);
  if (!env.CONTROL_PLANE_URL) return { reachable: false, bindingPresent, errorType: "other" };
  try {
    const url = new URL("/health", env.CONTROL_PLANE_URL);
    if (url.protocol !== "https:" || url.username || url.password) {
      return { reachable: false, bindingPresent, errorType: "other" };
    }
    const transport = env.CONTROL_PLANE_SERVICE
      ? env.CONTROL_PLANE_SERVICE.fetch.bind(env.CONTROL_PLANE_SERVICE)
      : fetch;
    const response = await transport(url.toString(), {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(5000)
    });
    const content = await response.json().catch(() => null) as {status?: string;service?: string} | null;
    return {
      reachable: response.ok && content?.status === "ok" && content?.service === "mail-center-control-plane",
      bindingPresent,
      status: response.status
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      reachable: false,
      bindingPresent,
      errorType: name === "TimeoutError" ? "timeout" : name === "TypeError" ? "type_error" : name === "AbortError" ? "abort" : "other"
    };
  }
}
