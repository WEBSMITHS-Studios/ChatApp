import type { NextApiRequest, NextApiResponse } from "next";
import { createSession, normalizeEmail, setSessionCookie, touchUserActivity, verifyPassword } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { getAccountStorageUsed } from "@/lib/uploads";
import { isSiteAdminEmail } from "@/lib/siteAdmin";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const email = normalizeEmail(String(req.body.email ?? ""));
  const password = String(req.body.password ?? "");
  const limit = checkRateLimit(`signin:${email || req.socket.remoteAddress}`, 10, 15 * 60 * 1000);
  if (!limit.allowed) return res.status(429).json({ error: "Too many signin attempts" });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const session = await createSession(user.id);
  await touchUserActivity(user.id);
  setSessionCookie(res, session.token, session.expiresAt);
  return res.status(200).json({
    user: {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      storageUsedBytes: await getAccountStorageUsed(user.id),
      isSiteAdmin: isSiteAdminEmail(user.email)
    }
  });
}
