import { Router, type IRouter } from "express";
import { OAuth2Client } from "google-auth-library";
import {
  createSessionCookie,
  getSessionCookieName,
  isSessionConfigured,
  readSession,
  type SessionUser,
} from "../lib/session";

const router: IRouter = Router();

const googleClientId = process.env["GOOGLE_CLIENT_ID"] ?? "";
const cookieName = getSessionCookieName();
const googleClient = googleClientId
  ? new OAuth2Client(googleClientId)
  : null;

function getCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env["NODE_ENV"] === "production",
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 7,
  };
}

router.get("/auth/session", (req, res) => {
  const user = readSession(req.cookies?.[cookieName]);

  res.setHeader("Cache-Control", "no-store");
  res.json({
    googleClientId: googleClientId || null,
    sessionConfigured: isSessionConfigured(),
    user,
  });
});

router.post("/auth/google", async (req, res) => {
  if (!googleClientId || !googleClient) {
    res.status(503).json({
      error: "Google sign-in is not configured on this server.",
    });
    return;
  }

  if (!isSessionConfigured()) {
    res.status(503).json({
      error: "Session signing is not configured on this server.",
    });
    return;
  }

  const credential = req.body?.credential;
  if (typeof credential !== "string" || !credential) {
    res.status(400).json({ error: "Missing Google credential." });
    return;
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: googleClientId,
    });
    const payload = ticket.getPayload();

    if (!payload?.sub || !payload.email || !payload.name) {
      res.status(401).json({ error: "Invalid Google identity payload." });
      return;
    }

    const user: SessionUser = {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture ?? undefined,
      emailVerified: payload.email_verified ?? false,
    };

    res.cookie(cookieName, createSessionCookie(user), getCookieOptions());
    res.setHeader("Cache-Control", "no-store");
    res.json({ user });
  } catch {
    res.status(401).json({ error: "Google credential verification failed." });
  }
});

router.post("/auth/logout", (_req, res) => {
  res.clearCookie(cookieName, getCookieOptions());
  res.setHeader("Cache-Control", "no-store");
  res.status(204).end();
});

export default router;
