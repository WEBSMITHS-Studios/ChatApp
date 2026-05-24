import { createServer } from "http";
import next from "next";
import { Server } from "socket.io";
import { prisma } from "./src/lib/db";
import { getCookieValue, getUserBySessionToken, sessionCookieName, touchUserActivity } from "./src/lib/auth";
import { checkRateLimit } from "./src/lib/rateLimit";
import { canModerate, isSuperAdmin } from "./src/lib/roles";
import { isSiteAdminEmail } from "./src/lib/siteAdmin";
import { markAttachmentDeleted, startUploadCleanupJob } from "./src/lib/uploads";
import {
  GLOBAL_ROOM_SLUG,
  ensureGlobalRoom,
  findRoomBySlug,
  getRecentMessages,
  joinRoom,
  publicAttachment,
  publicMember,
  sanitizeMessage,
  sanitizeNickname,
  sortRoomMembers,
  verifyOwnerRecoveryCode
} from "./src/server/rooms";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOSTNAME || "0.0.0.0";

type JoinPayload = {
  slug: string;
  identityId: string;
  nickname: string;
};

type MessagePayload = {
  roomId: string;
  body: string;
  attachmentIds?: string[];
};

type EditMessagePayload = {
  roomId: string;
  messageId: string;
  body: string;
};

type ModerationPayload = {
  roomId: string;
  targetMemberId: string;
};

type DeletePayload = {
  roomId: string;
  messageId: string;
};

type RecoveryPayload = {
  roomId: string;
  recoveryCode: string;
};

type NicknamePayload = {
  roomId: string;
  nickname: string;
};

type RoomRenamePayload = {
  roomId: string;
  name: string;
};

type MemberRemovePayload = {
  roomId: string;
  targetMemberId: string;
};

type TypingPayload = {
  roomId: string;
  isTyping: boolean;
};

type AckFn = (value: { ok: true; data?: unknown } | { ok: false; error: string }) => void;

type SocketRoomSession = {
  roomId: string;
  identityId: string;
  memberId: string;
  isSiteAdmin: boolean;
};

type SocketSession = {
  rooms: Map<string, SocketRoomSession>;
  user: { id: string; email: string; nickname: string } | null;
};

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const onlineByRoom = new Map<string, Map<string, Set<string>>>();
const socketSessions = new Map<string, SocketSession>();
const typingByRoom = new Map<string, Map<string, { memberId: string; nickname: string }>>();

function onlineCount(roomId: string) {
  return onlineByRoom.get(roomId)?.size ?? 0;
}

function addOnline(roomId: string, identityId: string, socketId: string) {
  const roomMap = onlineByRoom.get(roomId) ?? new Map<string, Set<string>>();
  const sockets = roomMap.get(identityId) ?? new Set<string>();
  sockets.add(socketId);
  roomMap.set(identityId, sockets);
  onlineByRoom.set(roomId, roomMap);
}

function removeOnline(roomId: string, identityId: string, socketId: string) {
  const roomMap = onlineByRoom.get(roomId);
  if (!roomMap) return;

  const sockets = roomMap.get(identityId);
  if (!sockets) return;

  sockets.delete(socketId);
  if (sockets.size === 0) roomMap.delete(identityId);
  if (roomMap.size === 0) onlineByRoom.delete(roomId);
}

function emitTyping(roomId: string, socketServer: Server) {
  const typingEntries = typingByRoom.get(roomId);
  socketServer.to(roomId).emit("room:typing", {
    members: typingEntries ? Array.from(typingEntries.values()) : []
  });
}

function setTyping(roomId: string, identityId: string, memberId: string, nickname: string, socketServer: Server) {
  const roomTyping = typingByRoom.get(roomId) ?? new Map<string, { memberId: string; nickname: string }>();
  roomTyping.set(identityId, { memberId, nickname });
  typingByRoom.set(roomId, roomTyping);
  emitTyping(roomId, socketServer);
}

function clearTyping(roomId: string, identityId: string, socketServer: Server) {
  const roomTyping = typingByRoom.get(roomId);
  if (!roomTyping) return;
  roomTyping.delete(identityId);
  if (roomTyping.size === 0) typingByRoom.delete(roomId);
  emitTyping(roomId, socketServer);
}

function sanitizeRoomName(input: string, fallback: string) {
  const clean = input.trim().replace(/\s+/g, " ").slice(0, 80);
  return clean || fallback;
}

function permissionDenied() {
  return new Error("Permission denied");
}

app.prepare().then(async () => {
  await ensureGlobalRoom();
  startUploadCleanupJob();

  const httpServer = createServer((req, res) => {
    handle(req, res);
  });

  const io = new Server(httpServer, {
    cors: {
      origin: process.env.NEXT_PUBLIC_APP_URL || true,
      credentials: true
    }
  });

  io.on("connection", (socket) => {
    const socketSession: SocketSession = {
      rooms: new Map(),
      user: null
    };
    socketSessions.set(socket.id, socketSession);

    socket.on("room:join", async (payload: JoinPayload, ack?: AckFn) => {
      try {
        const nickname = sanitizeNickname(payload.nickname);
        let identityId = String(payload.identityId ?? "").trim();
        let memberNickname = nickname;
        let verifiedUser: SocketSession["user"] = null;

        if (!identityId || !nickname || identityId.length > 100) {
          throw new Error("Nickname is required");
        }

        if (identityId.startsWith("user:")) {
          const token = getCookieValue(socket.handshake.headers.cookie, sessionCookieName);
          const user = token ? await getUserBySessionToken(token) : null;
          if (!user || identityId !== `user:${user.id}`) {
            throw new Error("Sign in again before joining as this account");
          }
          verifiedUser = { id: user.id, email: user.email, nickname: user.nickname };
          memberNickname = user.nickname;
          await touchUserActivity(user.id);
        }

        const room = await findRoomBySlug(payload.slug);
        if (!room) throw new Error("Room not found");

        let member = await joinRoom({
          roomId: room.id,
          identityId,
          nickname: memberNickname
        });

        const isSiteAdmin = isSiteAdminEmail(verifiedUser?.email);
        if (room.slug === GLOBAL_ROOM_SLUG) {
          const globalRole = isSiteAdmin ? "admin" : "guest";
          if (member.role !== globalRole) {
            member = await prisma.roomMember.update({
              where: { id: member.id },
              data: { role: globalRole }
            });
          }
        }

        socketSession.user = verifiedUser;

        const previousRoomSession = socketSession.rooms.get(room.id);
        if (previousRoomSession && previousRoomSession.identityId !== identityId) {
          removeOnline(room.id, previousRoomSession.identityId, socket.id);
        }

        socketSession.rooms.set(room.id, {
          roomId: room.id,
          identityId,
          memberId: member.id,
          isSiteAdmin
        });

        socket.join(room.id);
        addOnline(room.id, identityId, socket.id);

        const members = await prisma.roomMember.findMany({
          where: { roomId: room.id },
          orderBy: { createdAt: "asc" }
        });

        const response = {
          room: {
            id: room.id,
            slug: room.slug,
            name: room.name,
            type: room.type,
            maxUsers: room.maxUsers,
            expiresAt: room.expiresAt?.toISOString() ?? null
          },
          me: publicMember(member),
          members: sortRoomMembers(members).map(publicMember),
          messages: await getRecentMessages(room.id),
          onlineCount: onlineCount(room.id)
        };

        io.to(room.id).emit("room:online", { roomId: room.id, onlineCount: response.onlineCount });
        io.to(room.id).emit("room:members", response.members);
        emitTyping(room.id, io);
        ack?.({ ok: true, data: response });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Could not join room" });
      }
    });

    socket.on("message:send", async (payload: MessagePayload, ack?: AckFn) => {
      try {
        const body = sanitizeMessage(payload.body);
        const attachmentIds = Array.isArray(payload.attachmentIds) ? payload.attachmentIds.slice(0, 4) : [];
        if (!body && attachmentIds.length === 0) throw new Error("Message cannot be empty");

        const { member } = await getVerifiedActor(payload.roomId);
        const limit = checkRateLimit(`msg:${member.roomId}:${member.identityId}`, 12, 10_000);
        if (!limit.allowed) throw new Error("Slow down before sending another message");

        if (member.room.expiresAt && member.room.expiresAt.getTime() <= Date.now()) {
          throw new Error("This room has expired");
        }
        const activeUser = socketSessions.get(socket.id)?.user;
        if (activeUser) await touchUserActivity(activeUser.id);

        const attachments = attachmentIds.length
          ? await prisma.attachment.findMany({
              where: {
                id: { in: attachmentIds },
                roomId: member.roomId,
                memberId: member.id,
                messageId: null,
                deletedAt: null
              }
            })
          : [];
        if (attachments.length !== attachmentIds.length) throw permissionDenied();
        if (attachments.some((attachment) => attachment.expiresAt && attachment.expiresAt.getTime() <= Date.now())) {
          throw new Error("One attachment has expired");
        }

        const message = await prisma.message.create({
          data: {
            roomId: member.roomId,
            memberId: member.id,
            body,
            attachments: attachmentIds.length
              ? {
                  connect: attachments.map((attachment) => ({ id: attachment.id }))
                }
              : undefined
          },
          include: { member: true, attachments: true }
        });

        const publicMessage = {
          id: message.id,
          body: message.body,
          editedAt: null,
          deletedAt: null,
          createdAt: message.createdAt.toISOString(),
          member: publicMember(message.member),
          attachments: message.attachments.map(publicAttachment)
        };

        clearTyping(member.roomId, member.identityId, io);
        io.to(member.roomId).emit("message:new", publicMessage);
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Could not send message" });
      }
    });

    socket.on("message:edit", async (payload: EditMessagePayload, ack?: AckFn) => {
      try {
        const body = sanitizeMessage(payload.body);

        const { member } = await getVerifiedActor(payload.roomId);
        const message = await prisma.message.findFirst({
          where: {
            id: payload.messageId,
            roomId: member.roomId,
            memberId: member.id,
            deletedAt: null
          },
          include: { member: true, attachments: true }
        });
        if (!message) throw permissionDenied();
        if (!body && message.attachments.length === 0) throw new Error("Message cannot be empty");

        const editedAt = new Date();
        const updated = await prisma.message.update({
          where: { id: message.id },
          data: { body, editedAt },
          include: { member: true, attachments: true }
        });

        clearTyping(member.roomId, member.identityId, io);
        io.to(member.roomId).emit("message:edited", {
          id: updated.id,
          body: updated.body,
          editedAt: editedAt.toISOString(),
          attachments: updated.attachments.map(publicAttachment)
        });
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Could not edit message" });
      }
    });

    socket.on("message:delete", async (payload: DeletePayload, ack?: AckFn) => {
      try {
        const { member, roomSession } = await getVerifiedActor(payload.roomId);

        const message = await prisma.message.findFirst({
          where: {
            id: payload.messageId,
            roomId: member.roomId
          },
          include: { attachments: true }
        });
        if (!message) throw permissionDenied();
        if (message.memberId !== member.id && !canModerateRoom(member, roomSession)) throw permissionDenied();

        const deletedAt = new Date();
        await prisma.message.update({
          where: { id: message.id },
          data: { deletedAt, body: "" }
        });
        for (const attachment of message.attachments) {
          await markAttachmentDeleted(attachment.id, attachment.storedName, "message_deleted");
        }

        io.to(member.roomId).emit("message:deleted", {
          id: message.id,
          deletedAt: deletedAt.toISOString()
        });
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Could not delete message" });
      }
    });

    socket.on("nickname:update", async (payload: NicknamePayload, ack?: AckFn) => {
      try {
        const nickname = sanitizeNickname(payload.nickname);
        if (!nickname) throw new Error("Nickname is required");

        const { member, session } = await getVerifiedActor(payload.roomId);
        if (session.user) {
          await prisma.user.update({ where: { id: session.user.id }, data: { nickname, lastActiveAt: new Date() } });
          await prisma.roomMember.updateMany({
            where: { identityId: `user:${session.user.id}` },
            data: { nickname }
          });
          session.user.nickname = nickname;
        } else {
          await prisma.roomMember.update({
            where: { id: member.id },
            data: { nickname }
          });
        }

        await emitMembers(member.roomId);
        const messages = await getRecentMessages(member.roomId);
        io.to(member.roomId).emit("room:messages", messages);
        ack?.({ ok: true, data: { nickname } });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Could not update nickname" });
      }
    });

    socket.on("room:typing", async (payload: TypingPayload) => {
      try {
        const { member } = await getVerifiedActor(payload.roomId);
        if (payload.isTyping) {
          setTyping(member.roomId, member.identityId, member.id, member.nickname, io);
        } else {
          clearTyping(member.roomId, member.identityId, io);
        }
      } catch {
        // Ignore invalid typing state updates.
      }
    });

    socket.on("room:rename", async (payload: RoomRenamePayload, ack?: AckFn) => {
      try {
        const { member } = await getVerifiedActor(payload.roomId);
        if (member.room.slug === GLOBAL_ROOM_SLUG) throw permissionDenied();

        const canRename =
          member.room.type === "DIRECT"
            ? true
            : isSuperAdmin(member.role);
        if (!canRename) throw permissionDenied();

        const updated = await prisma.room.update({
          where: { id: member.roomId },
          data: {
            name: sanitizeRoomName(payload.name, member.room.name)
          }
        });

        io.to(member.roomId).emit("room:updated", {
          room: {
            id: updated.id,
            slug: updated.slug,
            name: updated.name,
            type: updated.type,
            maxUsers: updated.maxUsers,
            expiresAt: updated.expiresAt?.toISOString() ?? null
          }
        });
        ack?.({ ok: true, data: { name: updated.name } });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Could not rename room" });
      }
    });

    socket.on("member:remove", async (payload: MemberRemovePayload, ack?: AckFn) => {
      try {
        const { member } = await getVerifiedActor(payload.roomId);
        if (member.room.slug === GLOBAL_ROOM_SLUG || member.room.type === "DIRECT") {
          throw permissionDenied();
        }
        if (!isSuperAdmin(member.role)) throw permissionDenied();

        const target = await prisma.roomMember.findFirst({
          where: {
            id: payload.targetMemberId,
            roomId: member.roomId
          }
        });
        if (!target) throw permissionDenied();
        if (target.id === member.id || target.role === "super_admin") throw permissionDenied();

        await prisma.roomMember.delete({ where: { id: target.id } });
        evictMemberSessions(member.roomId, target.id, target.identityId);
        await emitMembers(member.roomId);
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Could not remove member" });
      }
    });

    socket.on("member:promote", async (payload: ModerationPayload, ack?: AckFn) => {
      await changeMemberRole(payload, "admin", ack);
    });

    socket.on("member:demote", async (payload: ModerationPayload, ack?: AckFn) => {
      await changeMemberRole(payload, "guest", ack);
    });

    socket.on("member:transfer", async (payload: ModerationPayload, ack?: AckFn) => {
      try {
        const { member } = await getVerifiedActor(payload.roomId);
        if (member.room.slug === GLOBAL_ROOM_SLUG || !isSuperAdmin(member.role)) {
          throw permissionDenied();
        }

        const target = await prisma.roomMember.findFirst({
          where: {
            id: payload.targetMemberId,
            roomId: member.roomId
          }
        });
        if (!target) throw permissionDenied();
        if (target.id === member.id) throw new Error("You already own this room");

        await prisma.$transaction([
          prisma.roomMember.updateMany({
            where: { roomId: member.roomId, role: "super_admin" },
            data: { role: "admin" }
          }),
          prisma.roomMember.update({
            where: { id: target.id },
            data: { role: "super_admin" }
          }),
          prisma.room.update({
            where: { id: member.roomId },
            data: { creatorIdentityId: target.identityId }
          })
        ]);

        await emitMembers(member.roomId);
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Could not transfer ownership" });
      }
    });

    socket.on("room:recover", async (payload: RecoveryPayload, ack?: AckFn) => {
      try {
        const { member } = await getVerifiedActor(payload.roomId);
        if (member.room.slug === GLOBAL_ROOM_SLUG) throw permissionDenied();

        const limit = checkRateLimit(`recover:${member.roomId}:${socket.id}`, 5, 15 * 60 * 1000);
        if (!limit.allowed) throw new Error("Too many recovery attempts");

        if (!verifyOwnerRecoveryCode(member.room.slug, payload.recoveryCode, member.room.ownerRecoveryCodeHash)) {
          throw permissionDenied();
        }

        await prisma.$transaction([
          prisma.roomMember.updateMany({
            where: { roomId: member.roomId, role: "super_admin" },
            data: { role: "admin" }
          }),
          prisma.roomMember.update({
            where: { id: member.id },
            data: { role: "super_admin" }
          }),
          prisma.room.update({
            where: { id: member.roomId },
            data: { creatorIdentityId: member.identityId }
          })
        ]);

        await emitMembers(member.roomId);
        ack?.({ ok: true });
      } catch (error) {
        ack?.({ ok: false, error: error instanceof Error ? error.message : "Could not recover ownership" });
      }
    });

    async function changeMemberRole(payload: ModerationPayload, role: "admin" | "guest", ack?: AckFn) {
      try {
        const { member } = await getVerifiedActor(payload.roomId);
        if (member.room.slug === GLOBAL_ROOM_SLUG || !isSuperAdmin(member.role)) {
          throw permissionDenied();
        }

        const target = await prisma.roomMember.findFirst({
          where: {
            id: payload.targetMemberId,
            roomId: member.roomId
          }
        });
        if (!target) throw permissionDenied();
        if (target.id === member.id) throw permissionDenied();
        if (role === "guest" && target.role !== "admin") throw permissionDenied();
        if (role === "admin" && target.role === "super_admin") throw permissionDenied();

        await prisma.roomMember.update({
          where: { id: target.id },
          data: { role }
        });

        await emitMembers(member.roomId);
        ack?.({ ok: true });
      } catch (error) {
        ack?.({
          ok: false,
          error: error instanceof Error ? error.message : "Could not update member"
        });
      }
    }

    async function getVerifiedActor(roomId: string) {
      const session = socketSessions.get(socket.id);
      const roomSession = session?.rooms.get(roomId);
      if (!session || !roomSession) throw permissionDenied();

      const member = await prisma.roomMember.findUnique({
        where: { id: roomSession.memberId },
        include: { room: true }
      });

      if (!member || member.roomId !== roomId || member.identityId !== roomSession.identityId) {
        throw permissionDenied();
      }

      return { member, session, roomSession };
    }

    function canModerateRoom(
      member: Awaited<ReturnType<typeof getVerifiedActor>>["member"],
      roomSession: SocketRoomSession
    ) {
      if (member.room.slug === GLOBAL_ROOM_SLUG) {
        return roomSession.isSiteAdmin;
      }
      return canModerate(member.role);
    }

    function evictMemberSessions(roomId: string, memberId: string, identityId: string) {
      for (const [socketId, session] of socketSessions.entries()) {
        const roomSession = session.rooms.get(roomId);
        if (!roomSession) continue;
        if (roomSession.memberId !== memberId && roomSession.identityId !== identityId) continue;

        const targetSocket = io.sockets.sockets.get(socketId);
        targetSocket?.leave(roomId);
        session.rooms.delete(roomId);
        removeOnline(roomId, roomSession.identityId, socketId);
        clearTyping(roomId, roomSession.identityId, io);
        targetSocket?.emit("room:kicked", { roomId, memberId });
      }

      io.to(roomId).emit("room:online", {
        roomId,
        onlineCount: onlineCount(roomId)
      });
    }

    async function emitMembers(roomId: string) {
      const members = await prisma.roomMember.findMany({
        where: { roomId },
        orderBy: { createdAt: "asc" }
      });
      io.to(roomId).emit("room:members", sortRoomMembers(members).map(publicMember));
    }

    socket.on("disconnect", () => {
      const session = socketSessions.get(socket.id);
      if (session) {
        for (const roomSession of session.rooms.values()) {
          removeOnline(roomSession.roomId, roomSession.identityId, socket.id);
          clearTyping(roomSession.roomId, roomSession.identityId, io);
          io.to(roomSession.roomId).emit("room:online", {
            roomId: roomSession.roomId,
            onlineCount: onlineCount(roomSession.roomId)
          });
        }
      }
      socketSessions.delete(socket.id);
    });
  });

  httpServer.listen(port, hostname, () => {
    console.log(`WEBSMITHS ChatApp ready on http://${hostname}:${port}`);
  });
});
