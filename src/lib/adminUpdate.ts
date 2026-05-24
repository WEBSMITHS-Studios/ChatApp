import { spawn } from "child_process";
import { existsSync, promises as fs } from "fs";
import path from "path";
import packageJson from "../../package.json";

export type UpdateStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type UpdateStep = {
  name: string;
  status: UpdateStepStatus;
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type UpdateRunStatus = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  phase: string;
  error: string | null;
  logPath: string;
  worktreePath: string;
  preservedPaths: string[];
  steps: UpdateStep[];
};

const updateRoot = path.join(process.cwd(), ".admin-update");
const statusPath = path.join(updateRoot, "status.json");
const runnerPath = path.join(updateRoot, "run-update.cjs");
const logPath = path.join(updateRoot, "update.log");
const pm2AppName = process.env.PM2_APP_NAME || packageJson.name || "websmiths-chatapp";

export async function getUpdateStatus(): Promise<UpdateRunStatus | null> {
  try {
    const raw = await fs.readFile(statusPath, "utf8");
    return JSON.parse(raw) as UpdateRunStatus;
  } catch {
    return null;
  }
}

export async function startAppUpdate() {
  await fs.mkdir(updateRoot, { recursive: true });

  const existing = await getUpdateStatus();
  if (existing?.running) {
    return existing;
  }

  const initialStatus: UpdateRunStatus = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    phase: "queued",
    error: null,
    logPath,
    worktreePath: process.cwd(),
    preservedPaths: [".env", getDatabaseLabel(), "uploads/"],
    steps: [
      { name: "Preflight", status: "pending" },
      { name: "Backup database", status: "pending" },
      { name: "Git pull", status: "pending" },
      { name: "Install dependencies", status: "pending" },
      { name: "Sync database schema", status: "pending" },
      { name: "Build app", status: "pending" },
      { name: "Restart PM2", status: "pending" }
    ]
  };

  await fs.writeFile(statusPath, JSON.stringify(initialStatus, null, 2));
  await fs.writeFile(logPath, `[${new Date().toISOString()}] Update queued\n`);
  await fs.writeFile(runnerPath, createRunnerScript(statusPath, logPath, pm2AppName), "utf8");

  const child = spawn(process.execPath, [runnerPath], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();

  return initialStatus;
}

function getDatabaseLabel() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl?.startsWith("file:")) return "database file from DATABASE_URL";
  const filePath = dbUrl.slice("file:".length);
  return path.basename(filePath);
}

function createRunnerScript(statusFile: string, logFile: string, pm2Name: string) {
  return `
const { execFileSync } = require("child_process");
const { existsSync, mkdirSync, copyFileSync, appendFileSync, writeFileSync, readFileSync } = require("fs");
const { rmSync } = require("fs");
const path = require("path");

const statusPath = ${JSON.stringify(statusFile)};
const logPath = ${JSON.stringify(logFile)};
const cwd = process.cwd();
const isWindows = process.platform === "win32";
const npmCmd = isWindows ? "npm.cmd" : "npm";
const pm2Cmd = isWindows ? "pm2.cmd" : "pm2";
const npxCmd = isWindows ? "npx.cmd" : "npx";
const pm2AppName = ${JSON.stringify(pm2Name)};
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(cwd, "backups");
const databaseUrl = process.env.DATABASE_URL || "";
const databasePath = databaseUrl.startsWith("file:") ? path.resolve(cwd, databaseUrl.slice(5)) : null;

function readStatus() {
  return JSON.parse(readFileSync(statusPath, "utf8"));
}

function writeStatus(next) {
  writeFileSync(statusPath, JSON.stringify(next, null, 2));
}

function log(line) {
  appendFileSync(logPath, "[" + new Date().toISOString() + "] " + line + "\\n");
}

function updateStep(index, status, detail) {
  const current = readStatus();
  current.phase = current.steps[index].name;
  current.steps[index].status = status;
  if (detail) current.steps[index].detail = detail;
  if (status === "running") current.steps[index].startedAt = new Date().toISOString();
  if (status === "completed" || status === "failed" || status === "skipped") current.steps[index].finishedAt = new Date().toISOString();
  writeStatus(current);
}

function finishOk(phase) {
  const current = readStatus();
  current.running = false;
  current.phase = phase;
  current.finishedAt = new Date().toISOString();
  writeStatus(current);
}

function finishFail(error) {
  const current = readStatus();
  current.running = false;
  current.phase = "failed";
  current.error = error instanceof Error ? error.message : String(error);
  current.finishedAt = new Date().toISOString();
  const runningStep = current.steps.find((step) => step.status === "running");
  if (runningStep) {
    runningStep.status = "failed";
    runningStep.finishedAt = new Date().toISOString();
    runningStep.detail = current.error;
  }
  writeStatus(current);
  log("FAILED: " + current.error);
}

function run(command, args, options = {}) {
  log("$ " + command + " " + args.join(" "));
  return execFileSync(command, args, {
    cwd,
    env: process.env,
    stdio: "pipe",
    encoding: "utf8",
    timeout: 20 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
}

function getTrackedWorktreeChanges() {
  return run("git", ["status", "--porcelain", "--untracked-files=no"]).trim();
}

function commandExists(command) {
  try {
    const lookup = isWindows ? "where" : "which";
    run(lookup, [command]);
    return true;
  } catch {
    return false;
  }
}

function tryRun(command, args, options = {}) {
  try {
    return { ok: true, output: run(command, args, options) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function restartPm2() {
  const attempts = [
    { command: npmCmd, args: ["run", "pm2:restart"], label: "npm run pm2:restart" },
    { command: pm2Cmd, args: ["restart", pm2AppName], label: "pm2 restart " + pm2AppName },
    { command: npxCmd, args: ["pm2", "restart", pm2AppName], label: "npx pm2 restart " + pm2AppName },
    { command: npmCmd, args: ["run", "pm2:start"], label: "npm run pm2:start" }
  ];

  const errors = [];
  for (const attempt of attempts) {
    if ((attempt.command === pm2Cmd || attempt.command === npxCmd) && !commandExists(attempt.command)) {
      errors.push(attempt.label + " not available on PATH");
      continue;
    }
    const result = tryRun(attempt.command, attempt.args);
    if (result.ok) {
      return {
        ok: true,
        detail: (result.output || "").trim().split(/\\r?\\n/).slice(-1)[0] || (attempt.label + " completed")
      };
    }
    errors.push(attempt.label + " failed: " + result.error);
    log(attempt.label + " failed: " + result.error);
  }

  return {
    ok: false,
    detail: errors.join(" | ")
  };
}

(async () => {
  try {
    mkdirSync(backupDir, { recursive: true });

    updateStep(0, "running", "Checking git state and required tools");
    const trackedChanges = getTrackedWorktreeChanges();
    if (trackedChanges) {
      throw new Error(
        "Update aborted because the worktree has tracked changes: " +
          trackedChanges
            .split(/\\r?\\n/)
            .filter(Boolean)
            .slice(0, 8)
            .join(", ") +
          ". Commit or stash them and retry."
      );
    }
    updateStep(0, "completed", ".env, uploads/, and the database file will be preserved.");

    updateStep(1, "running", databasePath ? "Creating SQLite backup" : "No SQLite file configured");
    if (databasePath && existsSync(databasePath)) {
      const backupName = path.basename(databasePath, path.extname(databasePath)) + "-" + timestamp + path.extname(databasePath);
      copyFileSync(databasePath, path.join(backupDir, backupName));
      updateStep(1, "completed", "Backup created at backups/" + backupName);
      log("Database backup created: " + backupName);
    } else {
      updateStep(1, "skipped", "Database file not found; skipping backup.");
    }

    updateStep(2, "running", "Running git pull --ff-only");
    const gitPullOutput = run("git", ["pull", "--ff-only"]);
    updateStep(2, "completed", gitPullOutput.trim() || "Git pull completed");

    updateStep(3, "running", "Installing/updating dependencies");
    const installOutput = run(npmCmd, ["install"]);
    updateStep(3, "completed", installOutput.trim().split(/\\r?\\n/).slice(-1)[0] || "Dependencies installed");

    updateStep(4, "running", "Running prisma db push");
    const dbOutput = run(npmCmd, ["run", "db:push"]);
    updateStep(4, "completed", dbOutput.trim().split(/\\r?\\n/).slice(-1)[0] || "Database schema synced");

    updateStep(5, "running", "Building application");
    const buildOutput = run(npmCmd, ["run", "build"]);
    updateStep(5, "completed", buildOutput.trim().split(/\\r?\\n/).slice(-1)[0] || "Build completed");

    updateStep(6, "running", "Restarting PM2 app if available");
    const restart = restartPm2();
    if (restart.ok) {
      updateStep(6, "completed", restart.detail);
    } else {
      updateStep(6, "skipped", "Automatic restart was not available. " + restart.detail);
    }

    finishOk("completed");
    log("Update completed successfully.");
  } catch (error) {
    finishFail(error);
  } finally {
    try {
      rmSync(${JSON.stringify(runnerPath)}, { force: true });
    } catch {}
  }
})();
`;
}
