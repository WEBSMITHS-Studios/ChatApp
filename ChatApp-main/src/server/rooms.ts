import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { RoomRole, RoomType } from "../lib/chatTypes";
import { compareRoomRolesDesc, isRoomRole, isRoomType, normalizeAttachmentKind } from "../lib/chatTypes";
import { prisma } from "../lib/db";

export const GLOBAL_ROOM_SLUG = "global";

export type PublicMember = {
  id: string;
  nickname: string;
  role: string;
};

export async function ensureGlobalRoom() {
  return prisma.room.upsert({
    where: { slug: GLOBAL_ROOM_SLUG },
    update: {
      name: "WEBSMITHS Global Chat",
      type: "GLOBAL"
    },
    create: {
      slug: GLOBAL_ROOM_SLUG,
      name: "WEBSMITHS Global Chat",
      type: "GLOBAL"
    }
  });
}

export function createRoomSlug() {
  return randomBytes(5).toString("base64url").toLowerCase();
}

export function createOwnerRecoveryCode() {
  return randomBytes(18).toString("base64url");
}

export function hashOwnerRecoveryCode(slug: string, code: string) {
  return createHash("sha256").update(`${slug}:${code.trim()}`).digest("hex");
}

export function verifyOwnerRecoveryCode(slug: string, code: string, storedHash: string | null) {
  if (!storedHash || !code.trim()) return false;

  const attempted = Buffer.from(hashOwnerRecoveryCode(slug, code), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return attempted.length === expected.length && timingSafeEqual(attempted, expected);
}

export function sanitizeNickname(input: string) {
  return input.trim().replace(/\s+/g, " ").slice(0, 32);
}

export function sanitizeMessage(input: string) {
  return input.trim().slice(0, 1200);
}

export function isExpired(expiresAt: Date | null) {
  return Boolean(expiresAt && expiresAt.getTime() <= Date.now());
}

export async function findRoomBySlug(slug: string) {
  if (slug === GLOBAL_ROOM_SLUG) {
    await ensureGlobalRoom();
  }

  return prisma.room.findUnique({
    where: { slug },
    include: {
      members: {
        orderBy: { createdAt: "asc" }
      }
    }
  }).then((room) => (room ? { ...room, type: normalizeRoomType(room.type), members: sortRoomMembers(room.members) } : null));
}

export async function createRoom(params: {
  name: string;
  type: Exclude<RoomType, "GLOBAL">;
  maxUsers?: number | null;
  expiresAt?: Date | null;
  creatorIdentityId: string;
  creatorNickname: string;
}) {
  let slug = "";
  for (let attempts = 0; attempts < 10; attempts += 1) {
    slug = createRoomSlug();
    const existing = await prisma.room.findUnique({ where: { slug } });
    if (!existing) break;
    slug = "";
  }
  if (!slug) throw new Error("Could not generate a room link");

  const ownerRecoveryCode = createOwnerRecoveryCode();
  const room = await prisma.room.create({
    data: {
      slug,
      name: params.name,
      type: params.type,
      maxUsers: params.type === "DIRECT" ? 2 : params.maxUsers ?? null,
      expiresAt: params.expiresAt ?? null,
      creatorIdentityId: params.creatorIdentityId,
      ownerRecoveryCodeHash: hashOwnerRecoveryCode(slug, ownerRecoveryCode),
      members: {
        create: {
          identityId: params.creatorIdentityId,
          nickname: params.creatorNickname,
          role: "super_admin"
        }
      }
    }
  });

  return { room, ownerRecoveryCode };
}

export async function joinRoom(params: {
  roomId: string;
  identityId: string;
  nickname: string;
}) {
  const room = await prisma.room.findUnique({
    where: { id: params.roomId },
    include: { members: true }
  });

  if (!room) throw new Error("Room not found");
  if (isExpired(room.expiresAt)) throw new Error("This room has expired");

  const existing = room.members.find((member) => member.identityId === params.identityId);
  if (existing) {
    return prisma.roomMember.update({
      where: { id: existing.id },
      data: { nickname: params.nickname }
    });
  }

  if (room.maxUsers && room.members.length >= room.maxUsers) {
    throw new Error("This room is full");
  }

  return prisma.roomMember.create({
    data: {
      roomId: params.roomId,
      identityId: params.identityId,
      nickname: params.nickname,
      role: "guest"
    }
  });
}

export async function getRecentMessages(roomId: string) {
  const messages = await prisma.message.findMany({
    where: { roomId },
    include: { member: true, attachments: true },
    orderBy: { createdAt: "desc" },
    take: 80
  });

  return messages.reverse().map((message) => ({
    id: message.id,
    body: message.body,
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString(),
    member: {
      id: message.member.id,
      nickname: message.member.nickname,
      role: normalizeRoomRole(message.member.role)
    },
    attachments: message.attachments.map(publicAttachment)
  }));
}

export function publicMember(member: PublicMember) {
  return {
    id: member.id,
    nickname: member.nickname,
    role: normalizeRoomRole(member.role)
  };
}

export function normalizeRoomType(type: string): RoomType {
  return isRoomType(type) ? type : "GROUP";
}

export function normalizeRoomRole(role: string): RoomRole {
  return isRoomRole(role) ? role : "guest";
}

export function sortRoomMembers<T extends { role: string; createdAt: Date }>(members: T[]) {
  return [...members].sort((left, right) => {
    const roleOrder = compareRoomRolesDesc(left.role, right.role);
    if (roleOrder !== 0) return roleOrder;
    return left.createdAt.getTime() - right.createdAt.getTime();
  });
}

export function publicAttachment(attachment: {
  id: string;
  originalName: string;
  mimeType: string;
  kind: string;
  byteSize: number;
  expiresAt: Date | null;
  deletedAt: Date | null;
  deletedReason?: string | null;
}) {
  return {
    id: attachment.id,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    kind: normalizeAttachmentKind(attachment.kind),
    byteSize: attachment.byteSize,
    expiresAt: attachment.expiresAt?.toISOString() ?? null,
    deletedAt: attachment.deletedAt?.toISOString() ?? null,
    deletedReason: attachment.deletedReason ?? null,
    url: `/api/attachments/${attachment.id}`
  };
}
