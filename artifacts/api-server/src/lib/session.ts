import crypto from "node:crypto";

const SESSION_COOKIE = "svms_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const DEFAULT_DEV_SECRET = "dev-session-secret-change-me";

export type SessionUser = {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  emailVerified: boolean;
};

type SessionPayload = {
  exp: number;
  user: SessionUser;
};

const sessionSecret =
  process.env["SESSION_SECRET"] ?? DEFAULT_DEV_SECRET;

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sign(value: string): string {
  return base64url(
    crypto.createHmac("sha256", sessionSecret).update(value).digest(),
  );
}

function encode(payload: SessionPayload): string {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

function decode(rawCookie: string | undefined): SessionPayload | null {
  if (!rawCookie) {
    return null;
  }

  const [body, signature] = rawCookie.split(".");
  if (!body || !signature || sign(body) !== signature) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as SessionPayload;

    if (!payload.exp || Date.now() > payload.exp) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE;
}

export function createSessionCookie(user: SessionUser): string {
  return encode({
    exp: Date.now() + SESSION_TTL_MS,
    user,
  });
}

export function readSession(rawCookie: string | undefined): SessionUser | null {
  return decode(rawCookie)?.user ?? null;
}

export function isSessionConfigured(): boolean {
  return Boolean(process.env["SESSION_SECRET"]) || process.env["NODE_ENV"] !== "production";
}
