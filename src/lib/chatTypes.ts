export const ROOM_ROLES = ["guest", "admin", "super_admin"] as const;
export type RoomRole = (typeof ROOM_ROLES)[number];

export const ROOM_TYPES = ["GLOBAL", "DIRECT", "GROUP"] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

export const ATTACHMENT_KINDS = ["image", "gif", "pdf", "video"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

const roomRoleRank: Record<RoomRole, number> = {
  guest: 0,
  admin: 1,
  super_admin: 2
};

export function isRoomRole(value: string): value is RoomRole {
  return ROOM_ROLES.includes(value as RoomRole);
}

export function isRoomType(value: string): value is RoomType {
  return ROOM_TYPES.includes(value as RoomType);
}

export function isAttachmentKind(value: string): value is AttachmentKind {
  return ATTACHMENT_KINDS.includes(value as AttachmentKind);
}

export function normalizeAttachmentKind(kind: string): AttachmentKind {
  return isAttachmentKind(kind) ? kind : "image";
}

export function getRoomRoleRank(role: string) {
  return isRoomRole(role) ? roomRoleRank[role] : -1;
}

export function compareRoomRolesDesc(left: string, right: string) {
  return getRoomRoleRank(right) - getRoomRoleRank(left);
}
