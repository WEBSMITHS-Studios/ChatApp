import Head from "next/head";
import { useRouter } from "next/router";
import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import type { Attachment, ChatMessage, JoinResponse, Member, Room, RoomRole } from "./types";

type Ack<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };
type AuthUser = { id: string; email: string; nickname: string; storageUsedBytes?: number; isSiteAdmin?: boolean };

const roleLabel: Record<RoomRole, string> = {
  guest: "Guest",
  admin: "Admin",
  super_admin: "Owner"
};

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
  const [messageDraft, setMessageDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [ownerRecoveryCode, setOwnerRecoveryCode] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const meIdRef = useRef<string | null>(null);

  const shareUrl = useMemo(() => {
    if (!room || typeof window === "undefined") return "";
    return room.slug === "global" ? window.location.origin : `${window.location.origin}/room/${room.slug}`;
  }, [room]);

  useEffect(() => {
    const storedIdentity = localStorage.getItem("websmiths-chatapp.identityId") || crypto.randomUUID();
    localStorage.setItem("websmiths-chatapp.identityId", storedIdentity);
    setGuestIdentityId(storedIdentity);
    setIdentityId(storedIdentity);

    const storedNickname = localStorage.getItem("websmiths-chatapp.nickname") || "";
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
      .catch(() => undefined);
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

    const code = sessionStorage.getItem(`websmiths-chatapp.ownerRecovery.${slug}`);
    if (code) {
      setOwnerRecoveryCode(code);
      sessionStorage.removeItem(`websmiths-chatapp.ownerRecovery.${slug}`);
    }
  }, [slug]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  function saveNickname(event: FormEvent) {
    event.preventDefault();
    const clean = nicknameDraft.trim().replace(/\s+/g, " ").slice(0, 32);
    if (!clean) return;
    localStorage.setItem("websmiths-chatapp.nickname", clean);
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
    localStorage.setItem("websmiths-chatapp.nickname", json.user.nickname);
  }

  async function signOut() {
    await fetch("/api/auth/me", { method: "DELETE" });
    setAuthUser(null);
    setIdentityId(guestIdentityId);
    setNickname(localStorage.getItem("websmiths-chatapp.nickname") || "");
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
      localStorage.setItem("websmiths-chatapp.nickname", clean);
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
        sessionStorage.setItem(`websmiths-chatapp.ownerRecovery.${json.room.slug}`, json.ownerRecoveryCode);
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

      <main className="min-h-screen bg-ink-950 text-zinc-100">
        <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)]">
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

          <section className="flex min-h-screen flex-col">
            <header className="border-b border-white/10 bg-ink-900/90 px-5 py-4 backdrop-blur">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h1 className="text-xl font-semibold tracking-normal">{room?.name ?? "Joining chat..."}</h1>
                  <p className="mt-1 text-sm text-zinc-400">
                    {room?.type === "DIRECT" ? "Private 1-to-1 room" : room?.slug === "global" ? "Global chat" : "Group room"} | {onlineCount} online
                    {room?.maxUsers ? ` | ${members.length}/${room.maxUsers} members` : ""}
                    {room?.expiresAt ? ` | expires ${new Date(room.expiresAt).toLocaleString()}` : ""}
                  </p>
                </div>
                {shareUrl ? (
                  <button
                    className="h-10 rounded-md border border-white/10 bg-white/5 px-3 text-sm text-zinc-200 transition hover:bg-white/10"
                    onClick={() => navigator.clipboard.writeText(shareUrl)}
                  >
                    Copy link
                  </button>
                ) : null}
              </div>
            </header>

            {error ? (
              <div className="border-b border-red-400/20 bg-red-950/40 px-5 py-3 text-sm text-red-100">{error}</div>
            ) : null}

            <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px]">
              <div className="flex min-h-0 flex-col">
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-5">
                  {messages.map((message) => (
                    <MessageRow
                      key={message.id}
                      message={message}
                      isMine={me?.id === message.member.id}
                      canDelete={(canDelete || me?.id === message.member.id) && !message.deletedAt}
                      canEdit={me?.id === message.member.id && !message.deletedAt}
                      onDelete={() => deleteMessage(message.id)}
                      onEdit={(body) => editMessage(message.id, body)}
                    />
                  ))}
                  <div ref={bottomRef} />
                </div>

                <form onSubmit={sendMessage} className="border-t border-white/10 bg-ink-900 px-4 py-4">
                  {pendingAttachments.length ? (
                    <div className="mb-3 flex gap-2 overflow-x-auto">
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
                    <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                      <div className="h-full bg-teal-300 transition-all" style={{ width: `${Math.max(uploadProgress, 8)}%` }} />
                    </div>
                  ) : null}
                  <div className="flex gap-3">
                    <label className="grid h-12 w-12 shrink-0 cursor-pointer place-items-center rounded-md border border-white/10 bg-white/5 text-lg text-zinc-200 hover:bg-white/10">
                      +
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
                      className="h-12 min-w-0 flex-1 rounded-md border border-white/10 bg-ink-800 px-4 text-sm outline-none ring-teal-400/30 placeholder:text-zinc-500 focus:ring-4"
                      value={messageDraft}
                      onChange={(event) => setMessageDraft(event.target.value)}
                      placeholder={nickname ? "Type a message..." : "Choose a nickname to chat"}
                      maxLength={1200}
                      disabled={!nickname || !room}
                    />
                    <button className="h-12 rounded-md bg-teal-400 px-4 text-sm font-semibold text-ink-950 transition hover:bg-teal-300 sm:px-5">
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
          <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
            <form onSubmit={saveNickname} className="w-full max-w-sm rounded-lg border border-white/10 bg-ink-900 p-5 shadow-2xl">
              <h2 className="text-lg font-semibold">Choose a nickname</h2>
              <input
                autoFocus
                className="mt-4 h-11 w-full rounded-md border border-white/10 bg-ink-800 px-3 text-sm outline-none ring-teal-400/30 focus:ring-4"
                value={nicknameDraft}
                onChange={(event) => setNicknameDraft(event.target.value)}
                maxLength={32}
                placeholder="Nickname"
              />
              <button className="mt-4 h-11 w-full rounded-md bg-teal-400 text-sm font-semibold text-ink-950 hover:bg-teal-300">
                Join chat
              </button>
            </form>
          </div>
        ) : null}

        {ownerRecoveryCode && room ? (
          <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-lg border border-white/10 bg-ink-900 p-5 shadow-2xl">
              <h2 className="text-lg font-semibold">Owner recovery code</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Save this code now. It can restore ownership for {room.name} and will not be shown again.
              </p>
              <code className="mt-4 block break-all rounded-md border border-white/10 bg-ink-800 p-3 text-sm text-teal-100">
                {ownerRecoveryCode}
              </code>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <button
                  className="h-11 rounded-md border border-white/10 bg-white/5 text-sm text-zinc-200 hover:bg-white/10"
                  onClick={() => navigator.clipboard.writeText(ownerRecoveryCode)}
                >
                  Copy
                </button>
                <button
                  className="h-11 rounded-md bg-teal-400 text-sm font-semibold text-ink-950 hover:bg-teal-300"
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
    <aside className="border-b border-white/10 bg-ink-900 p-4 lg:min-h-screen lg:border-b-0 lg:border-r">
      <div className="mb-6">
        <div className="text-lg font-semibold">WEBSMITHS ChatApp</div>
        <div className="mt-2 flex items-center gap-2 text-sm text-zinc-400">
          <span className={`h-2 w-2 rounded-full ${connected ? "bg-teal-300" : "bg-zinc-500"}`} />
          {authUser ? authUser.email : nickname ? nickname : "No nickname"}
        </div>
      </div>

      <a href="/" className="block rounded-md bg-white/[0.08] px-3 py-3 text-sm font-medium text-zinc-100 hover:bg-white/10">
        WEBSMITHS Global Chat
      </a>

      <form onSubmit={submit} className="mt-6 space-y-3 rounded-lg border border-white/10 bg-ink-800 p-4">
        <h2 className="text-sm font-semibold text-zinc-100">Create New Chat</h2>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className={`h-10 rounded-md text-sm ${type === "GROUP" ? "bg-teal-400 text-ink-950" : "bg-white/5 text-zinc-300"}`}
            onClick={() => setType("GROUP")}
          >
            Group
          </button>
          <button
            type="button"
            className={`h-10 rounded-md text-sm ${type === "DIRECT" ? "bg-teal-400 text-ink-950" : "bg-white/5 text-zinc-300"}`}
            onClick={() => setType("DIRECT")}
          >
            1-to-1
          </button>
        </div>
        <input
          className="h-10 w-full rounded-md border border-white/10 bg-ink-900 px-3 text-sm outline-none focus:ring-4 focus:ring-teal-400/30"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={type === "DIRECT" ? "Private Chat" : "Group Chat"}
          maxLength={80}
        />
        {type === "GROUP" ? (
          <input
            className="h-10 w-full rounded-md border border-white/10 bg-ink-900 px-3 text-sm outline-none focus:ring-4 focus:ring-teal-400/30"
            value={maxUsers}
            onChange={(event) => setMaxUsers(event.target.value)}
            placeholder="Max users, blank for unlimited"
            min={2}
            max={500}
            type="number"
          />
        ) : null}
        <input
          className="h-10 w-full rounded-md border border-white/10 bg-ink-900 px-3 text-sm outline-none focus:ring-4 focus:ring-teal-400/30"
          value={expiresInHours}
          onChange={(event) => setExpiresInHours(event.target.value)}
          placeholder="Expiry hours, blank for none"
          min={1}
          max={720}
          type="number"
        />
        <button
          disabled={!nickname || creating}
          className="h-10 w-full rounded-md bg-teal-400 text-sm font-semibold text-ink-950 hover:bg-teal-300"
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
    <form onSubmit={submit} className="mt-6 space-y-3 rounded-lg border border-white/10 bg-ink-800 p-4">
      <h2 className="text-sm font-semibold text-zinc-100">{authUser ? "Account profile" : "Guest profile"}</h2>
      <input
        className="h-10 w-full rounded-md border border-white/10 bg-ink-900 px-3 text-sm outline-none focus:ring-4 focus:ring-teal-400/30"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Nickname"
        maxLength={32}
      />
      <button className="h-10 w-full rounded-md border border-white/10 bg-white/5 text-sm text-zinc-200 hover:bg-white/10">
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
      <div className="mt-6 rounded-lg border border-white/10 bg-ink-800 p-4">
        <h2 className="text-sm font-semibold text-zinc-100">Account</h2>
        <p className="mt-2 truncate text-sm text-zinc-400">{authUser.nickname}</p>
        <p className="mt-1 text-xs text-zinc-500">{formatBytes(authUser.storageUsedBytes ?? 0)} used</p>
        {authUser.isSiteAdmin ? (
          <a className="mt-3 block rounded-md border border-teal-300/30 bg-teal-300/10 px-3 py-2 text-center text-sm text-teal-100 hover:bg-teal-300/20" href="/admin">
            Manage App
          </a>
        ) : null}
        <button
          className="mt-3 h-10 w-full rounded-md border border-white/10 bg-white/5 text-sm text-zinc-200 hover:bg-white/10"
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
    <form onSubmit={submit} className="mt-6 space-y-3 rounded-lg border border-white/10 bg-ink-800 p-4">
      <h2 className="text-sm font-semibold text-zinc-100">Account</h2>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className={`h-10 rounded-md text-sm ${mode === "signup" ? "bg-teal-400 text-ink-950" : "bg-white/5 text-zinc-300"}`}
          onClick={() => setMode("signup")}
        >
          Sign up
        </button>
        <button
          type="button"
          className={`h-10 rounded-md text-sm ${mode === "signin" ? "bg-teal-400 text-ink-950" : "bg-white/5 text-zinc-300"}`}
          onClick={() => setMode("signin")}
        >
          Sign in
        </button>
      </div>
      <input
        className="h-10 w-full rounded-md border border-white/10 bg-ink-900 px-3 text-sm outline-none focus:ring-4 focus:ring-teal-400/30"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="Email"
        type="email"
        autoComplete="email"
      />
      {mode === "signup" ? (
        <input
          className="h-10 w-full rounded-md border border-white/10 bg-ink-900 px-3 text-sm outline-none focus:ring-4 focus:ring-teal-400/30"
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          placeholder="Nickname"
          maxLength={32}
          autoComplete="nickname"
        />
      ) : null}
      <input
        className="h-10 w-full rounded-md border border-white/10 bg-ink-900 px-3 text-sm outline-none focus:ring-4 focus:ring-teal-400/30"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder="Password"
        type="password"
        minLength={8}
        autoComplete={mode === "signup" ? "new-password" : "current-password"}
      />
      <button className="h-10 w-full rounded-md bg-teal-400 text-sm font-semibold text-ink-950 hover:bg-teal-300">
        {mode === "signup" ? "Create account" : "Sign in"}
      </button>
    </form>
  );
}

function MessageRow({
  message,
  isMine,
  canDelete,
  canEdit,
  onDelete,
  onEdit
}: {
  message: ChatMessage;
  isMine: boolean;
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
    <article className={`group rounded-lg px-4 py-3 ${isMine ? "bg-teal-300/[0.08]" : "bg-white/[0.04]"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-zinc-100">{message.member.nickname}</span>
            <span className="rounded bg-white/[0.08] px-2 py-0.5 text-xs text-zinc-400">{roleLabel[message.member.role]}</span>
            <time className="text-xs text-zinc-500">{new Date(message.createdAt).toLocaleTimeString()}</time>
            {message.editedAt && !message.deletedAt ? <span className="text-xs text-zinc-500">edited</span> : null}
          </div>
          {editing ? (
            <form onSubmit={submitEdit} className="mt-3 flex gap-2">
              <input
                className="h-10 min-w-0 flex-1 rounded-md border border-white/10 bg-ink-900 px-3 text-sm outline-none focus:ring-4 focus:ring-teal-400/30"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={1200}
              />
              <button className="rounded-md bg-teal-400 px-3 text-sm font-semibold text-ink-950">Save</button>
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
            <button type="button" className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100" onClick={() => setEditing((value) => !value)}>
              Edit
            </button>
          ) : null}
          {canDelete ? (
            <button type="button" className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-red-400/10 hover:text-red-200" onClick={onDelete}>
              Delete
            </button>
          ) : null}
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
      <div className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-500">
        {attachment.deletedReason === "inactivity" ? "File removed due to inactivity policy" : "Attachment expired"}
      </div>
    );
  }

  return (
    <div className={`relative overflow-hidden rounded-lg border border-white/10 bg-white/[0.05] ${compact ? "w-40" : "max-w-xs"}`}>
      {onRemove ? (
        <button type="button" className="absolute right-1 top-1 z-10 rounded bg-black/60 px-2 py-0.5 text-xs text-white" onClick={onRemove}>
          x
        </button>
      ) : null}
      {attachment.kind === "image" || attachment.kind === "gif" ? (
        <img src={attachment.url} alt={attachment.originalName} className="max-h-56 w-full object-cover" />
      ) : attachment.kind === "video" ? (
        <video src={attachment.url} className="max-h-56 w-full bg-black" controls playsInline />
      ) : (
        <a href={attachment.url} className="block p-3 text-sm text-zinc-100">
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
    <aside className="border-t border-white/10 bg-ink-900 p-4 xl:border-l xl:border-t-0">
      <h2 className="mb-3 text-sm font-semibold text-zinc-100">Members</h2>
      <div className="space-y-2">
        {members.map((member) => {
          const isSelf = me?.id === member.id;
          return (
            <div key={member.id} className="rounded-lg bg-white/[0.04] p-3">
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
                    <button className="rounded-md bg-white/[0.08] px-2 py-1 text-xs text-zinc-200 hover:bg-white/[0.12]" onClick={() => onPromote(member.id)}>
                      Promote
                    </button>
                  ) : null}
                  {member.role === "admin" ? (
                    <button className="rounded-md bg-white/[0.08] px-2 py-1 text-xs text-zinc-200 hover:bg-white/[0.12]" onClick={() => onDemote(member.id)}>
                      Demote
                    </button>
                  ) : null}
                  <button className="rounded-md bg-amber-300/15 px-2 py-1 text-xs text-amber-100 hover:bg-amber-300/25" onClick={() => onTransfer(member.id)}>
                    Transfer
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {room && room.slug !== "global" ? (
        <form onSubmit={submitRecovery} className="mt-5 space-y-3 rounded-lg border border-white/10 bg-white/[0.04] p-3">
          <h3 className="text-sm font-semibold text-zinc-100">Recover ownership</h3>
          <input
            className="h-10 w-full rounded-md border border-white/10 bg-ink-900 px-3 text-sm outline-none focus:ring-4 focus:ring-teal-400/30"
            value={recoveryCode}
            onChange={(event) => setRecoveryCode(event.target.value)}
            placeholder="Recovery code"
            autoComplete="off"
          />
          <button className="h-10 w-full rounded-md border border-white/10 bg-white/5 text-sm text-zinc-200 hover:bg-white/10">
            Recover
          </button>
        </form>
      ) : null}
    </aside>
  );
}
