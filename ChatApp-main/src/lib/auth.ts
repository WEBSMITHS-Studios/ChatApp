import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "./db";

const SESSION_COOKIE = "websmiths_chatapp_session";
const SESSION_DAYS = 30;

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string) {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;

  const attempted = Buffer.from(scryptSync(password, salt, 64).toString("hex"), "hex");
  const expected = Buffer.from(hash, "hex");
  return attempted.length === expected.length && timingSafeEqual(attempted, expected);
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await prisma.userSession.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt
    }
  });

  return { token, expiresAt };
}

export function setSessionCookie(res: NextApiResponse, token: string, expiresAt: Date) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure}`
  );
}

export function clearSessionCookie(res: NextApiResponse) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function getSessionToken(req: NextApiRequest) {
  const cookie = req.headers.cookie;
  if (!cookie) return null;

  return (
    cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
      ?.split("=")[1] ?? null
  );
}

export async function getCurrentUser(req: NextApiRequest) {
  const token = getSessionToken(req);
  if (!token) return null;
  return getUserBySessionToken(token);
}

export async function getUserBySessionToken(token: string) {
  const session = await prisma.userSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true }
  });

  if (!session || session.expiresAt.getTime() <= Date.now()) {
    if (session) await prisma.userSession.delete({ where: { id: session.id } });
    return null;
  }

  return session.user;
}

export async function touchUserActivity(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { lastActiveAt: new Date() }
  });
}

export function getCookieValue(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return null;
  return (
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`))
      ?.split("=")[1] ?? null
  );
}

export const sessionCookieName = SESSION_COOKIE;
