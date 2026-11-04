export async function verifyResendWebhook(
  rawBody: string,
  request: Request,
  secret: string,
  nowMs = Date.now()
): Promise<boolean> {
  const id = request.headers.get("svix-id") || "";
  const timestamp = request.headers.get("svix-timestamp") || "";
  const signature = request.headers.get("svix-signature") || "";
  if (!id || id.length > 200 || !/^\d{10,12}$/.test(timestamp) || !signature) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(nowMs / 1000 - seconds) > 300) return false;

  try {
    const encodedSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
    const secretBytes = Uint8Array.from(atob(encodedSecret), char => char.charCodeAt(0));
    if (!secretBytes.length) return false;
    const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signed = new TextEncoder().encode(id + "." + timestamp + "." + rawBody);
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
    const expected = btoa(String.fromCharCode(...digest));
    const candidates = signature.split(/\s+/).map(part => part.trim())
      .filter(part => part.startsWith("v1,")).map(part => part.slice(3));
    return candidates.some(candidate => {
      if (candidate.length !== expected.length) return false;
      let mismatch = 0;
      for (let index = 0; index < expected.length; index++) {
        mismatch |= candidate.charCodeAt(index) ^ expected.charCodeAt(index);
      }
      return mismatch === 0;
    });
  } catch {
    return false;
  }
}
