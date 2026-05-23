import { execFile } from "child_process";
import { existsSync, promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import { prisma } from "./db";
import { ACCOUNT_STORAGE_LIMIT_BYTES, cleanupExpiredAndMissingUploads, getStorageSummary, getUploadRoot } from "./uploads";
import packageJson from "../../package.json";

const execFileAsync = promisify(execFile);

export async function getAdminStatus() {
  const [git, storage, users, database, uploadsWritable, disk] = await Promise.all([
    getGitStatus(),
    getStorageSummary(),
    getUserStorageOverview(),
    getDatabaseInfo(),
    checkUploadsWritable(),
    getDiskInfo()
  ]);

  return {
    app: {
      name: packageJson.name,
      version: packageJson.version,
      uptimeSeconds: Math.floor(process.uptime())
    },
    git,
    storage: {
      ...storage,
      databaseBytes: database.sizeBytes,
      disk
    },
    users,
    health: {
      databaseReachable: database.reachable,
      uploadsFolderWritable: uploadsWritable,
      socketServerRunning: true,
      uptimeSeconds: Math.floor(process.uptime())
    }
  };
}

export async function runManualCleanup() {
  await cleanupExpiredAndMissingUploads();
  return getAdminStatus();
}

export async function checkUpdates() {
  const current = await git(["rev-parse", "HEAD"]);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const remote = await git(["ls-remote", "origin", "refs/heads/main"]);
  const latestRemoteCommit = remote.ok ? remote.stdout.trim().split(/\s+/)[0] ?? null : null;
  const latestRemoteMessage = latestRemoteCommit ? await git(["log", "--format=%s", "-n", "1", latestRemoteCommit]) : null;

  return {
    currentBranch: branch.ok ? branch.stdout.trim() : null,
    currentCommit: current.ok ? current.stdout.trim() : null,
    latestRemoteCommit,
    updateAvailable: Boolean(current.ok && latestRemoteCommit && latestRemoteCommit !== current.stdout.trim()),
    latestRemoteMessage: latestRemoteMessage?.ok ? latestRemoteMessage.stdout.trim() : null,
    error: !current.ok ? current.stderr : !remote.ok ? remote.stderr : null
  };
}

export function getManualUpdatePlan() {
  return {
    autoUpdateImplemented: false,
    reason: "Automatic git pull/build/restart is intentionally disabled in the web process to avoid overwriting data.",
    preserves: [".env", "prod.db", "uploads/"],
    commands: [
      "cp prod.db backups/prod-$(date +%Y%m%d%H%M%S).db",
      "tar -czf backups/uploads-$(date +%Y%m%d%H%M%S).tgz uploads",
      "git pull --ff-only",
      "npm install",
      "npm run db:push",
      "npm run build",
      "pm2 restart websmiths-chatapp"
    ]
  };
}

async function getUserStorageOverview() {
  const users = await prisma.user.findMany({
    orderBy: { email: "asc" },
    include: {
      attachments: {
        where: { deletedAt: null }
      }
    }
  });

  return users.map((user) => ({
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    lastActiveAt: user.lastActiveAt.toISOString(),
    storageUsedBytes: user.attachments.reduce((sum, attachment) => sum + attachment.byteSize, 0),
    storageLimitBytes: ACCOUNT_STORAGE_LIMIT_BYTES,
    inactiveWithFilesOlderThanPolicy:
      user.attachments.length > 0 && user.lastActiveAt.getTime() <= Date.now() - 30 * 24 * 60 * 60 * 1000
  }));
}

async function getDatabaseInfo() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const databasePath = getSqlitePath();
    const stat = databasePath && existsSync(databasePath) ? await fs.stat(databasePath) : null;
    return { reachable: true, sizeBytes: stat?.size ?? 0 };
  } catch {
    return { reachable: false, sizeBytes: 0 };
  }
}

async function checkUploadsWritable() {
  try {
    const testPath = path.join(getUploadRoot(), `.write-test-${process.pid}`);
    await fs.writeFile(testPath, "ok", { flag: "w" });
    await fs.unlink(testPath);
    return true;
  } catch {
    return false;
  }
}

async function getDiskInfo() {
  try {
    const statfs = await fs.statfs(getUploadRoot());
    return {
      freeBytes: Number(statfs.bavail) * Number(statfs.bsize),
      totalBytes: Number(statfs.blocks) * Number(statfs.bsize)
    };
  } catch {
    return null;
  }
}

async function getGitStatus() {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = await git(["rev-parse", "--short", "HEAD"]);
  const status = await git(["status", "-sb"]);
  const update = await checkUpdates();

  return {
    branch: branch.ok ? branch.stdout.trim() : null,
    commit: commit.ok ? commit.stdout.trim() : null,
    aheadBehind: status.ok ? status.stdout.trim() : null,
    updateAvailable: update.updateAvailable,
    latestRemoteCommit: update.latestRemoteCommit,
    latestRemoteMessage: update.latestRemoteMessage,
    error: branch.ok ? update.error : branch.stderr
  };
}

async function git(args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: process.cwd(),
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : "Git command failed"
    };
  }
}

function getSqlitePath() {
  const value = process.env.DATABASE_URL;
  if (!value?.startsWith("file:")) return null;
  const filePath = value.slice("file:".length);
  return path.resolve(process.cwd(), filePath);
}
