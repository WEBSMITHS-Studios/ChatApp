import type { NextApiRequest, NextApiResponse } from "next";
import { getCurrentUser } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rateLimit";
import { createRoom, normalizeRoomType, sanitizeNickname } from "@/server/rooms";

type CreateRoomBody = {
  name?: string;
  type?: "DIRECT" | "GROUP";
  maxUsers?: number | null;
  expiresInHours?: number | null;
  creatorIdentityId?: string;
  creatorNickname?: string;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const ip = getClientIp(req);
  const limit = checkRateLimit(`room:${ip}`, 8, 60 * 60 * 1000);
  if (!limit.allowed) {
    return res.status(429).json({ error: "Too many rooms created recently" });
  }

  const body = req.body as CreateRoomBody;
  const currentUser = await getCurrentUser(req);
  let creatorNickname = sanitizeNickname(body.creatorNickname ?? "");
  let creatorIdentityId = String(body.creatorIdentityId ?? "").trim();

  if (creatorIdentityId.startsWith("user:")) {
    if (!currentUser || creatorIdentityId !== `user:${currentUser.id}`) {
      return res.status(401).json({ error: "Sign in again before creating a room" });
    }
    creatorNickname = currentUser.nickname;
  }

  if (!creatorIdentityId || !creatorNickname) {
    return res.status(400).json({ error: "Nickname is required" });
  }
  if (creatorIdentityId.length > 100) {
    return res.status(400).json({ error: "Invalid identity" });
  }

  const type = body.type === "DIRECT" ? "DIRECT" : "GROUP";
  const safeMaxUsers =
    type === "DIRECT"
      ? 2
      : typeof body.maxUsers === "number" && body.maxUsers >= 2
        ? Math.min(Math.floor(body.maxUsers), 500)
        : null;

  const expiresInHours =
    typeof body.expiresInHours === "number" && body.expiresInHours > 0
      ? Math.min(Math.floor(body.expiresInHours), 24 * 30)
      : null;

  const { room, ownerRecoveryCode } = await createRoom({
    name: (body.name?.trim() || (type === "DIRECT" ? "Private Chat" : "Group Chat")).slice(0, 80),
    type,
    maxUsers: safeMaxUsers,
    expiresAt: expiresInHours ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000) : null,
    creatorIdentityId,
    creatorNickname
  });

  return res.status(201).json({
    room: {
      id: room.id,
      slug: room.slug,
      name: room.name,
      type: normalizeRoomType(room.type),
      maxUsers: room.maxUsers,
      expiresAt: room.expiresAt?.toISOString() ?? null
    },
    ownerRecoveryCode
  });
}

function getClientIp(req: NextApiRequest) {
  const forwarded = req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return first?.trim() || req.socket.remoteAddress || "unknown";
}
