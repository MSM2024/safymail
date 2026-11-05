// Resend webhook keys are standard Base64 with a whsec_ prefix.
// Validate without disclosing the signing key or storing malformed data.
export function isValidResendWebhookSecret(secret: string): boolean {
  if (!secret.startsWith("whsec_")) return false;
  const encoded = secret.slice(6);
  if (encoded.length < 16 || encoded.length > 512 || encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return false;
  try {
    return atob(encoded).length >= 16;
  } catch {
    return false;
  }
}
