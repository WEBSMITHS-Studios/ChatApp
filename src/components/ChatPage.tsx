import Head from "next/head";
import { useRouter } from "next/router";
import { ChangeEvent, FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import type { Attachment, ChatMessage, JoinResponse, Member, Room, RoomRole, TypingMember } from "./types";

type Ack<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };
type AuthMode = "signin" | "signup";
type CreateRoomType = "DIRECT" | "GROUP";
type AuthUser = { id: string; email: string; nickname: string; storageUsedBytes?: number; isSiteAdmin?: boolean };
type ChatDetailsTab = "about" | "members";
type RoomUpdatePayload = { room: Room };
type MemberAction = "member:promote" | "member:demote" | "member:transfer" | "member:remove";

type CreateRoomForm = {
  name: string;
  type: CreateRoomType;
  maxUsers: number | null;
  expiresInHours: number | null;
};

type AuthPayload = {
  email: string;
  password: string;
  nickname?: string;
};

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
const callFeatureMessage =
  "Due to government regulations, this feature is not available yet. It should arrive in a future update.";

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
  const [authModalMode, setAuthModalMode] = useState<AuthMode | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsTab, setDetailsTab] = useState<ChatDetailsTab>("about");
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [createModalType, setCreateModalType] = useState<CreateRoomType | null>(null);
  const [roomNameDraft, setRoomNameDraft] = useState("");
  const [savingRoomName, setSavingRoomName] = useState(false);
  const [profileNicknameDraft, setProfileNicknameDraft] = useState("");
  const socketRef = useRef<Socket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const meIdRef = useRef<string | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);

  const shareUrl = useMemo(() => {
    if (!room || typeof window === "undefined") return "";
    return room.slug === "global" ? window.location.origin : `${window.location.origin}/room/${room.slug}`;
  }, [room]);

  const isOwner = me?.role === "super_admin";
  const canDelete = me?.role === "admin" || me?.role === "super_admin";
  const canManageMembers = Boolean(room && room.slug !== "global" && room.type === "GROUP" && isOwner);
  const canRenameRoom = Boolean(room && room.slug !== "global" && (room.type === "DIRECT" || isOwner));
  const showGuestPrompt = !booting && !authUser && !nickname;

  useEffect(() => {
    const storedIdentity =
      localStorage.getItem(identityStorageKey) || localStorage.getItem(legacyIdentityStorageKey) || crypto.randomUUID();
    localStorage.setItem(identityStorageKey, storedIdentity);
    document.cookie = `${guestIdentityCookieName}=${encodeURIComponent(storedIdentity)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    setGuestIdentityId(storedIdentity);
    setIdentityId(storedIdentity);

    const storedNickname = localStorage.getItem(nicknameStorageKey) || localStorage.getItem(legacyNicknameStorageKey) || "";
    setNickname(storedNickname);
    setNicknameDraft(storedNickname);
    setProfileNicknameDraft(storedNickname);

    fetch("/api/auth/me")
      .then((response) => response.json())
      .then((json: { user: AuthUser | null }) => {
        if (!json.user) return;
        setAuthUser(json.user);
        setIdentityId(`user:${json.user.id}`);
        setNickname(json.user.nickname);
        setNicknameDraft(json.user.nickname);
        setProfileNicknameDraft(json.user.nickname);
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
    socket.on("room:updated", (payload: RoomUpdatePayload) => {
      setRoom(payload.room);
      setRoomNameDraft(payload.room.name);
    });
    socket.on("room:kicked", (payload: { roomId: string; memberId: string }) => {
      if (payload.memberId !== meIdRef.current) return;
      setError("You were removed from that chat.");
      setDetailsOpen(false);
      void router.push("/");
    });

    socket.emit("room:join", { slug, identityId, nickname }, (ack: Ack<JoinResponse>) => {
      if (!ack.ok) {
        setError(ack.error);
        return;
      }
      if (!ack.data) return;
      setRoom(ack.data.room);
      setRoomNameDraft(ack.data.room.name);
      setMe(ack.data.me);
      meIdRef.current = ack.data.me.id;
      setMembers(ack.data.members);
      setMessages(ack.data.messages);
      setOnlineCount(ack.data.onlineCount);
      setTypingMembers([]);
      setError("");
    });

    return () => {
      socket.disconnect();
    };
  }, [slug, identityId, nickname, router]);

  useEffect(() => {
    meIdRef.current = me?.id ?? null;
  }, [me?.id]);

  useEffect(() => {
    setProfileNicknameDraft(authUser?.nickname ?? nickname);
  }, [authUser?.nickname, nickname]);

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

  function openAuthModal(mode: AuthMode) {
    setAuthModalMode(mode);
    setProfileOpen(false);
  }

  async function handleAuth(endpoint: AuthMode, payload: AuthPayload) {
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
    setProfileNicknameDraft(json.user.nickname);
    localStorage.setItem(nicknameStorageKey, json.user.nickname);
    setAuthModalMode(null);
  }

  async function signOut() {
    await fetch("/api/auth/me", { method: "DELETE" });
    setAuthUser(null);
    setIdentityId(guestIdentityId);
    document.cookie = `${guestIdentityCookieName}=${encodeURIComponent(guestIdentityId)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    const storedNickname = localStorage.getItem(nicknameStorageKey) || localStorage.getItem(legacyNicknameStorageKey) || "";
    setNickname(storedNickname);
    setNicknameDraft(storedNickname);
    setProfileNicknameDraft(storedNickname);
    setProfileOpen(false);
  }

  function persistGuestNickname(clean: string) {
    localStorage.setItem(nicknameStorageKey, clean);
    setNickname(clean);
    setNicknameDraft(clean);
    setProfileNicknameDraft(clean);
  }

  function saveNickname(event: FormEvent) {
    event.preventDefault();
    const clean = sanitizeNickname(nicknameDraft);
    if (!clean) {
      setError("Nickname is required");
      return;
    }
    persistGuestNickname(clean);
    setError("");
  }

  async function updateProfileNickname(event: FormEvent) {
    event.preventDefault();
    const clean = sanitizeNickname(profileNicknameDraft);
    if (!clean) {
      setError("Nickname is required");
      return;
    }

    if (authUser) {
      if (room && socketRef.current) {
        socketRef.current.emit("nickname:update", { roomId: room.id, nickname: clean }, (ack: Ack<{ nickname: string }>) => {
          if (!ack.ok) {
            setError(ack.error);
            return;
          }
          const nextNickname = ack.data?.nickname ?? clean;
          setAuthUser((current) => (current ? { ...current, nickname: nextNickname } : current));
          setNickname(nextNickname);
          setNicknameDraft(nextNickname);
          setProfileNicknameDraft(nextNickname);
          localStorage.setItem(nicknameStorageKey, nextNickname);
          setProfileOpen(false);
          setError("");
        });
        return;
      }

      const response = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: clean })
      });
      const json = await response.json();
      if (!response.ok) {
        setError(json.error || "Could not update nickname");
        return;
      }
      setAuthUser(json.user);
      setNickname(json.user.nickname);
      setNicknameDraft(json.user.nickname);
      setProfileNicknameDraft(json.user.nickname);
      localStorage.setItem(nicknameStorageKey, json.user.nickname);
      setProfileOpen(false);
      setError("");
      return;
    }

    if (room && socketRef.current) {
      socketRef.current.emit("nickname:update", { roomId: room.id, nickname: clean }, (ack: Ack<{ nickname: string }>) => {
        if (!ack.ok) {
          setError(ack.error);
          return;
        }
        const nextNickname = ack.data?.nickname ?? clean;
        persistGuestNickname(nextNickname);
        setProfileOpen(false);
        setError("");
      });
      return;
    }

    persistGuestNickname(clean);
    setProfileOpen(false);
    setError("");
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
      setCreateModalType(null);
      setCreateMenuOpen(false);
      await router.push(`/room/${json.room.slug}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create room");
    } finally {
      setCreating(false);
    }
  }

  function moderate(event: Exclude<MemberAction, "member:remove">, targetMemberId: string) {
    if (!room || !socketRef.current) return;
    socketRef.current.emit(event, { roomId: room.id, targetMemberId }, (ack: Ack) => {
      if (!ack.ok) setError(ack.error);
    });
  }

  function removeMember(targetMemberId: string) {
    if (!room || !socketRef.current) return;
    socketRef.current.emit("member:remove", { roomId: room.id, targetMemberId }, (ack: Ack) => {
      if (!ack.ok) {
        setError(ack.error);
        return;
      }
      setError("");
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

  function renameRoom(event: FormEvent) {
    event.preventDefault();
    if (!room || !socketRef.current) return;
    setSavingRoomName(true);
    socketRef.current.emit("room:rename", { roomId: room.id, name: roomNameDraft }, (ack: Ack<{ name: string }>) => {
      setSavingRoomName(false);
      if (!ack.ok) {
        setError(ack.error);
        return;
      }
      const nextName = ack.data?.name ?? roomNameDraft;
      setRoom((current) => (current ? { ...current, name: nextName } : current));
      setRoomNameDraft(nextName);
      setError("");
    });
  }

  function openCreate(type: CreateRoomType) {
    setCreateMenuOpen(false);
    setCreateModalType(type);
  }

  return (
    <>
      <Head>
        <title>{room ? `${room.name} | WEBSMITHS ChatApp` : "WEBSMITHS ChatApp"}</title>
        <meta name="description" content="WEBSMITHS ChatApp for guest and account-backed realtime rooms" />
      </Head>

      <main className="relative min-h-screen overflow-x-hidden bg-ink-950 text-zinc-100">
        <div className="ambient-orb left-[-6rem] top-[-5rem] h-40 w-40 bg-sky-300/30" />
        <div className="ambient-orb bottom-16 right-[-4rem] h-48 w-48 bg-emerald-300/20" />

        <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col gap-3 p-3 lg:p-4">
          <GlobalHeader
            connected={connected}
            authUser={authUser}
            onMenu={() => setDrawerOpen(true)}
            onAuth={openAuthModal}
            onProfile={() => setProfileOpen(true)}
          />

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
            <div className="hidden lg:block">
              <SidebarContent
                nickname={nickname}
                authUser={authUser}
                connected={connected}
                onEditProfile={() => setProfileOpen(true)}
                onSetGuestNickname={() => setProfileOpen(true)}
              />
            </div>

            <section className="glass-panel-strong flex min-h-[calc(100vh-7rem)] flex-col overflow-hidden rounded-[32px]">
              <ChatTopBar
                room={room}
                shareUrl={shareUrl}
                onlineCount={onlineCount}
                memberCount={members.length}
                onOpenDetails={() => setDetailsOpen(true)}
              />

              {error ? (
                <div className="border-b border-red-400/20 bg-red-950/40 px-5 py-3 text-sm text-red-100 backdrop-blur">{error}</div>
              ) : null}

              <div className="flex min-h-0 flex-1 flex-col">
                <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-4 sm:px-5">
                  {showGuestPrompt ? (
                    <GuestSetupInline
                      nicknameDraft={nicknameDraft}
                      onNicknameDraft={setNicknameDraft}
                      onSubmit={saveNickname}
                      onSignin={() => openAuthModal("signin")}
                      onSignup={() => openAuthModal("signup")}
                    />
                  ) : !room && booting ? (
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
                      <div
                        className="h-2 bg-gradient-to-r from-sky-300 via-cyan-200 to-emerald-300 transition-all"
                        style={{ width: `${Math.max(uploadProgress, 8)}%` }}
                      />
                    </div>
                  ) : null}
                  <div className="glass-panel flex items-end gap-2 rounded-[24px] p-2 sm:gap-3">
                    <label
                      className="secondary-button grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-2xl text-lg text-zinc-100 sm:h-12 sm:w-12"
                      aria-label="Add attachments"
                    >
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
                      placeholder={nickname ? "Type a message..." : "Choose a nickname or sign in to chat"}
                      maxLength={1200}
                      disabled={!nickname || !room}
                    />
                    <button className="liquid-button h-11 rounded-2xl px-4 text-sm font-semibold sm:h-12 sm:px-5" disabled={!nickname || !room}>
                      Send
                    </button>
                  </div>
                </form>
              </div>
            </section>
          </div>
        </div>

        <FloatingCreateButton disabled={!nickname} open={createMenuOpen} onToggle={() => setCreateMenuOpen((value) => !value)} />

        {createMenuOpen ? (
          <CreateActionSheet
            onClose={() => setCreateMenuOpen(false)}
            onCreateGroup={() => openCreate("GROUP")}
            onCreateDirect={() => openCreate("DIRECT")}
          />
        ) : null}

        {createModalType ? (
          <CreateRoomModal
            creating={creating}
            type={createModalType}
            onClose={() => setCreateModalType(null)}
            onSubmit={createRoom}
          />
        ) : null}

        {drawerOpen ? (
          <MobileDrawer onClose={() => setDrawerOpen(false)}>
            <SidebarContent
              nickname={nickname}
              authUser={authUser}
              connected={connected}
              onEditProfile={() => {
                setDrawerOpen(false);
                setProfileOpen(true);
              }}
              onSetGuestNickname={() => {
                setDrawerOpen(false);
                setProfileOpen(true);
              }}
            />
          </MobileDrawer>
        ) : null}

        {authModalMode ? (
          <AuthModal
            mode={authModalMode}
            onClose={() => setAuthModalMode(null)}
            onModeChange={setAuthModalMode}
            onSubmit={handleAuth}
          />
        ) : null}

        {profileOpen ? (
          <ProfileModal
            authUser={authUser}
            draft={profileNicknameDraft}
            onDraft={setProfileNicknameDraft}
            onClose={() => setProfileOpen(false)}
            onSave={updateProfileNickname}
            onSignOut={signOut}
          />
        ) : null}

        {detailsOpen && room ? (
          <ChatDetailsPanel
            room={room}
            me={me}
            members={members}
            roomNameDraft={roomNameDraft}
            onRoomNameDraft={setRoomNameDraft}
            onRename={renameRoom}
            onClose={() => setDetailsOpen(false)}
            onPromote={(id) => moderate("member:promote", id)}
            onDemote={(id) => moderate("member:demote", id)}
            onTransfer={(id) => moderate("member:transfer", id)}
            onRemove={removeMember}
            onRecover={recoverOwnership}
            detailsTab={detailsTab}
            onDetailsTab={setDetailsTab}
            canManageMembers={canManageMembers}
            canRenameRoom={canRenameRoom}
            isOwner={Boolean(isOwner)}
            savingRoomName={savingRoomName}
          />
        ) : null}

        {ownerRecoveryCode && room ? (
          <div className="fixed inset-0 z-[90] grid place-items-center bg-slate-950/58 p-4 backdrop-blur-md">
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
                <button className="liquid-button h-11 rounded-2xl text-sm font-semibold" onClick={() => setOwnerRecoveryCode(null)}>
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

function GlobalHeader({
  connected,
  authUser,
  onMenu,
  onAuth,
  onProfile
}: {
  connected: boolean;
  authUser: AuthUser | null;
  onMenu: () => void;
  onAuth: (mode: AuthMode) => void;
  onProfile: () => void;
}) {
  return (
    <header className="glass-panel-strong flex items-center justify-between rounded-[26px] px-4 py-3 sm:px-5">
      <div className="flex items-center gap-3">
        <button className="secondary-button grid h-10 w-10 place-items-center rounded-2xl lg:hidden" onClick={onMenu} aria-label="Open menu">
          <span className="text-lg">=</span>
        </button>
        <div>
          <div className="text-sm uppercase tracking-[0.18em] text-cyan-100">WEBSMITHS</div>
          <div className="text-lg font-semibold text-white">ChatApp</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className={`hidden h-2.5 w-2.5 rounded-full shadow sm:inline-block ${connected ? "bg-emerald-300 shadow-emerald-300/50" : "bg-zinc-500"}`} />
        {authUser ? (
          <button className="secondary-button rounded-2xl px-3 py-2 text-sm text-zinc-100" onClick={onProfile}>
            {authUser.nickname}
          </button>
        ) : (
          <>
            <button className="secondary-button rounded-2xl px-3 py-2 text-sm text-zinc-100" onClick={() => onAuth("signin")}>
              Sign In
            </button>
            <button className="liquid-button rounded-2xl px-3 py-2 text-sm font-semibold" onClick={() => onAuth("signup")}>
              Sign Up
            </button>
          </>
        )}
      </div>
    </header>
  );
}

function SidebarContent({
  nickname,
  authUser,
  connected,
  onEditProfile,
  onSetGuestNickname
}: {
  nickname: string;
  authUser: AuthUser | null;
  connected: boolean;
  onEditProfile: () => void;
  onSetGuestNickname: () => void;
}) {
  return (
    <aside className="glass-panel-strong flex h-full flex-col rounded-[28px] p-4">
      <div className="mb-6">
        <div className="text-lg font-semibold tracking-[0.01em] text-white">WEBSMITHS ChatApp</div>
        <div className="mt-2 flex items-center gap-2 text-sm text-zinc-400">
          <span className={`h-2.5 w-2.5 rounded-full shadow ${connected ? "bg-emerald-300 shadow-emerald-300/50" : "bg-zinc-500"}`} />
          {authUser ? authUser.email : nickname ? nickname : "Guest mode"}
        </div>
      </div>

      <a href="/" className="glass-chip block rounded-2xl px-4 py-3 text-sm font-medium text-zinc-100 hover:bg-white/10">
        WEBSMITHS Global Chat
      </a>

      <div className="glass-panel mt-6 rounded-[24px] p-4">
        <h2 className="text-sm font-semibold text-zinc-100">Quick Profile</h2>
        <p className="mt-2 text-sm text-zinc-400">
          {authUser ? `${authUser.nickname} is signed in.` : nickname ? `You are chatting as ${nickname}.` : "Choose a guest nickname or sign in."}
        </p>
        <button className="secondary-button mt-4 h-10 w-full rounded-2xl text-sm text-zinc-100" onClick={authUser ? onEditProfile : onSetGuestNickname}>
          {authUser ? "Open profile" : "Set guest nickname"}
        </button>
        {authUser?.isSiteAdmin ? (
          <a className="mt-3 block rounded-2xl border border-cyan-300/25 bg-cyan-300/10 px-3 py-2 text-center text-sm text-cyan-100 hover:bg-cyan-300/15" href="/admin">
            Manage App
          </a>
        ) : null}
      </div>

      <div className="glass-panel mt-6 rounded-[24px] p-4 text-sm text-zinc-400">
        <div className="text-sm font-semibold text-zinc-100">Balanced UX</div>
        <p className="mt-2 leading-6">
          Desktop keeps the app rail visible, while phones collapse it into a drawer so the conversation stays front and center.
        </p>
      </div>
    </aside>
  );
}

function ChatTopBar({
  room,
  shareUrl,
  onlineCount,
  memberCount,
  onOpenDetails
}: {
  room: Room | null;
  shareUrl: string;
  onlineCount: number;
  memberCount: number;
  onOpenDetails: () => void;
}) {
  const detailsLabel = room
    ? `${room.type === "DIRECT" ? "Private chat" : room.slug === "global" ? "Global chat" : "Group chat"} | ${onlineCount} online${room.maxUsers ? ` | ${memberCount}/${room.maxUsers} members` : ""}`
    : "Joining chat...";

  return (
    <header className="glass-shell border-b border-white/10 px-4 py-4 sm:px-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <button className="flex min-w-0 items-center gap-3 text-left" onClick={onOpenDetails} disabled={!room}>
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-white/10 bg-white/5 text-lg text-white">
            {room ? renderRoomIcon(room) : "..."}
          </div>
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold tracking-[0.01em] text-white">{room?.name ?? "Loading chat..."}</div>
            <p className="mt-1 truncate text-sm text-zinc-400">{detailsLabel}</p>
          </div>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          {shareUrl ? (
            <button className="secondary-button rounded-2xl px-3 py-2 text-sm text-zinc-100" onClick={() => navigator.clipboard.writeText(shareUrl)}>
              Copy Link
            </button>
          ) : null}
          <button className="secondary-button rounded-2xl px-3 py-2 text-sm text-zinc-500" title={callFeatureMessage} aria-disabled="true" type="button">
            Voice
          </button>
          <button className="secondary-button rounded-2xl px-3 py-2 text-sm text-zinc-500" title={callFeatureMessage} aria-disabled="true" type="button">
            Video
          </button>
        </div>
      </div>
    </header>
  );
}

function FloatingCreateButton({ disabled, open, onToggle }: { disabled: boolean; open: boolean; onToggle: () => void }) {
  return (
    <button
      className="liquid-button fixed bottom-5 right-5 z-40 rounded-full px-5 py-3 text-sm font-semibold shadow-2xl"
      title={disabled ? "Choose a nickname or sign in first" : "Create a new chat"}
      onClick={onToggle}
      disabled={disabled}
      type="button"
    >
      {open ? "Close" : "Create New"}
    </button>
  );
}

function CreateActionSheet({
  onClose,
  onCreateGroup,
  onCreateDirect
}: {
  onClose: () => void;
  onCreateGroup: () => void;
  onCreateDirect: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-sm" onClick={onClose}>
      <div className="pointer-events-none fixed bottom-24 right-5 flex w-[min(320px,calc(100vw-2.5rem))] flex-col gap-2">
        <div className="glass-panel-strong pointer-events-auto rounded-[24px] p-3">
          <button className="secondary-button w-full rounded-2xl px-4 py-3 text-left text-sm text-zinc-100" onClick={onCreateGroup}>
            New Group
          </button>
          <button className="secondary-button mt-2 w-full rounded-2xl px-4 py-3 text-left text-sm text-zinc-100" onClick={onCreateDirect}>
            New Chat
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateRoomModal({
  creating,
  type,
  onClose,
  onSubmit
}: {
  creating: boolean;
  type: CreateRoomType;
  onClose: () => void;
  onSubmit: (form: CreateRoomForm) => void;
}) {
  const [name, setName] = useState("");
  const [maxUsers, setMaxUsers] = useState("");
  const [expiresInHours, setExpiresInHours] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({
      name,
      type,
      maxUsers: type === "GROUP" && maxUsers ? Number(maxUsers) : null,
      expiresInHours: expiresInHours ? Number(expiresInHours) : null
    });
  }

  return (
    <ModalFrame title={type === "GROUP" ? "Create New Group" : "Create New Chat"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <input
          className="glass-input h-11 w-full rounded-2xl px-4 text-sm text-white outline-none"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={type === "GROUP" ? "Group name" : "Private chat name"}
          maxLength={80}
        />
        {type === "GROUP" ? (
          <input
            className="glass-input h-11 w-full rounded-2xl px-4 text-sm text-white outline-none"
            value={maxUsers}
            onChange={(event) => setMaxUsers(event.target.value)}
            placeholder="Max users, blank for unlimited"
            type="number"
            min={2}
            max={500}
          />
        ) : null}
        <input
          className="glass-input h-11 w-full rounded-2xl px-4 text-sm text-white outline-none"
          value={expiresInHours}
          onChange={(event) => setExpiresInHours(event.target.value)}
          placeholder="Expiry hours, blank for none"
          type="number"
          min={1}
          max={720}
        />
        <div className="flex gap-3 pt-2">
          <button type="button" className="secondary-button h-11 flex-1 rounded-2xl text-sm text-zinc-100" onClick={onClose}>
            Cancel
          </button>
          <button className="liquid-button h-11 flex-1 rounded-2xl text-sm font-semibold" disabled={creating}>
            {creating ? "Creating..." : "Create"}
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}

function AuthModal({
  mode,
  onClose,
  onModeChange,
  onSubmit
}: {
  mode: AuthMode;
  onClose: () => void;
  onModeChange: (mode: AuthMode) => void;
  onSubmit: (endpoint: AuthMode, payload: AuthPayload) => void;
}) {
  const [email, setEmail] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(mode, { email, password, nickname: mode === "signup" ? nickname : undefined });
  }

  return (
    <ModalFrame title={mode === "signup" ? "Create your account" : "Sign in"} onClose={onClose}>
      <div className="grid grid-cols-2 gap-2 pb-3">
        <button
          className={`h-10 rounded-2xl text-sm font-medium ${mode === "signin" ? "secondary-button text-zinc-100" : "secondary-button text-zinc-400"}`}
          type="button"
          onClick={() => onModeChange("signin")}
        >
          Sign In
        </button>
        <button
          className={`h-10 rounded-2xl text-sm font-medium ${mode === "signup" ? "liquid-button" : "secondary-button text-zinc-400"}`}
          type="button"
          onClick={() => onModeChange("signup")}
        >
          Sign Up
        </button>
      </div>
      <form onSubmit={submit} className="space-y-3">
        <input
          className="glass-input h-11 w-full rounded-2xl px-4 text-sm text-white outline-none"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="Email"
          type="email"
          autoComplete="email"
        />
        {mode === "signup" ? (
          <input
            className="glass-input h-11 w-full rounded-2xl px-4 text-sm text-white outline-none"
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            placeholder="Nickname"
            maxLength={32}
            autoComplete="nickname"
          />
        ) : null}
        <input
          className="glass-input h-11 w-full rounded-2xl px-4 text-sm text-white outline-none"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          type="password"
          minLength={8}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
        />
        <button className="liquid-button h-11 w-full rounded-2xl text-sm font-semibold">
          {mode === "signup" ? "Create account" : "Sign in"}
        </button>
      </form>
    </ModalFrame>
  );
}

function ProfileModal({
  authUser,
  draft,
  onDraft,
  onClose,
  onSave,
  onSignOut
}: {
  authUser: AuthUser | null;
  draft: string;
  onDraft: (value: string) => void;
  onClose: () => void;
  onSave: (event: FormEvent) => void;
  onSignOut: () => void;
}) {
  return (
    <ModalFrame title={authUser ? "Profile" : "Guest profile"} onClose={onClose}>
      <form onSubmit={onSave} className="space-y-3">
        <input
          className="glass-input h-11 w-full rounded-2xl px-4 text-sm text-white outline-none"
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          placeholder="Nickname"
          maxLength={32}
        />
        <button className="liquid-button h-11 w-full rounded-2xl text-sm font-semibold">Save nickname</button>
      </form>
      {authUser ? (
        <>
          <div className="mt-3 rounded-[20px] border border-white/8 bg-white/[0.03] p-4 text-sm text-zinc-400">
            <div className="font-medium text-zinc-100">{authUser.email}</div>
            <div className="mt-1">{formatBytes(authUser.storageUsedBytes ?? 0)} used</div>
          </div>
          {authUser.isSiteAdmin ? (
            <a className="mt-3 block rounded-2xl border border-cyan-300/25 bg-cyan-300/10 px-3 py-2 text-center text-sm text-cyan-100 hover:bg-cyan-300/15" href="/admin">
              Manage App
            </a>
          ) : null}
          <button className="secondary-button mt-3 h-11 w-full rounded-2xl text-sm text-zinc-100" type="button" onClick={onSignOut}>
            Sign out
          </button>
        </>
      ) : null}
    </ModalFrame>
  );
}

function ChatDetailsPanel({
  room,
  me,
  members,
  roomNameDraft,
  onRoomNameDraft,
  onRename,
  onClose,
  onPromote,
  onDemote,
  onTransfer,
  onRemove,
  onRecover,
  detailsTab,
  onDetailsTab,
  canManageMembers,
  canRenameRoom,
  isOwner,
  savingRoomName
}: {
  room: Room;
  me: Member | null;
  members: Member[];
  roomNameDraft: string;
  onRoomNameDraft: (value: string) => void;
  onRename: (event: FormEvent) => void;
  onClose: () => void;
  onPromote: (id: string) => void;
  onDemote: (id: string) => void;
  onTransfer: (id: string) => void;
  onRemove: (id: string) => void;
  onRecover: (code: string) => void;
  detailsTab: ChatDetailsTab;
  onDetailsTab: (tab: ChatDetailsTab) => void;
  canManageMembers: boolean;
  canRenameRoom: boolean;
  isOwner: boolean;
  savingRoomName: boolean;
}) {
  const [recoveryCode, setRecoveryCode] = useState("");

  function submitRecovery(event: FormEvent) {
    event.preventDefault();
    if (!recoveryCode.trim()) return;
    onRecover(recoveryCode);
    setRecoveryCode("");
  }

  return (
    <div className="fixed inset-0 z-[80] bg-slate-950/50 backdrop-blur-sm" onClick={onClose}>
      <div className="absolute inset-y-0 right-0 flex w-full max-w-xl" onClick={(event) => event.stopPropagation()}>
        <div className="glass-panel-strong ml-auto flex h-full w-full flex-col rounded-l-[32px] p-5">
          <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-4">
            <div className="flex items-center gap-3">
              <div className="grid h-14 w-14 place-items-center rounded-[22px] border border-white/10 bg-white/5 text-xl text-white">
                {renderRoomIcon(room)}
              </div>
              <div>
                <div className="text-lg font-semibold text-white">{room.name}</div>
                <div className="mt-1 text-sm text-zinc-400">
                  {room.slug === "global" ? "Global chat details" : room.type === "DIRECT" ? "Private chat details" : "Group details"}
                </div>
              </div>
            </div>
            <button className="secondary-button grid h-10 w-10 place-items-center rounded-2xl text-zinc-100" onClick={onClose}>
              x
            </button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <button className={`h-10 rounded-2xl text-sm font-medium ${detailsTab === "about" ? "liquid-button" : "secondary-button text-zinc-300"}`} onClick={() => onDetailsTab("about")}>
              Chat Info
            </button>
            <button className={`h-10 rounded-2xl text-sm font-medium ${detailsTab === "members" ? "liquid-button" : "secondary-button text-zinc-300"}`} onClick={() => onDetailsTab("members")}>
              Participants
            </button>
          </div>

          <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
            {detailsTab === "about" ? (
              <div className="space-y-4">
                <div className="glass-panel rounded-[24px] p-4">
                  <div className="text-sm font-semibold text-zinc-100">Chat appearance</div>
                  <p className="mt-2 text-sm leading-6 text-zinc-400">
                    A custom photo uploader can plug in here later. For now, the app uses a clean placeholder icon.
                  </p>
                  <button className="secondary-button mt-4 h-10 rounded-2xl px-4 text-sm text-zinc-500" title="Custom chat photos are coming soon." type="button">
                    Edit photo (coming soon)
                  </button>
                </div>

                <form onSubmit={onRename} className="glass-panel rounded-[24px] p-4">
                  <div className="text-sm font-semibold text-zinc-100">Chat name</div>
                  <input
                    className="glass-input mt-3 h-11 w-full rounded-2xl px-4 text-sm text-white outline-none"
                    value={roomNameDraft}
                    onChange={(event) => onRoomNameDraft(event.target.value)}
                    maxLength={80}
                    disabled={!canRenameRoom || room.slug === "global"}
                  />
                  <button className="liquid-button mt-3 h-10 rounded-2xl px-4 text-sm font-semibold" disabled={!canRenameRoom || savingRoomName || room.slug === "global"}>
                    {savingRoomName ? "Saving..." : room.slug === "global" ? "Global chat is fixed" : "Save name"}
                  </button>
                </form>

                {room.slug !== "global" && room.type !== "DIRECT" ? (
                  <form onSubmit={submitRecovery} className="glass-panel rounded-[24px] p-4">
                    <div className="text-sm font-semibold text-zinc-100">Recover ownership</div>
                    <input
                      className="glass-input mt-3 h-11 w-full rounded-2xl px-4 text-sm text-white outline-none"
                      value={recoveryCode}
                      onChange={(event) => setRecoveryCode(event.target.value)}
                      placeholder="Recovery code"
                      autoComplete="off"
                    />
                    <button className="secondary-button mt-3 h-10 rounded-2xl px-4 text-sm text-zinc-100">Recover</button>
                  </form>
                ) : null}
              </div>
            ) : (
              <div className="space-y-3">
                {members.map((member) => {
                  const isSelf = me?.id === member.id;
                  const showManageButtons = canManageMembers && !isSelf;
                  return (
                    <div key={member.id} className="glass-panel rounded-[24px] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-zinc-100">
                            {member.nickname}
                            {isSelf ? " (you)" : ""}
                          </div>
                          <div className="mt-1 text-xs text-zinc-500">{roleLabel[member.role]}</div>
                        </div>
                        <div className="glass-chip rounded-full px-3 py-1 text-[11px] uppercase tracking-[0.14em] text-zinc-300">
                          {roleLabel[member.role]}
                        </div>
                      </div>
                      {showManageButtons ? (
                        <div className="mt-4 flex flex-wrap gap-2">
                          {member.role === "guest" ? (
                            <button className="secondary-button rounded-full px-3 py-1.5 text-xs text-zinc-100" onClick={() => onPromote(member.id)}>
                              Make admin
                            </button>
                          ) : null}
                          {member.role === "admin" ? (
                            <button className="secondary-button rounded-full px-3 py-1.5 text-xs text-zinc-100" onClick={() => onDemote(member.id)}>
                              Remove admin
                            </button>
                          ) : null}
                          <button className="rounded-full bg-amber-300/15 px-3 py-1.5 text-xs text-amber-100 hover:bg-amber-300/25" onClick={() => onTransfer(member.id)}>
                            Transfer ownership
                          </button>
                          <button className="rounded-full bg-red-400/12 px-3 py-1.5 text-xs text-red-100 hover:bg-red-400/20" onClick={() => onRemove(member.id)}>
                            Remove participant
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {!canManageMembers && room.type !== "GROUP" ? (
                  <div className="glass-panel rounded-[24px] p-4 text-sm leading-6 text-zinc-400">
                    Direct chats keep participant management intentionally minimal. You can still rename this chat from the Chat Info tab.
                  </div>
                ) : null}
                {!canManageMembers && room.slug === "global" ? (
                  <div className="glass-panel rounded-[24px] p-4 text-sm leading-6 text-zinc-400">
                    Global chat keeps shared room settings locked, but you can still see who is in the room here.
                  </div>
                ) : null}
                {!isOwner && room.type === "GROUP" && room.slug !== "global" ? (
                  <div className="glass-panel rounded-[24px] p-4 text-sm leading-6 text-zinc-400">
                    Only the current room owner can promote, demote, transfer ownership, or remove participants.
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MobileDrawer({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] bg-slate-950/50 backdrop-blur-sm" onClick={onClose}>
      <div className="h-full w-full max-w-sm p-3" onClick={(event) => event.stopPropagation()}>
        <div className="relative h-full">
          {children}
          <button className="secondary-button absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-2xl text-zinc-100" onClick={onClose}>
            x
          </button>
        </div>
      </div>
    </div>
  );
}

function GuestSetupInline({
  nicknameDraft,
  onNicknameDraft,
  onSubmit,
  onSignin,
  onSignup
}: {
  nicknameDraft: string;
  onNicknameDraft: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onSignin: () => void;
  onSignup: () => void;
}) {
  return (
    <div className="grid min-h-full place-items-center px-2 py-8">
      <div className="glass-panel-strong w-full max-w-lg rounded-[28px] p-6">
        <div className="text-xs uppercase tracking-[0.18em] text-cyan-100">Welcome</div>
        <h2 className="mt-3 text-2xl font-semibold text-white">Choose a nickname to enter the chat</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-400">
          You can keep it simple as a guest or sign in from the top-right corner for account-backed chat.
        </p>
        <form onSubmit={onSubmit} className="mt-5 space-y-3">
          <input
            className="glass-input h-12 w-full rounded-2xl px-4 text-sm text-white outline-none"
            autoFocus
            value={nicknameDraft}
            onChange={(event) => onNicknameDraft(event.target.value)}
            placeholder="Nickname"
            maxLength={32}
          />
          <button className="liquid-button h-11 w-full rounded-2xl text-sm font-semibold">Continue as guest</button>
        </form>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <button className="secondary-button h-10 rounded-2xl text-sm text-zinc-100" onClick={onSignin} type="button">
            Sign In
          </button>
          <button className="secondary-button h-10 rounded-2xl text-sm text-zinc-100" onClick={onSignup} type="button">
            Sign Up
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalFrame({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[75] grid place-items-center bg-slate-950/58 p-4 backdrop-blur-md" onClick={onClose}>
      <div className="glass-panel-strong max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-[28px] p-6" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button className="secondary-button grid h-10 w-10 place-items-center rounded-2xl text-zinc-100" onClick={onClose} type="button">
            x
          </button>
        </div>
        {children}
      </div>
    </div>
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
    <article className={`message-enter flex ${isMine ? "justify-end" : "justify-start"} ${groupedWithPrevious ? "mt-1.5" : "mt-4 first:mt-0"}`}>
      <div
        className={`glass-panel group w-full max-w-[92%] px-4 py-3 sm:max-w-[78%] ${isMine ? "border-cyan-300/20 bg-cyan-300/[0.08]" : ""} ${
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
          <div className="min-w-0 flex-1">
            {!groupedWithPrevious ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-zinc-100">{message.member.nickname}</span>
                <span className="glass-chip rounded-full px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-zinc-300">
                  {roleLabel[message.member.role]}
                </span>
                <time className="text-xs text-zinc-500">{formatMessageTime(message.createdAt)}</time>
                {message.editedAt && !message.deletedAt ? <span className="text-xs italic text-zinc-500">edited</span> : null}
              </div>
            ) : (
              <div className="mb-1 flex items-center gap-2 text-[11px] text-zinc-500">
                <time>{formatMessageTime(message.createdAt)}</time>
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
              <button
                type="button"
                className="secondary-button rounded-full px-3 py-1.5 text-xs text-zinc-300 hover:text-zinc-100"
                onClick={() => setEditing((value) => !value)}
              >
                Edit
              </button>
            ) : null}
            {canDelete ? (
              <button
                type="button"
                className="rounded-full px-3 py-1.5 text-xs text-zinc-400 hover:bg-red-400/10 hover:text-red-200"
                onClick={onDelete}
              >
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

function renderRoomIcon(room: Room) {
  if (room.slug === "global") {
    return (
      <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18" />
        <path d="M12 3c2.8 2.8 4.2 5.8 4.2 9S14.8 18.2 12 21c-2.8-2.8-4.2-5.8-4.2-9S9.2 5.8 12 3Z" />
      </svg>
    );
  }

  const initial = room.name.trim().charAt(0).toUpperCase() || "#";
  return <span className="font-semibold">{initial}</span>;
}

function shouldGroupMessages(previous: ChatMessage | undefined, current: ChatMessage | undefined) {
  if (!previous || !current) return false;
  if (previous.member.id !== current.member.id) return false;
  if (Boolean(previous.deletedAt) !== Boolean(current.deletedAt)) return false;

  const previousTime = new Date(previous.createdAt).getTime();
  const currentTime = new Date(current.createdAt).getTime();
  return Math.abs(currentTime - previousTime) <= 5 * 60 * 1000;
}

function sanitizeNickname(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 32);
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function formatMessageTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
