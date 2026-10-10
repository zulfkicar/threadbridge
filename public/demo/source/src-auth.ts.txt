export async function hmacValid(
  secret: string,
  signature: string,
  message: string,
  prefix: string,
) {
  if (!secret || !signature.startsWith(prefix)) return false;
  const hex = signature.slice(prefix.length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const bytes = Uint8Array.from(hex.match(/../g) || [], (x) => parseInt(x, 16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    bytes,
    new TextEncoder().encode(message),
  );
}
export async function validSlack(
  request: Request,
  raw: string,
  secret: string,
  now = Date.now(),
) {
  const timestamp = request.headers.get("x-slack-request-timestamp") || "";
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300
  )
    return false;
  return hmacValid(
    secret,
    request.headers.get("x-slack-signature") || "",
    `v0:${timestamp}:${raw}`,
    "v0=",
  );
}
export async function validJira(request: Request, raw: string, secret: string) {
  return hmacValid(
    secret,
    request.headers.get("x-hub-signature") || "",
    raw,
    "sha256=",
  );
}
