import type { NextApiRequest, NextApiResponse } from "next";
import { clearSessionCookie, getCurrentUser, getSessionToken, hashToken, touchUserActivity } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { sanitizeNickname } from "@/server/rooms";
import { getAccountStorageUsed } from "@/lib/uploads";
import { isSiteAdminEmail } from "@/lib/siteAdmin";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const user = await getCurrentUser(req);
    if (user) await touchUserActivity(user.id);
    const storageUsedBytes = user ? await getAccountStorageUsed(user.id) : 0;
    return res.status(200).json({
      user: user
        ? { id: user.id, email: user.email, nickname: user.nickname, storageUsedBytes, isSiteAdmin: isSiteAdminEmail(user.email) }
        : null
    });
  }

  if (req.method === "DELETE") {
    const token = getSessionToken(req);
    if (token) {
      await prisma.userSession.deleteMany({ where: { tokenHash: hashToken(token) } });
    }
    clearSessionCookie(res);
    return res.status(200).json({ ok: true });
  }

  if (req.method === "PATCH") {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Sign in first" });

    const nickname = sanitizeNickname(String(req.body.nickname ?? ""));
    if (!nickname) return res.status(400).json({ error: "Nickname is required" });

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { nickname }
    });

    await prisma.roomMember.updateMany({
      where: { identityId: `user:${user.id}` },
      data: { nickname }
    });

    return res.status(200).json({
      user: {
        id: updated.id,
        email: updated.email,
        nickname: updated.nickname,
        storageUsedBytes: await getAccountStorageUsed(updated.id),
        isSiteAdmin: isSiteAdminEmail(updated.email)
      }
    });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
