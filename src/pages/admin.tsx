import type { GetServerSideProps } from "next";
import type { NextApiRequest } from "next";
import Head from "next/head";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { getCurrentUser } from "@/lib/auth";
import { isSiteAdminEmail } from "@/lib/siteAdmin";

type UpdateStep = {
  name: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
};

type UpdateStatus = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  phase: string;
  error: string | null;
  logPath: string;
  worktreePath: string;
  preservedPaths: string[];
  steps: UpdateStep[];
} | null;

type AdminStatus = {
  app: { name: string; version: string; uptimeSeconds: number };
  git: {
    branch: string | null;
    commit: string | null;
    aheadBehind: string | null;
    updateAvailable: boolean;
    latestRemoteCommit: string | null;
    latestRemoteMessage: string | null;
    error: string | null;
  };
  storage: {
    totalUploadsBytes: number;
    accountUploadsBytes: number;
    anonymousUploadsBytes: number;
    accountStorageLimitBytes: number;
    oldestTemporaryCreatedAt: string | null;
    databaseBytes: number;
    disk: { freeBytes: number; totalBytes: number } | null;
  };
  users: Array<{
    id: string;
    email: string;
    nickname: string;
    lastActiveAt: string;
    storageUsedBytes: number;
    storageLimitBytes: number;
    inactiveWithFilesOlderThanPolicy: boolean;
  }>;
  update: UpdateStatus;
  health: {
    databaseReachable: boolean;
    uploadsFolderWritable: boolean;
    socketServerRunning: boolean;
    uptimeSeconds: number;
  };
};

export default function AdminPage() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>(null);
  const [actionResult, setActionResult] = useState<unknown>("No action run yet");
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  useEffect(() => {
    void loadStatus();
  }, []);

  useEffect(() => {
    if (!updateStatus?.running) return;

    const timer = window.setInterval(() => {
      void loadUpdateStatus();
      void loadStatus(false);
    }, 4000);

    return () => window.clearInterval(timer);
  }, [updateStatus?.running]);

  async function loadStatus(showErrors = true) {
    if (showErrors) setError("");
    const response = await fetch("/api/admin/status");
    const json = await response.json();
    if (!response.ok) {
      if (showErrors) setError(json.error || "Could not load admin status");
      return;
    }
    setStatus(json);
    setUpdateStatus(json.update ?? null);
  }

  async function loadUpdateStatus() {
    const response = await fetch("/api/admin/update-status");
    const json = await response.json();
    if (!response.ok) return;
    setUpdateStatus(json.update ?? null);
  }

  async function postAction(url: string) {
    setBusyAction(url);
    setError("");
    try {
      const response = await fetch(url, { method: "POST" });
      const json = await response.json();
      if (!response.ok) {
        setError(json.error || "Action failed");
        return;
      }
      setActionResult(json);
      if (url.includes("cleanup")) {
        setStatus(json);
      }
      if (url.includes("/update")) {
        setUpdateStatus(json);
      }
      await loadStatus(false);
    } finally {
      setBusyAction(null);
    }
  }

  const updateSummary = useMemo(() => {
    if (!updateStatus) return "No update run yet";
    if (updateStatus.running) return `Updating now: ${updateStatus.phase}`;
    if (updateStatus.error) return `Last update failed: ${updateStatus.error}`;
    if (updateStatus.finishedAt) return `Last update finished ${new Date(updateStatus.finishedAt).toLocaleString()}`;
    return "Ready";
  }, [updateStatus]);

  return (
    <>
      <Head>
        <title>Manage App | WEBSMITHS ChatApp</title>
      </Head>
      <main className="relative min-h-screen overflow-x-hidden bg-ink-950 p-4 text-zinc-100 md:p-6">
        <div className="ambient-orb left-[-5rem] top-[-4rem] h-44 w-44 bg-sky-300/25" />
        <div className="ambient-orb bottom-0 right-[-4rem] h-56 w-56 bg-emerald-300/20" />
        <div className="mx-auto max-w-7xl">
          <div className="glass-panel-strong rounded-[32px] p-5 md:p-6">
            <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <div className="glass-chip inline-flex rounded-full px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-cyan-100">
                  Site Super Admin
                </div>
                <h1 className="mt-3 text-3xl font-semibold tracking-[0.01em] text-white">Manage App</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">
                  Update WEBSMITHS ChatApp safely, monitor storage and health, and keep chats, uploads, and config preserved.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <a className="secondary-button rounded-2xl px-4 py-2 text-sm text-zinc-100" href="/">
                  Back to chat
                </a>
                <button className="liquid-button rounded-2xl px-4 py-2 text-sm font-semibold" onClick={() => void loadStatus()} disabled={busyAction !== null}>
                  Refresh dashboard
                </button>
              </div>
            </div>

            {error ? <div className="mb-4 rounded-2xl border border-red-400/20 bg-red-950/40 p-3 text-sm text-red-100">{error}</div> : null}

            <div className="mb-6 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
              <section className="glass-panel rounded-[28px] p-5">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Update Control</h2>
                    <p className="mt-1 text-sm text-zinc-400">{updateSummary}</p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <button className="secondary-button rounded-2xl px-4 py-2 text-sm text-zinc-100" onClick={() => void postAction("/api/admin/cleanup")} disabled={busyAction !== null}>
                      {busyAction?.includes("cleanup") ? "Running cleanup..." : "Run cleanup"}
                    </button>
                    <button className="secondary-button rounded-2xl px-4 py-2 text-sm text-zinc-100" onClick={() => void postAction("/api/admin/check-updates")} disabled={busyAction !== null}>
                      {busyAction?.includes("check-updates") ? "Checking..." : "Check for updates"}
                    </button>
                    <button
                      className="liquid-button rounded-2xl px-4 py-2 text-sm font-semibold"
                      onClick={() => void postAction("/api/admin/update")}
                      disabled={busyAction !== null || Boolean(updateStatus?.running)}
                    >
                      {updateStatus?.running ? "Updating..." : "Update app"}
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <HighlightCard label="Branch" value={status?.git.branch ?? "Unavailable"} />
                  <HighlightCard label="Current commit" value={status?.git.commit ?? "Unavailable"} />
                  <HighlightCard label="Remote state" value={status?.git.updateAvailable ? "Update available" : "Up to date / unknown"} />
                </div>

                <div className="mt-4 rounded-[24px] border border-white/10 bg-white/[0.03] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-zinc-100">Protected during update</div>
                    <div className={`rounded-full px-3 py-1 text-xs ${updateStatus?.running ? "bg-amber-300/15 text-amber-100" : "bg-emerald-300/15 text-emerald-100"}`}>
                      {updateStatus?.running ? "In progress" : "Safe mode"}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(updateStatus?.preservedPaths ?? [".env", "prod.db", "uploads/"]).map((item) => (
                      <span key={item} className="glass-chip rounded-full px-3 py-1 text-xs text-zinc-300">
                        {item}
                      </span>
                    ))}
                  </div>
                  {updateStatus?.logPath ? (
                    <div className="mt-3 text-xs text-zinc-500">
                      Update log: <span className="text-zinc-300">{updateStatus.logPath}</span>
                    </div>
                  ) : null}
                </div>
              </section>

              <section className="glass-panel rounded-[28px] p-5">
                <h2 className="text-lg font-semibold text-white">Live Update Status</h2>
                <div className="mt-4 space-y-3">
                  {(updateStatus?.steps ?? []).length ? (
                    updateStatus?.steps.map((step) => (
                      <div key={step.name} className="rounded-[22px] border border-white/8 bg-white/[0.03] p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-medium text-zinc-100">{step.name}</div>
                          <StatusBadge status={step.status} />
                        </div>
                        {step.detail ? <div className="mt-2 text-xs leading-5 text-zinc-400">{step.detail}</div> : null}
                      </div>
                    ))
                  ) : (
                    <div className="rounded-[22px] border border-white/8 bg-white/[0.03] p-4 text-sm text-zinc-400">
                      No update has been started yet.
                    </div>
                  )}
                  {updateStatus?.error ? (
                    <div className="rounded-[22px] border border-red-400/20 bg-red-950/30 p-4 text-sm leading-6 text-red-100">
                      {updateStatus.error}
                    </div>
                  ) : null}
                </div>
              </section>
            </div>

            {status ? (
              <div className="grid gap-4 xl:grid-cols-2">
                <Panel title="App">
                  <Metric label="Name" value={status.app.name} />
                  <Metric label="Version" value={status.app.version} />
                  <Metric label="Uptime" value={formatDuration(status.app.uptimeSeconds)} />
                </Panel>
                <Panel title="Git">
                  <Metric label="Branch" value={status.git.branch ?? "Unavailable"} />
                  <Metric label="Commit" value={status.git.commit ?? "Unavailable"} />
                  <Metric label="Ahead/behind" value={status.git.aheadBehind ?? "Unavailable"} />
                  <Metric label="Update" value={status.git.updateAvailable ? "Available" : "Not detected"} />
                  {status.git.latestRemoteCommit ? <Metric label="Remote commit" value={status.git.latestRemoteCommit.slice(0, 12)} /> : null}
                  {status.git.latestRemoteMessage ? <Metric label="Remote message" value={status.git.latestRemoteMessage} /> : null}
                  {status.git.error ? <p className="mt-3 text-sm text-amber-200">{status.git.error}</p> : null}
                </Panel>
                <Panel title="Storage">
                  <Metric label="Uploads" value={formatBytes(status.storage.totalUploadsBytes)} />
                  <Metric label="Database" value={formatBytes(status.storage.databaseBytes)} />
                  <Metric label="Account uploads" value={formatBytes(status.storage.accountUploadsBytes)} />
                  <Metric label="Anonymous temp uploads" value={formatBytes(status.storage.anonymousUploadsBytes)} />
                  <Metric label="Oldest temp file" value={status.storage.oldestTemporaryCreatedAt ? new Date(status.storage.oldestTemporaryCreatedAt).toLocaleString() : "None"} />
                  <Metric label="Disk free" value={status.storage.disk ? `${formatBytes(status.storage.disk.freeBytes)} / ${formatBytes(status.storage.disk.totalBytes)}` : "Unavailable"} />
                </Panel>
                <Panel title="Health">
                  <Metric label="Database" value={status.health.databaseReachable ? "Reachable" : "Failed"} />
                  <Metric label="Uploads folder" value={status.health.uploadsFolderWritable ? "Writable" : "Not writable"} />
                  <Metric label="Socket.IO/server" value={status.health.socketServerRunning ? "Running" : "Unknown"} />
                  <Metric label="Current uptime" value={formatDuration(status.health.uptimeSeconds)} />
                </Panel>
                <Panel title="Accounts">
                  <div className="space-y-3">
                    {status.users.map((user) => (
                      <div key={user.id} className="rounded-[22px] border border-white/8 bg-white/[0.03] p-3">
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <div className="text-sm font-medium text-zinc-100">{user.email}</div>
                            <div className="text-xs text-zinc-500">{user.nickname}</div>
                          </div>
                          <div className="text-sm text-zinc-300">
                            {formatBytes(user.storageUsedBytes)} / {formatBytes(user.storageLimitBytes)}
                          </div>
                        </div>
                        <div className="mt-2 text-xs text-zinc-500">Last active {new Date(user.lastActiveAt).toLocaleString()}</div>
                        {user.inactiveWithFilesOlderThanPolicy ? (
                          <div className="mt-2 text-xs text-amber-200">Inactive file cleanup applies</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </Panel>
                <Panel title="Action Result">
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-6 text-zinc-300">{JSON.stringify(actionResult, null, 2)}</pre>
                </Panel>
              </div>
            ) : (
              <div className="glass-panel loading-shimmer rounded-[28px] p-6 text-sm text-zinc-400">Loading admin status...</div>
            )}
          </div>
        </div>
      </main>
    </>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="glass-panel rounded-[28px] p-5">
      <h2 className="mb-3 text-lg font-semibold text-white">{title}</h2>
      {children}
    </section>
  );
}

function HighlightCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[22px] border border-white/8 bg-white/[0.03] p-4">
      <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">{label}</div>
      <div className="mt-2 text-sm font-medium text-zinc-100">{value}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-white/5 py-2 text-sm last:border-b-0">
      <span className="text-zinc-500">{label}</span>
      <span className="max-w-[60%] text-right text-zinc-100">{value}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: UpdateStep["status"] }) {
  const styles: Record<UpdateStep["status"], string> = {
    pending: "bg-white/8 text-zinc-300",
    running: "bg-cyan-300/15 text-cyan-100",
    completed: "bg-emerald-300/15 text-emerald-100",
    failed: "bg-red-400/15 text-red-100",
    skipped: "bg-amber-300/15 text-amber-100"
  };

  return <span className={`rounded-full px-3 py-1 text-[11px] uppercase tracking-[0.14em] ${styles[status]}`}>{status}</span>;
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
  return `${Math.max(0, Math.round(bytes / 1024))}KB`;
}

function formatDuration(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h ${minutes}m`;
}

export const getServerSideProps: GetServerSideProps = async ({ req, res }) => {
  const user = await getCurrentUser(req as unknown as NextApiRequest);
  if (!user || !isSiteAdminEmail(user.email)) {
    res.statusCode = 404;
    return { notFound: true };
  }
  return { props: {} };
};
