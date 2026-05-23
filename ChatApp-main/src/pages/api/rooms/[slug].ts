import type { NextApiRequest, NextApiResponse } from "next";
import { findRoomBySlug, isExpired } from "@/server/rooms";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const slug = String(req.query.slug ?? "");
  const room = await findRoomBySlug(slug);

  if (!room || isExpired(room.expiresAt)) {
    return res.status(404).json({ error: "Room not found or expired" });
  }

  return res.status(200).json({
    room: {
      id: room.id,
      slug: room.slug,
      name: room.name,
      type: room.type,
      maxUsers: room.maxUsers,
      expiresAt: room.expiresAt?.toISOString() ?? null,
      memberCount: room.members.length
    }
  });
}
