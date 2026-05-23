import Head from "next/head";
import { useRouter } from "next/router";
import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import type { Attachment, ChatMessage, JoinResponse, Member, Room, RoomRole, TypingMember } from "./types";

type Ack<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };
type AuthUser = { id: string; email: string; nickname: string; storageUsedBytes?: number; isSiteAdmin?: boolean };

const roleLabel: Record<RoomRole, string> = {
  guest: "Guest",
  admin: "Admin",
  super_admin: "Owner"
};

const identityStorageKey = "websmiths-chatapp.identityId";
const legacyIdentityStorageKey = "anon-chat.identityId";
const nicknameStorageKey = "websmiths-chatapp.nickname";
const legacyNicknameStorageKey = "anon-chat.nickname";
const ownerRecoveryStoragePrefix = "websmiths-chatapp.ownerRecovery.";
const legacyOwnerRecoveryStoragePrefix = "anon-chat.ownerRecovery.";
const guestIdentityCookieName = "websmiths_chatapp_guest_identity";

export function ChatPage({ slug }: { slug: string }) {
  const router = useRouter();
  const [identityId, setIdentityId] = useState("");
  const [guestIdentityId, setGuestIdentityId] = useState("");
  const [nickname, setNickname] = useState("");
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [me, setMe] = useState<Member | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [onlineCount, setOnlineCount] = useState(0);
  const [typingMembers, setTypingMembers] = useState<TypingMember[]>([]);
  const [messageDraft, setMessageDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [ownerRecoveryCode, setOwnerRecoveryCode] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [connected, setConnected] = useState(false);
  const [booting, setBooting] = useState(true);
  const socketRef = useRef<Socket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const meIdRef = useRef<string | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);

  const shareUrl = useMemo(() => {
    if (!room || typeof window === "undefined") return "";
    return room.slug === "global" ? window.location.origin : `${window.location.origin}/room/${room.slug}`;
  }, [room]);

  useEffect(() => {
    const storedIdentity = localStorage.getItem(identityStorageKey) || localStorage.getItem(legacyIdentityStorageKey) || crypto.randomUUID();
    localStorage.setItem(identityStorageKey, storedIdentity);
    document.cookie = `${guestIdentityCookieName}=${encodeURIComponent(storedIdentity)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    setGuestIdentityId(storedIdentity);
    setIdentityId(storedIdentity);

    const storedNickname = localStorage.getItem(nicknameStorageKey) || localStorage.getItem(legacyNicknameStorageKey) || "";
    setNickname(storedNickname);
    setNicknameDraft(storedNickname);

    fetch("/api/auth/me")
      .then((response) => response.json())
      .then((json: { user: AuthUser | null }) => {
        if (!json.user) return;
        setAuthUser(json.user);
        setIdentityId(`user:${json.user.id}`);
        setNickname(json.user.nickname);
        setNicknameDraft(json.user.nickname);
      })
      .catch(() => undefined)
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    if (!slug || !identityId || !nickname) return;

    const socket = io({
      transports: ["websocket", "polling"],
      reconnection: true
    });
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("message:new", (message: ChatMessage) => {
      setMessages((current) => [...current, message]);
    });
    socket.on("message:deleted", (payload: { id: string; deletedAt: string }) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === payload.id ? { ...message, body: "", attachments: [], deletedAt: payload.deletedAt } : message
        )
      );
    });
    socket.on("message:edited", (payload: { id: string; body: string; editedAt: string; attachments: Attachment[] }) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === payload.id
            ? { ...message, body: payload.body, editedAt: payload.editedAt, attachments: payload.attachments }
            : message
        )
      );
    });
    socket.on("room:messages", (nextMessages: ChatMessage[]) => setMessages(nextMessages));
    socket.on("room:members", (nextMembers: Member[]) => {
      setMembers(nextMembers);
      setMe(nextMembers.find((member) => member.id === meIdRef.current) ?? null);
    });
    socket.on("room:online", (payload: { onlineCount: number }) => {
      setOnlineCount(payload.onlineCount);
    });
    socket.on("room:typing", (payload: { members: TypingMember[] }) => {
      setTypingMembers(payload.members.filter((member) => member.memberId !== meIdRef.current));
    });

    socket.emit(
      "room:join",
      { slug, identityId, nickname },
      (ack: Ack<JoinResponse>) => {
        if (!ack.ok) {
          setError(ack.error);
          return;
        }
        if (!ack.data) return;
        setRoom(ack.data.room);
        setMe(ack.data.me);
        meIdRef.current = ack.data.me.id;
        setMembers(ack.data.members);
        setMessages(ack.data.messages);
        setOnlineCount(ack.data.onlineCount);
        setTypingMembers([]);
        setError("");
      }
    );

    return () => {
      socket.disconnect();
    };
  }, [slug, identityId, nickname]);

  useEffect(() => {
    meIdRef.current = me?.id ?? null;
  }, [me?.id]);

  useEffect(() => {
    if (!slug) return;

    const code =
      sessionStorage.getItem(`${ownerRecoveryStoragePrefix}${slug}`) ||
      sessionStorage.getItem(`${legacyOwnerRecoveryStoragePrefix}${slug}`);
    if (code) {
      setOwnerRecoveryCode(code);
      sessionStorage.removeItem(`${ownerRecoveryStoragePrefix}${slug}`);
      sessionStorage.removeItem(`${legacyOwnerRecoveryStoragePrefix}${slug}`);
    }
  }, [slug]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        window.clearTimeout(typingTimeoutRef.current);
      }
      if (room?.id && socketRef.current) {
        socketRef.current.emit("room:typing", { roomId: room.id, isTyping: false });
      }
    };
  }, [room?.id]);

  useEffect(() => {
    if (!room || !socketRef.current) return;
    const isTyping = messageDraft.trim().length > 0;
    socketRef.current.emit("room:typing", { roomId: room.id, isTyping });

    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }

    if (isTyping) {
      typingTimeoutRef.current = window.setTimeout(() => {
        socketRef.current?.emit("room:typing", { roomId: room.id, isTyping: false });
        typingTimeoutRef.current = null;
      }, 1800);
    }

    return () => {
      if (typingTimeoutRef.current) {
        window.clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
    };
  }, [messageDraft, room?.id]);

  function saveNickname(event: FormEvent) {
    event.preventDefault();
    const clean = nicknameDraft.trim().replace(/\s+/g, " ").slice(0, 32);
    if (!clean) return;
    localStorage.setItem(nicknameStorageKey, clean);
    setNickname(clean);
  }

  async function handleAuth(endpoint: "signin" | "signup", payload: AuthPayload) {
    setError("");
    const response = await fetch(`/api/auth/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const json = await response.json();
    if (!response.ok) {
      setError(json.error || "Authentication failed");
      return;
    }
    setAuthUser(json.user);
    setIdentityId(`user:${json.user.id}`);
    setNickname(json.user.nickname);
    setNicknameDraft(json.user.nickname);
    localStorage.setItem(nicknameStorageKey, json.user.nickname);
  }

  async function signOut() {
    await fetch("/api/auth/me", { method: "DELETE" });
    setAuthUser(null);
    setIdentityId(guestIdentityId);
    document.cookie = `${guestIdentityCookieName}=${encodeURIComponent(guestIdentityId)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    setNickname(localStorage.getItem(nicknameStorageKey) || localStorage.getItem(legacyNicknameStorageKey) || "");
  }

  function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!room || (!messageDraft.trim() && pendingAttachments.length === 0) || !socketRef.current) return;

    socketRef.current.emit(
      "message:send",
      { roomId: room.id, body: messageDraft, attachmentIds: pendingAttachments.map((attachment) => attachment.id) },
      (ack: Ack) => {
        if (!ack.ok) {
          setError(ack.error);
          return;
        }
        setMessageDraft("");
        setPendingAttachments([]);
        if (typingTimeoutRef.current) {
          window.clearTimeout(typingTimeoutRef.current);
          typingTimeoutRef.current = null;
        }
        socketRef.current?.emit("room:typing", { roomId: room.id, isTyping: false });
        setTypingMembers((current) => current.filter((member) => member.memberId !== meIdRef.current));
        setError("");
      }
    );
  }

  function editMessage(messageId: string, body: string) {
    if (!room || !socketRef.current) return;
    socketRef.current.emit("message:edit", { roomId: room.id, messageId, body }, (ack: Ack) => {
      if (!ack.ok) setError(ack.error);
    });
  }

  function updateNickname(nextNickname: string) {
    if (!room || !socketRef.current) return;
    socketRef.current.emit("nickname:update", { roomId: room.id, nickname: nextNickname }, (ack: Ack<{ nickname: string }>) => {
      if (!ack.ok) {
        setError(ack.error);
        return;
      }
      const clean = ack.data?.nickname ?? nextNickname.trim().replace(/\s+/g, " ").slice(0, 32);
      localStorage.setItem(nicknameStorageKey, clean);
      setNickname(clean);
      setNicknameDraft(clean);
      setAuthUser((current) => (current ? { ...current, nickname: clean } : current));
      setError("");
    });
  }

  function uploadFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!room || files.length === 0) return;

    const formData = new FormData();
    formData.append("roomId", room.id);
    formData.append("identityId", identityId);
    for (const file of files.slice(0, 4)) {
      formData.append("files", file);
    }

    const request = new XMLHttpRequest();
    request.open("POST", "/api/uploads");
    request.upload.onprogress = (progress) => {
      if (progress.lengthComputable) setUploadProgress(Math.round((progress.loaded / progress.total) * 100));
      else setUploadProgress(1);
    };
    request.onload = () => {
      setUploadProgress(null);
      try {
        const json = JSON.parse(request.responseText);
        if (request.status >= 400) throw new Error(json.error || "Upload failed");
        setPendingAttachments((current) => [...current, ...json.attachments].slice(0, 4));
        setError("");
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : "Upload failed");
      }
    };
    request.onerror = () => {
      setUploadProgress(null);
      setError("Upload failed");
    };
    request.send(formData);
  }

  async function createRoom(form: CreateRoomForm) {
    setCreating(true);
    setError("");
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          creatorIdentityId: identityId,
          creatorNickname: nickname
        })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Could not create room");
      if (json.ownerRecoveryCode && json.room?.slug) {
        sessionStorage.setItem(`${ownerRecoveryStoragePrefix}${json.room.slug}`, json.ownerRecoveryCode);
      }
      await router.push(`/room/${json.room.slug}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create room");
    } finally {
      setCreating(false);
    }
  }

  function moderate(event: "member:promote" | "member:demote" | "member:transfer", targetMemberId: string) {
    if (!room || !socketRef.current) return;
    socketRef.current.emit(event, { roomId: room.id, targetMemberId }, (ack: Ack) => {
      if (!ack.ok) setError(ack.error);
    });
  }

  function deleteMessage(messageId: string) {
    if (!room || !socketRef.current) return;
    socketRef.current.emit("message:delete", { roomId: room.id, messageId }, (ack: Ack) => {
      if (!ack.ok) setError(ack.error);
    });
  }

  function recoverOwnership(recoveryCode: string) {
    if (!room || !socketRef.current) return;
    socketRef.current.emit("room:recover", { roomId: room.id, recoveryCode }, (ack: Ack) => {
      if (!ack.ok) {
        setError(ack.error);
        return;
      }
      setError("");
    });
  }

  const canDelete = me?.role === "admin" || me?.role === "super_admin";
  const isOwner = me?.role === "super_admin";

  return (
    <>
      <Head>
        <title>{room ? `${room.name} | WEBSMITHS ChatApp` : "WEBSMITHS ChatApp"}</title>
        <meta name="description" content="WEBSMITHS ChatApp for guest and account-backed realtime rooms" />
      </Head>

      <main className="relative min-h-screen overflow-hidden bg-ink-950 text-zinc-100">
        <div className="ambient-orb left-[-6rem] top-[-5rem] h-40 w-40 bg-sky-300/30" />
        <div className="ambient-orb bottom-16 right-[-4rem] h-48 w-48 bg-emerald-300/20" />
        <div className="grid min-h-screen grid-cols-1 gap-3 p-3 lg:grid-cols-[320px_minmax(0,1fr)] lg:p-4">
          <Sidebar
            nickname={nickname}
            authUser={authUser}
            connected={connected}
            creating={creating}
            onCreateRoom={createRoom}
            onAuth={handleAuth}
            onSignOut={signOut}
            onNicknameUpdate={updateNickname}
          />

          <section className="glass-panel-strong flex min-h-[calc(100vh-1.5rem)] flex-col overflow-hidden rounded-[28px]">
            <header className="glass-shell border-b border-white/10 px-5 py-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h1 className="text-xl font-semibold tracking-[0.01em] text-white">{room?.name ?? (booting ? "Loading WEBSMITHS ChatApp..." : "Joining chat...")}</h1>
                  <p className="mt-1 text-sm text-zinc-400">
                    {room?.type === "DIRECT" ? "Private 1-to-1 room" : room?.slug === "global" ? "Global chat" : "Group room"} | {onlineCount} online
                    {room?.maxUsers ? ` | ${members.length}/${room.maxUsers} members` : ""}
                    {room?.expiresAt ? ` | expires ${new Date(room.expiresAt).toLocaleString()}` : ""}
                  </p>
                </div>
                {shareUrl ? (
                  <button
                    className="secondary-button h-10 rounded-full px-4 text-sm text-zinc-100"
                    onClick={() => navigator.clipboard.writeText(shareUrl)}
                  >
                    Copy link
                  </button>
                ) : null}
              </div>
            </header>

            {error ? (
              <div className="border-b border-red-400/20 bg-red-950/40 px-5 py-3 text-sm text-red-100 backdrop-blur">{error}</div>
            ) : null}

            <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px]">
              <div className="flex min-h-0 flex-col">
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-5 sm:py-5">
                  {!room && booting ? (
                    <LoadingConversation />
                  ) : (
                    messages.map((message, index) => {
                      const previous = messages[index - 1];
                      const next = messages[index + 1];
                      const isMine = me?.id === message.member.id;
                      return (
                        <MessageRow
                          key={message.id}
                          message={message}
                          isMine={isMine}
                          groupedWithPrevious={shouldGroupMessages(previous, message)}
                          groupedWithNext={shouldGroupMessages(message, next)}
                          canDelete={(canDelete || isMine) && !message.deletedAt}
                          canEdit={isMine && !message.deletedAt}
                          onDelete={() => deleteMessage(message.id)}
                          onEdit={(body) => editMessage(message.id, body)}
                        />
                      );
                    })
                  )}
                  <div ref={bottomRef} />
                </div>

                <div className="px-4 pb-1 sm:px-5">
                  <TypingIndicator members={typingMembers} />
                </div>

                <form onSubmit={sendMessage} className="glass-shell border-t border-white/10 px-3 py-3 sm:px-4 sm:py-4">
                  {pendingAttachments.length ? (
                    <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                      {pendingAttachments.map((attachment) => (
                        <AttachmentCard
                          key={attachment.id}
                          attachment={attachment}
                          compact
                          onRemove={() =>
                            setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id))
                          }
                        />
                      ))}
                    </div>
                  ) : null}
                  {uploadProgress !== null ? (
                    <div className="mb-3 overflow-hidden rounded-full border border-white/10 bg-white/5">
                      <div className="h-2 bg-gradient-to-r from-sky-300 via-cyan-200 to-emerald-300 transition-all" style={{ width: `${Math.max(uploadProgress, 8)}%` }} />
                    </div>
                  ) : null}
                  <div className="glass-panel flex items-end gap-2 rounded-[24px] p-2 sm:gap-3">
                    <label className="secondary-button grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-2xl text-lg text-zinc-100 sm:h-12 sm:w-12" aria-label="Add attachments">
                      <span className="text-xl leading-none">+</span>
                      <input
                        className="sr-only"
                        type="file"
                        multiple
                        onChange={uploadFiles}
                        accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,video/mp4,video/webm,video/quicktime,.jpg,.jpeg,.png,.webp,.gif,.pdf,.mp4,.webm,.mov"
                        disabled={!nickname || !room || uploadProgress !== null}
                      />
                    </label>
                    <input
                      className="glass-input h-11 min-w-0 flex-1 rounded-2xl px-4 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 sm:h-12"
                      value={messageDraft}
                      onChange={(event) => setMessageDraft(event.target.value)}
                      placeholder={nickname ? "Type a message..." : "Choose a nickname to chat"}
                      maxLength={1200}
                      disabled={!nickname || !room}
                    />
                    <button className="liquid-button h-11 rounded-2xl px-4 text-sm font-semibold sm:h-12 sm:px-5">
                      Send
                    </button>
                  </div>
                </form>
              </div>

              <MemberPanel
                room={room}
                members={members}
                me={me}
                isOwner={isOwner}
                onPromote={(id) => moderate("member:promote", id)}
                onDemote={(id) => moderate("member:demote", id)}
                onTransfer={(id) => moderate("member:transfer", id)}
                onRecover={recoverOwnership}
              />
            </div>
          </section>
        </div>

        {!nickname ? (
          <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/58 p-4 backdrop-blur-md">
            <form onSubmit={saveNickname} className="glass-panel-strong w-full max-w-sm rounded-[28px] p-6">
              <h2 className="text-lg font-semibold text-white">Choose a nickname</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">Pick the name people in this room will see. You can change it later.</p>
              <input
                autoFocus
                className="glass-input mt-4 h-11 w-full rounded-2xl px-4 text-sm text-white outline-none"
                value={nicknameDraft}
                onChange={(event) => setNicknameDraft(event.target.value)}
                maxLength={32}
                placeholder="Nickname"
              />
              <button className="liquid-button mt-4 h-11 w-full rounded-2xl text-sm font-semibold">
                Join chat
              </button>
            </form>
          </div>
        ) : null}

        {ownerRecoveryCode && room ? (
          <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/58 p-4 backdrop-blur-md">
            <div className="glass-panel-strong w-full max-w-md rounded-[28px] p-6">
              <h2 className="text-lg font-semibold text-white">Owner recovery code</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Save this code now. It can restore ownership for {room.name} and will not be shown again.
              </p>
              <code className="glass-input mt-4 block break-all rounded-2xl p-4 text-sm text-cyan-100">
                {ownerRecoveryCode}
              </code>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <button
                  className="secondary-button h-11 rounded-2xl text-sm text-zinc-100"
                  onClick={() => navigator.clipboard.writeText(ownerRecoveryCode)}
                >
                  Copy
                </button>
                <button
                  className="liquid-button h-11 rounded-2xl text-sm font-semibold"
                  onClick={() => setOwnerRecoveryCode(null)}
                >
                  Saved
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </>
  );
}

type CreateRoomForm = {
  name: string;
  type: "DIRECT" | "GROUP";
  maxUsers: number | null;
  expiresInHours: number | null;
};

type AuthPayload = {
  email: string;
  password: string;
  nickname?: string;
};

function Sidebar({
  nickname,
  authUser,
  connected,
  creating,
  onCreateRoom,
  onAuth,
  onSignOut,
  onNicknameUpdate
}: {
  nickname: string;
  authUser: AuthUser | null;
  connected: boolean;
  creating: boolean;
  onCreateRoom: (form: CreateRoomForm) => void;
  onAuth: (endpoint: "signin" | "signup", payload: AuthPayload) => void;
  onSignOut: () => void;
  onNicknameUpdate: (nickname: string) => void;
}) {
  const [type, setType] = useState<"DIRECT" | "GROUP">("GROUP");
  const [name, setName] = useState("");
  const [maxUsers, setMaxUsers] = useState("");
  const [expiresInHours, setExpiresInHours] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    onCreateRoom({
      name,
      type,
      maxUsers: type === "GROUP" && maxUsers ? Number(maxUsers) : null,
      expiresInHours: expiresInHours ? Number(expiresInHours) : null
    });
    setName("");
  }

  return (
    <aside className="glass-panel-strong flex flex-col rounded-[28px] border-b border-white/10 p-4 lg:min-h-[calc(100vh-2rem)] lg:border-b-0">
      <div className="mb-6">
        <div className="text-lg font-semibold tracking-[0.01em] text-white">WEBSMITHS ChatApp</div>
        <div className="mt-2 flex items-center gap-2 text-sm text-zinc-400">
          <span className={`h-2.5 w-2.5 rounded-full shadow ${connected ? "bg-emerald-300 shadow-emerald-300/50" : "bg-zinc-500"}`} />
          {authUser ? authUser.email : nickname ? nickname : "No nickname"}
        </div>
      </div>

      <a href="/" className="glass-chip block rounded-2xl px-4 py-3 text-sm font-medium text-zinc-100 hover:bg-white/10">
        WEBSMITHS Global Chat
      </a>

      <form onSubmit={submit} className="glass-panel mt-6 space-y-3 rounded-[24px] p-4">
        <h2 className="text-sm font-semibold text-zinc-100">Create New Chat</h2>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className={`h-10 rounded-2xl text-sm font-medium ${type === "GROUP" ? "liquid-button" : "secondary-button text-zinc-300"}`}
            onClick={() => setType("GROUP")}
          >
            Group
          </button>
          <button
            type="button"
            className={`h-10 rounded-2xl text-sm font-medium ${type === "DIRECT" ? "liquid-button" : "secondary-button text-zinc-300"}`}
            onClick={() => setType("DIRECT")}
          >
            1-to-1
          </button>
        </div>
        <input
          className="glass-input h-10 w-full rounded-2xl px-3 text-sm text-white outline-none"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={type === "DIRECT" ? "Private Chat" : "Group Chat"}
          maxLength={80}
        />
        {type === "GROUP" ? (
          <input
            className="glass-input h-10 w-full rounded-2xl px-3 text-sm text-white outline-none"
            value={maxUsers}
            onChange={(event) => setMaxUsers(event.target.value)}
            placeholder="Max users, blank for unlimited"
            min={2}
            max={500}
            type="number"
          />
        ) : null}
        <input
          className="glass-input h-10 w-full rounded-2xl px-3 text-sm text-white outline-none"
          value={expiresInHours}
          onChange={(event) => setExpiresInHours(event.target.value)}
          placeholder="Expiry hours, blank for none"
          min={1}
          max={720}
          type="number"
        />
        <button
          disabled={!nickname || creating}
          className="liquid-button h-10 w-full rounded-2xl text-sm font-semibold"
        >
          {creating ? "Creating..." : "Create"}
        </button>
      </form>

      <AuthBox authUser={authUser} onAuth={onAuth} onSignOut={onSignOut} />
      <ProfileBox nickname={nickname} authUser={authUser} onNicknameUpdate={onNicknameUpdate} />
    </aside>
  );
}

function ProfileBox({
  nickname,
  authUser,
  onNicknameUpdate
}: {
  nickname: string;
  authUser: AuthUser | null;
  onNicknameUpdate: (nickname: string) => void;
}) {
  const [draft, setDraft] = useState(nickname);

  useEffect(() => setDraft(nickname), [nickname]);

  function submit(event: FormEvent) {
    event.preventDefault();
    onNicknameUpdate(draft);
  }

  return (
    <form onSubmit={submit} className="glass-panel mt-6 space-y-3 rounded-[24px] p-4">
      <h2 className="text-sm font-semibold text-zinc-100">{authUser ? "Account profile" : "Guest profile"}</h2>
      <input
        className="glass-input h-10 w-full rounded-2xl px-3 text-sm text-white outline-none"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Nickname"
        maxLength={32}
      />
      <button className="secondary-button h-10 w-full rounded-2xl text-sm text-zinc-100">
        Save nickname
      </button>
    </form>
  );
}

function AuthBox({
  authUser,
  onAuth,
  onSignOut
}: {
  authUser: AuthUser | null;
  onAuth: (endpoint: "signin" | "signup", payload: AuthPayload) => void;
  onSignOut: () => void;
}) {
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");

  if (authUser) {
    return (
      <div className="glass-panel mt-6 rounded-[24px] p-4">
        <h2 className="text-sm font-semibold text-zinc-100">Account</h2>
        <p className="mt-2 truncate text-sm text-zinc-400">{authUser.nickname}</p>
        <p className="mt-1 text-xs text-zinc-500">{formatBytes(authUser.storageUsedBytes ?? 0)} used</p>
        {authUser.isSiteAdmin ? (
          <a className="mt-3 block rounded-2xl border border-cyan-300/25 bg-cyan-300/10 px-3 py-2 text-center text-sm text-cyan-100 hover:bg-cyan-300/15" href="/admin">
            Manage App
          </a>
        ) : null}
        <button
          className="secondary-button mt-3 h-10 w-full rounded-2xl text-sm text-zinc-100"
          onClick={onSignOut}
        >
          Sign out
        </button>
      </div>
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    onAuth(mode, { email, password, nickname: mode === "signup" ? nickname : undefined });
  }

  return (
    <form onSubmit={submit} className="glass-panel mt-6 space-y-3 rounded-[24px] p-4">
      <h2 className="text-sm font-semibold text-zinc-100">Account</h2>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className={`h-10 rounded-2xl text-sm font-medium ${mode === "signup" ? "liquid-button" : "secondary-button text-zinc-300"}`}
          onClick={() => setMode("signup")}
        >
          Sign up
        </button>
        <button
          type="button"
          className={`h-10 rounded-2xl text-sm font-medium ${mode === "signin" ? "liquid-button" : "secondary-button text-zinc-300"}`}
          onClick={() => setMode("signin")}
        >
          Sign in
        </button>
      </div>
      <input
        className="glass-input h-10 w-full rounded-2xl px-3 text-sm text-white outline-none"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="Email"
        type="email"
        autoComplete="email"
      />
      {mode === "signup" ? (
        <input
          className="glass-input h-10 w-full rounded-2xl px-3 text-sm text-white outline-none"
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          placeholder="Nickname"
          maxLength={32}
          autoComplete="nickname"
        />
      ) : null}
      <input
        className="glass-input h-10 w-full rounded-2xl px-3 text-sm text-white outline-none"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder="Password"
        type="password"
        minLength={8}
        autoComplete={mode === "signup" ? "new-password" : "current-password"}
      />
      <button className="liquid-button h-10 w-full rounded-2xl text-sm font-semibold">
        {mode === "signup" ? "Create account" : "Sign in"}
      </button>
    </form>
  );
}

function MessageRow({
  message,
  isMine,
  groupedWithPrevious,
  groupedWithNext,
  canDelete,
  canEdit,
  onDelete,
  onEdit
}: {
  message: ChatMessage;
  isMine: boolean;
  groupedWithPrevious: boolean;
  groupedWithNext: boolean;
  canDelete: boolean;
  canEdit: boolean;
  onDelete: () => void;
  onEdit: (body: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);

  useEffect(() => setDraft(message.body), [message.body]);

  function submitEdit(event: FormEvent) {
    event.preventDefault();
    onEdit(draft);
    setEditing(false);
  }

  return (
    <article
      className={`message-enter flex ${isMine ? "justify-end" : "justify-start"} ${
        groupedWithPrevious ? "mt-1.5" : "mt-4 first:mt-0"
      } ${groupedWithNext ? "" : "mb-1"}`}
    >
      <div
        className={`glass-panel group w-full max-w-[90%] px-4 py-3 sm:max-w-[82%] ${
          isMine ? "border-cyan-300/20 bg-cyan-300/[0.08]" : ""
        } ${
          groupedWithPrevious
            ? isMine
              ? "rounded-[24px] rounded-tr-[12px]"
              : "rounded-[24px] rounded-tl-[12px]"
            : isMine
              ? "rounded-[28px] rounded-br-[18px]"
              : "rounded-[28px] rounded-bl-[18px]"
        } ${
          groupedWithNext
            ? isMine
              ? "rounded-br-[12px]"
              : "rounded-bl-[12px]"
            : ""
        }`}
      >
        <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {!groupedWithPrevious ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-zinc-100">{message.member.nickname}</span>
              <span className="glass-chip rounded-full px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-zinc-300">{roleLabel[message.member.role]}</span>
              <time className="text-xs text-zinc-500">{new Date(message.createdAt).toLocaleTimeString()}</time>
              {message.editedAt && !message.deletedAt ? <span className="text-xs italic text-zinc-500">edited</span> : null}
            </div>
          ) : (
            <div className="mb-1 flex items-center gap-2 text-[11px] text-zinc-500">
              <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
              {message.editedAt && !message.deletedAt ? <span className="italic">edited</span> : null}
            </div>
          )}
          {editing ? (
            <form onSubmit={submitEdit} className="mt-3 flex gap-2">
              <input
                className="glass-input h-10 min-w-0 flex-1 rounded-2xl px-3 text-sm text-white outline-none"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={1200}
              />
              <button className="liquid-button rounded-2xl px-4 text-sm font-semibold">Save</button>
            </form>
          ) : (
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-zinc-200">
              {message.deletedAt ? "Message deleted" : message.body}
            </p>
          )}
          {!message.deletedAt && message.attachments.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {message.attachments.map((attachment) => (
                <AttachmentCard key={attachment.id} attachment={attachment} />
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1">
          {canEdit ? (
            <button type="button" className="secondary-button rounded-full px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100" onClick={() => setEditing((value) => !value)}>
              Edit
            </button>
          ) : null}
          {canDelete ? (
            <button type="button" className="rounded-full px-3 py-1.5 text-xs text-zinc-400 hover:bg-red-400/10 hover:text-red-200" onClick={onDelete}>
              Delete
            </button>
          ) : null}
        </div>
      </div>
      </div>
    </article>
  );
}

function AttachmentCard({
  attachment,
  compact,
  onRemove
}: {
  attachment: Attachment;
  compact?: boolean;
  onRemove?: () => void;
}) {
  const expired = attachment.deletedAt || (attachment.expiresAt && new Date(attachment.expiresAt).getTime() <= Date.now());
  const size = formatBytes(attachment.byteSize);

  if (expired) {
    return (
      <div className="glass-panel rounded-2xl px-3 py-2 text-sm text-zinc-500">
        {attachment.deletedReason === "inactivity" ? "File removed due to inactivity policy" : "Attachment expired"}
      </div>
    );
  }

  return (
    <div className={`glass-panel relative overflow-hidden rounded-[22px] ${compact ? "w-40" : "max-w-xs"}`}>
      {onRemove ? (
        <button type="button" className="secondary-button absolute right-2 top-2 z-10 rounded-full px-2.5 py-1 text-xs text-white" onClick={onRemove}>
          x
        </button>
      ) : null}
      {attachment.kind === "image" || attachment.kind === "gif" ? (
        <img src={attachment.url} alt={attachment.originalName} className="max-h-56 w-full object-cover" />
      ) : attachment.kind === "video" ? (
        <video src={attachment.url} className="max-h-56 w-full bg-black" controls playsInline />
      ) : (
        <a href={attachment.url} className="block p-4 text-sm text-zinc-100">
          <div className="font-medium">PDF</div>
          <div className="mt-1 truncate text-zinc-400">{attachment.originalName}</div>
          <div className="mt-1 text-xs text-zinc-500">{size}</div>
        </a>
      )}
      {attachment.kind !== "pdf" ? (
        <div className="px-3 py-2 text-xs text-zinc-400">
          <div className="truncate">{attachment.originalName}</div>
          <div>{size}</div>
        </div>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function MemberPanel({
  room,
  members,
  me,
  isOwner,
  onPromote,
  onDemote,
  onTransfer,
  onRecover
}: {
  room: Room | null;
  members: Member[];
  me: Member | null;
  isOwner: boolean;
  onPromote: (id: string) => void;
  onDemote: (id: string) => void;
  onTransfer: (id: string) => void;
  onRecover: (code: string) => void;
}) {
  const [recoveryCode, setRecoveryCode] = useState("");

  function submitRecovery(event: FormEvent) {
    event.preventDefault();
    if (!recoveryCode.trim()) return;
    onRecover(recoveryCode);
    setRecoveryCode("");
  }

  return (
    <aside className="glass-shell border-t border-white/10 p-4 xl:border-l xl:border-t-0">
      <h2 className="mb-3 text-sm font-semibold text-zinc-100">Members</h2>
      <div className="space-y-2">
        {members.map((member) => {
          const isSelf = me?.id === member.id;
          return (
            <div key={member.id} className="glass-panel rounded-[22px] p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-zinc-100">
                    {member.nickname}
                    {isSelf ? " (you)" : ""}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">{roleLabel[member.role]}</div>
                </div>
              </div>
              {isOwner && !isSelf ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {member.role === "guest" ? (
                    <button className="secondary-button rounded-full px-3 py-1.5 text-xs text-zinc-100" onClick={() => onPromote(member.id)}>
                      Promote
                    </button>
                  ) : null}
                  {member.role === "admin" ? (
                    <button className="secondary-button rounded-full px-3 py-1.5 text-xs text-zinc-100" onClick={() => onDemote(member.id)}>
                      Demote
                    </button>
                  ) : null}
                  <button className="rounded-full bg-amber-300/15 px-3 py-1.5 text-xs text-amber-100 hover:bg-amber-300/25" onClick={() => onTransfer(member.id)}>
                    Transfer
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {room && room.slug !== "global" ? (
        <form onSubmit={submitRecovery} className="glass-panel mt-5 space-y-3 rounded-[22px] p-3">
          <h3 className="text-sm font-semibold text-zinc-100">Recover ownership</h3>
          <input
            className="glass-input h-10 w-full rounded-2xl px-3 text-sm text-white outline-none"
            value={recoveryCode}
            onChange={(event) => setRecoveryCode(event.target.value)}
            placeholder="Recovery code"
            autoComplete="off"
          />
          <button className="secondary-button h-10 w-full rounded-2xl text-sm text-zinc-100">
            Recover
          </button>
        </form>
      ) : null}
    </aside>
  );
}

function LoadingConversation() {
  return (
    <div className="space-y-3">
      <div className="glass-panel-strong loading-pulse rounded-[24px] p-4">
        <div className="text-sm font-medium text-zinc-200">Opening WEBSMITHS ChatApp</div>
        <div className="mt-2 text-sm text-zinc-400">Preparing your room, messages, and live connection...</div>
      </div>
      {[0, 1, 2].map((item) => (
        <div key={item} className={`glass-panel loading-shimmer rounded-[24px] p-4 ${item === 1 ? "ml-auto max-w-[85%]" : "max-w-[80%]"}`}>
          <div className="mb-3 flex items-center gap-2">
            <div className="h-3 w-24 rounded-full bg-white/10" />
            <div className="h-2.5 w-16 rounded-full bg-white/10" />
          </div>
          <div className="h-3 rounded-full bg-white/10" />
          <div className="mt-2 h-3 w-4/5 rounded-full bg-white/10" />
        </div>
      ))}
    </div>
  );
}

function TypingIndicator({ members }: { members: TypingMember[] }) {
  if (members.length === 0) {
    return <div className="h-8" />;
  }

  const names = members.map((member) => member.nickname);
  const label =
    names.length === 1
      ? `${names[0]} is typing`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing`
        : `${names[0]}, ${names[1]}, and others are typing`;

  return (
    <div className="glass-chip inline-flex h-8 items-center gap-2 rounded-full px-3 text-xs text-zinc-300">
      <div className="flex items-center gap-1">
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-cyan-200" />
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-cyan-200" />
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-cyan-200" />
      </div>
      <span>{label}</span>
    </div>
  );
}

function shouldGroupMessages(previous: ChatMessage | undefined, current: ChatMessage | undefined) {
  if (!previous || !current) return false;
  if (previous.member.id !== current.member.id) return false;
  if (Boolean(previous.deletedAt) !== Boolean(current.deletedAt)) return false;

  const previousTime = new Date(previous.createdAt).getTime();
  const currentTime = new Date(current.createdAt).getTime();
  return Math.abs(currentTime - previousTime) <= 5 * 60 * 1000;
}
