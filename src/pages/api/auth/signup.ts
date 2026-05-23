import type { NextApiRequest, NextApiResponse } from "next";
import { createSession, hashPassword, normalizeEmail, setSessionCookie } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { sanitizeNickname } from "@/server/rooms";
import { isSiteAdminEmail } from "@/lib/siteAdmin";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const email = normalizeEmail(String(req.body.email ?? ""));
  const nickname = sanitizeNickname(String(req.body.nickname ?? ""));
  const password = String(req.body.password ?? "");

  const limit = checkRateLimit(`signup:${email || req.socket.remoteAddress}`, 5, 60 * 60 * 1000);
  if (!limit.allowed) return res.status(429).json({ error: "Too many signup attempts" });

  if (!email.includes("@") || email.length > 254) return res.status(400).json({ error: "Enter a valid email" });
  if (!nickname) return res.status(400).json({ error: "Nickname is required" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  try {
    const user = await prisma.user.create({
      data: {
        email,
        nickname,
        passwordHash: hashPassword(password)
      }
    });
    const session = await createSession(user.id);
    setSessionCookie(res, session.token, session.expiresAt);
    return res.status(201).json({ user: publicUser(user) });
  } catch {
    return res.status(409).json({ error: "An account with that email already exists" });
  }
}

function publicUser(user: { id: string; email: string; nickname: string }) {
  return { id: user.id, email: user.email, nickname: user.nickname, storageUsedBytes: 0, isSiteAdmin: isSiteAdminEmail(user.email) };
}
