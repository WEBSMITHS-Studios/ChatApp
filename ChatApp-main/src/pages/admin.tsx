import type { GetServerSideProps } from "next";
import type { NextApiRequest } from "next";
import Head from "next/head";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { getCurrentUser } from "@/lib/auth";
import { isSiteAdminEmail } from "@/lib/siteAdmin";

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
  health: {
    databaseReachable: boolean;
    uploadsFolderWritable: boolean;
    socketServerRunning: boolean;
    uptimeSeconds: number;
  };
};

export default function AdminPage() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [actionResult, setActionResult] = useState<unknown>("No action run yet");
  const [error, setError] = useState("");

  useEffect(() => {
    loadStatus();
  }, []);

  async function loadStatus() {
    setError("");
    const response = await fetch("/api/admin/status");
    const json = await response.json();
    if (!response.ok) {
      setError(json.error || "Could not load admin status");
      return;
    }
    setStatus(json);
  }

  async function postAction(url: string) {
    setError("");
    const response = await fetch(url, { method: "POST" });
    const json = await response.json();
    if (!response.ok) {
      setError(json.error || "Action failed");
      return;
    }
    setActionResult(json);
    if (url.includes("cleanup")) setStatus(json);
  }

  return (
    <>
      <Head>
        <title>Manage App | WEBSMITHS ChatApp</title>
      </Head>
      <main className="min-h-screen bg-ink-950 p-4 text-zinc-100 md:p-8">
        <div className="mx-auto max-w-6xl">
          <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-2xl font-semibold">Manage App</h1>
              <p className="mt-1 text-sm text-zinc-400">Site super admin controls for the WEBSMITHS ChatApp.</p>
            </div>
            <a className="rounded-md border border-white/10 px-3 py-2 text-sm text-zinc-200 hover:bg-white/10" href="/">
              Back to chat
            </a>
          </div>

          {error ? <div className="mb-4 rounded-md border border-red-400/20 bg-red-950/40 p-3 text-sm text-red-100">{error}</div> : null}

          <div className="mb-6 flex flex-wrap gap-3">
            <button className="rounded-md bg-teal-400 px-4 py-2 text-sm font-semibold text-ink-950" onClick={loadStatus}>Refresh</button>
            <button className="rounded-md border border-white/10 px-4 py-2 text-sm text-zinc-200 hover:bg-white/10" onClick={() => postAction("/api/admin/cleanup")}>Run cleanup</button>
            <button className="rounded-md border border-white/10 px-4 py-2 text-sm text-zinc-200 hover:bg-white/10" onClick={() => postAction("/api/admin/check-updates")}>Check for updates</button>
            {status?.git.updateAvailable ? (
              <button className="rounded-md border border-amber-300/30 bg-amber-300/10 px-4 py-2 text-sm text-amber-100 hover:bg-amber-300/20" onClick={() => postAction("/api/admin/update")}>Update app</button>
            ) : null}
          </div>

          {status ? (
            <div className="grid gap-4 lg:grid-cols-2">
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
                {status.git.latestRemoteMessage ? <Metric label="Remote message" value={status.git.latestRemoteMessage} /> : null}
                {status.git.error ? <p className="mt-2 text-sm text-amber-200">{status.git.error}</p> : null}
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
              </Panel>
              <Panel title="Accounts">
                <div className="space-y-2">
                  {status.users.map((user) => (
                    <div key={user.id} className="rounded-md bg-white/[0.04] p-3">
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <div className="text-sm font-medium">{user.email}</div>
                          <div className="text-xs text-zinc-500">{user.nickname}</div>
                        </div>
                        <div className="text-sm text-zinc-300">{formatBytes(user.storageUsedBytes)} / {formatBytes(user.storageLimitBytes)}</div>
                      </div>
                      <div className="mt-1 text-xs text-zinc-500">Last active {new Date(user.lastActiveAt).toLocaleString()}</div>
                      {user.inactiveWithFilesOlderThanPolicy ? <div className="mt-1 text-xs text-amber-200">Inactive file cleanup applies</div> : null}
                    </div>
                  ))}
                </div>
              </Panel>
              <Panel title="Action Result">
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs text-zinc-300">{JSON.stringify(actionResult, null, 2)}</pre>
              </Panel>
            </div>
          ) : (
            <div className="rounded-lg border border-white/10 bg-ink-900 p-5 text-sm text-zinc-400">Loading admin status...</div>
          )}
        </div>
      </main>
    </>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-white/10 bg-ink-900 p-4">
      <h2 className="mb-3 text-sm font-semibold text-zinc-100">{title}</h2>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-white/5 py-2 text-sm last:border-b-0">
      <span className="text-zinc-500">{label}</span>
      <span className="text-right text-zinc-100">{value}</span>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
  return `${Math.max(0, Math.round(bytes / 1024))}KB`;
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
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
