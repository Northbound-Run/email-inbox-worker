/**
 * Gmail → Pub/Sub Push verification.
 * Verifies Google-signed OIDC JWT (iss accounts.google.com, aud = push URL).
 */

export type GmailNotification = {
  emailAddress: string;
  historyId: number;
};

type JwtHeader = { kid?: string; alg?: string };
type JwtPayload = {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
};

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodeJwt(token: string): {
  header: JwtHeader;
  payload: JwtPayload;
  signingInput: string;
  sig: Uint8Array;
} {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid JWT");
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]))) as JwtHeader;
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as JwtPayload;
  return {
    header,
    payload,
    signingInput: `${parts[0]}.${parts[1]}`,
    sig: b64urlToBytes(parts[2]),
  };
}

async function getJwk(kid: string): Promise<JsonWebKey> {
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const data = (await res.json()) as { keys: Array<JsonWebKey & { kid?: string }> };
  const jwk = data.keys.find((k) => k.kid === kid);
  if (!jwk) throw new Error(`JWKS: kid ${kid} not found`);
  return jwk;
}

function audMatches(aud: string | string[] | undefined, expected: string): boolean {
  if (!aud) return false;
  if (typeof aud === "string") return aud === expected;
  return aud.includes(expected);
}

/** Verify Authorization: Bearer <google-oidc-jwt> for Pub/Sub Push. */
export async function verifyPubSubOidc(
  authHeader: string | null,
  expectedAudience: string,
): Promise<boolean> {
  if (!authHeader?.toLowerCase().startsWith("bearer ")) return false;
  const token = authHeader.slice(7).trim();
  const { header, payload, signingInput, sig } = decodeJwt(token);
  if (header.alg !== "RS256" || !header.kid) return false;
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
    return false;
  }
  if (!audMatches(payload.aud, expectedAudience)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now - 30) return false;
  if (typeof payload.iat === "number" && payload.iat > now + 60) return false;

  const jwk = await getJwk(header.kid);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    sig,
    new TextEncoder().encode(signingInput),
  );
}

export function decodeGmailNotification(data: string): GmailNotification {
  let json: string;
  try {
    // Pub/Sub message.data is standard base64
    json = atob(data);
  } catch {
    json = data;
  }
  let obj: { emailAddress?: string; historyId?: number | string };
  try {
    obj = JSON.parse(json);
  } catch {
    // try base64url
    const pad = "=".repeat((4 - (data.length % 4)) % 4);
    const b64 = (data + pad).replace(/-/g, "+").replace(/_/g, "/");
    obj = JSON.parse(atob(b64));
  }
  if (!obj.emailAddress || obj.historyId == null) {
    throw new Error("invalid Gmail notification");
  }
  return {
    emailAddress: String(obj.emailAddress),
    historyId: Number(obj.historyId),
  };
}
