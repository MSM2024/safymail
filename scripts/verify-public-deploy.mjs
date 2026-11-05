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

export function classifyRedirect(response, requestUrl) {
  if (response.status !== 301 && response.status !== 302 && response.status !== 307 && response.status !== 308) return null;
  const location = response.headers.get("location");
  if (!location) return "redirect-missing-location";
  try {
    const redirected = new URL(location, requestUrl);
    const expected = new URL(TARGET);
    const original = new URL(requestUrl);
    // A canonical redirect may preserve or drop only the controlled test query.
    const probeQuery = "?msm_p1_probe=20261105";
    const allowedQuery = original.pathname === "/index.html" && original.search === probeQuery;
    const safeQuery = redirected.search === "" || (allowedQuery && redirected.search === probeQuery);
    return redirected.origin === expected.origin && redirected.pathname === "/" && !redirected.username && !redirected.password && !redirected.hash && safeQuery
      ? "canonical-redirect" : "unexpected-redirect";
  } catch {
    return "invalid-redirect";
  }
}

export async function comparePublicShells(fetchFn = fetch) {
  // Fixed-origin read-only probes; query parameters can be normalized by cache rules.
  const paths = ["/", "/index.html", "/index.html?msm_p1_probe=20261105"];
  const results = [];
  for (const path of paths) {
    const target = new URL(path, TARGET).toString();
    const response = await fetchFn(target, {
      method: "GET", redirect: "manual", cache: "no-store",
      headers: { Accept: "text/html", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(12000),
    });
    const text = response.ok && (response.headers.get("content-type") || "").toLowerCase().includes("text/html")
      ? await response.text() : "";
    const redirected = classifyRedirect(response, target);
    results.push({
      path, status: response.status,
      result: redirected || (response.ok ? classify(text) : "http-error"),
      cfCacheStatus: response.headers.get("cf-cache-status") || "not-reported",
      cacheControl: response.headers.get("cache-control") || "not-reported",
      age: response.headers.get("age") || "not-reported",
      redirectLocation: redirected ? response.headers.get("location") || "not-reported" : undefined,
    });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verify();
    console.log("MSM MAIL public deployment check:", JSON.stringify(result));
    const variants = await comparePublicShells();
    console.log("MSM MAIL multi-path cache diagnosis:", JSON.stringify(variants));
    if (result.result !== "current" || variants.some(item => item.result !== "current" && item.result !== "canonical-redirect")) {
      console.error("P1-01 BLOCKED: root HTML is stale, an unexpected response occurred, or public content differs from main. Confirm Worker deployment SHA and asset version before any targeted cache purge.");
      process.exitCode = 1;
    } else {
      console.log("Public login copy matches main on canonical routes (or /index.html redirects safely to /); verify deployed Worker SHA and authenticated E2E separately.");
    }
  } catch (error) {
    console.error("P1-01 BLOCKED: public deployment fetch unavailable:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
