import type { AttachmentKind, RoomRole, RoomType } from "@/lib/chatTypes";
export type { AttachmentKind, RoomRole, RoomType };

export type Room = {
  id: string;
  slug: string;
  name: string;
  type: RoomType;
  maxUsers: number | null;
  expiresAt: string | null;
  memberCount?: number;
};

export type Member = {
  id: string;
  nickname: string;
  role: RoomRole;
};

export type ChatMessage = {
  id: string;
  body: string;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  member: Member;
  attachments: Attachment[];
};

export type Attachment = {
  id: string;
  originalName: string;
  mimeType: string;
  kind: AttachmentKind;
  byteSize: number;
  expiresAt: string | null;
  deletedAt: string | null;
  deletedReason: string | null;
  url: string;
};

export type JoinResponse = {
  room: Room;
  me: Member;
  members: Member[];
  messages: ChatMessage[];
  onlineCount: number;
};

export type TypingMember = {
  memberId: string;
  nickname: string;
};
