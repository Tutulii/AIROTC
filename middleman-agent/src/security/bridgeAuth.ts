import crypto from "crypto";

export const TEST_BRIDGE_SECRET = "test-bridge-secret";

const DISALLOWED_BRIDGE_SECRETS = new Set([
  "meridian-bridge-secret-change-in-production",
  "change-me",
  "changeme",
  "bridge-secret",
  "default-bridge-secret",
  "test-bridge-secret",
]);

export type BridgeSecretResolution =
  | { ok: true; secret: string }
  | { ok: false; status: number; reason: string };

export type BridgeVerification =
  | { valid: true }
  | { valid: false; status: number; reason: string };

export function resolveBridgeSecret(): BridgeSecretResolution {
  const configured = process.env.BRIDGE_SECRET?.trim();

  if (!configured) {
    if (process.env.NODE_ENV === "test") {
      return { ok: true, secret: TEST_BRIDGE_SECRET };
    }
    return {
      ok: false,
      status: 503,
      reason: "Bridge authentication is not configured",
    };
  }

  if (DISALLOWED_BRIDGE_SECRETS.has(configured) && process.env.NODE_ENV !== "test") {
    return {
      ok: false,
      status: 503,
      reason: "Bridge secret uses a known placeholder value",
    };
  }

  if (process.env.NODE_ENV === "production" && configured.length < 32) {
    return {
      ok: false,
      status: 503,
      reason: "Bridge secret is too short for production",
    };
  }

  return { ok: true, secret: configured };
}

export function signBridgePayload(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body: string,
): string {
  const payload = `${timestamp}:${method.toUpperCase()}:${path}:${body}`;
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyBridgeRequest(
  method: string,
  path: string,
  body: string,
  signature: string | undefined,
  timestamp: string | undefined,
): BridgeVerification {
  const secret = resolveBridgeSecret();
  if (!secret.ok) {
    return { valid: false, status: secret.status, reason: secret.reason };
  }

  if (!signature || !timestamp) {
    return { valid: false, status: 401, reason: "Missing bridge authentication headers" };
  }

  const now = Date.now();
  const reqTime = parseInt(timestamp, 10);
  if (Number.isNaN(reqTime) || Math.abs(now - reqTime) > 30000) {
    return { valid: false, status: 401, reason: "Bridge timestamp expired" };
  }

  const expected = signBridgePayload(secret.secret, timestamp, method, path, body);
  if (!/^[a-f0-9]{64}$/i.test(signature) || signature.length !== expected.length) {
    return { valid: false, status: 401, reason: "Invalid bridge signature format" };
  }

  const valid = crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  return valid
    ? { valid: true }
    : { valid: false, status: 401, reason: "Invalid bridge signature" };
}
