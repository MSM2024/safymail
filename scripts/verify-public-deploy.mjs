import { pathToFileURL } from "node:url";

export const EXPECTED = "La sesión se protege con una cookie segura y expira a las 12 horas o tras 2 horas de inactividad.";
export const OLD = "La sesión se mantiene protegida mediante una cookie segura y expira después de 30 días.";
export const TARGET = "https://mailme.msmmystore.com/";

export function classify(html) {
  if (typeof html !== "string") return "invalid";
  if (html.includes(EXPECTED)) return "current";
  if (html.includes(OLD)) return "stale";
  return "unknown";
}

export async function verify(target = TARGET, fetchFn = fetch) {
  const url = new URL(target);
  if (url.protocol !== "https:" || url.hostname !== "mailme.msmmystore.com" || url.username || url.password || url.pathname !== "/" || url.search) {
    throw new Error("Target must be https://mailme.msmmystore.com/");
  }
  const response = await fetchFn(url.toString(), {
    method: "GET", redirect: "manual", cache: "no-store",
    headers: { Accept: "text/html", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) return { result: "http-error", status: response.status };
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/html")) return { result: "unexpected-content-type", status: response.status };
  const html = await response.text();
  return {
    result: classify(html), status: response.status,
    cacheControl: response.headers.get("cache-control") || "not-reported",
    cfCacheStatus: response.headers.get("cf-cache-status") || "not-reported",
    etag: response.headers.get("etag") || "not-reported",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verify();
    console.log("MSM MAIL public deployment check:", JSON.stringify(result));
    if (result.result !== "current") {
      console.error("P1-01 BLOCKED: this check does not establish deployed Worker SHA or authenticated E2E readiness.");
      process.exitCode = 1;
    } else {
      console.log("Public login copy matches main; confirm deployed SHA and the remaining P1 E2E gates separately.");
    }
  } catch (error) {
    console.error("P1-01 BLOCKED: public deployment fetch unavailable:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
