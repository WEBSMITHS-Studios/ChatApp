import { createReadStream, existsSync, mkdirSync, promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import type { AttachmentKind } from "./chatTypes";
import { prisma } from "./db";

export const ACCOUNT_STORAGE_LIMIT_BYTES = 500 * 1024 * 1024;
export const ANON_UPLOAD_TTL_MS = 60 * 60 * 1000;
export const INACTIVE_ACCOUNT_FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const uploadRoot = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(process.cwd(), "uploads");

const allowedTypes: Record<string, { extensions: string[]; kind: AttachmentKind; maxBytes: number; magic?: number[][] }> = {
  "image/jpeg": { extensions: [".jpg", ".jpeg"], kind: "image", maxBytes: 10 * 1024 * 1024, magic: [[0xff, 0xd8, 0xff]] },
  "image/png": { extensions: [".png"], kind: "image", maxBytes: 10 * 1024 * 1024, magic: [[0x89, 0x50, 0x4e, 0x47]] },
  "image/webp": { extensions: [".webp"], kind: "image", maxBytes: 10 * 1024 * 1024 },
  "image/gif": { extensions: [".gif"], kind: "gif", maxBytes: 20 * 1024 * 1024, magic: [[0x47, 0x49, 0x46, 0x38]] },
  "application/pdf": { extensions: [".pdf"], kind: "pdf", maxBytes: 25 * 1024 * 1024, magic: [[0x25, 0x50, 0x44, 0x46]] },
  "video/mp4": { extensions: [".mp4"], kind: "video", maxBytes: 50 * 1024 * 1024 },
  "video/webm": { extensions: [".webm"], kind: "video", maxBytes: 50 * 1024 * 1024 },
  "video/quicktime": { extensions: [".mov"], kind: "video", maxBytes: 50 * 1024 * 1024 }
};

export type ValidatedUpload = {
  originalName: string;
  mimeType: string;
  extension: string;
  kind: AttachmentKind;
  byteSize: number;
  buffer: Buffer;
};

export function ensureUploadRoot() {
  if (!existsSync(uploadRoot)) {
    mkdirSync(uploadRoot, { recursive: true });
  }
}

export function getUploadRoot() {
  ensureUploadRoot();
  return uploadRoot;
}

export function getAttachmentPath(storedName: string) {
  const safeName = path.basename(storedName);
  return path.join(getUploadRoot(), safeName);
}

export function validateUploadFile(file: { filename: string; contentType: string; data: Buffer }): ValidatedUpload {
  const originalName = sanitizeOriginalName(file.filename);
  const mimeType = file.contentType.toLowerCase();
  const extension = path.extname(originalName).toLowerCase();
  const rule = allowedTypes[mimeType];

  if (!rule || !rule.extensions.includes(extension)) {
    throw new Error("Unsupported file type");
  }
  if (file.data.byteLength > rule.maxBytes) {
    throw new Error(`File is too large. Max size is ${formatBytes(rule.maxBytes)}.`);
  }
  if (rule.magic && !rule.magic.some((signature) => startsWithBytes(file.data, signature))) {
    throw new Error("File contents do not match the selected file type");
  }
  if (mimeType === "image/webp" && !isWebp(file.data)) {
    throw new Error("File contents do not match the selected file type");
  }
  if (mimeType === "video/webm" && !startsWithBytes(file.data, [0x1a, 0x45, 0xdf, 0xa3])) {
    throw new Error("File contents do not match the selected file type");
  }
  if ((mimeType === "video/mp4" || mimeType === "video/quicktime") && !hasFtypBox(file.data)) {
    throw new Error("File contents do not match the selected file type");
  }

  return {
    originalName,
    mimeType,
    extension,
    kind: rule.kind,
    byteSize: file.data.byteLength,
    buffer: file.data
  };
}

export async function writeUploadFile(upload: ValidatedUpload) {
  ensureUploadRoot();
  const storedName = `${randomBytes(18).toString("base64url")}${upload.extension}`;
  const fullPath = getAttachmentPath(storedName);
  await fs.writeFile(fullPath, upload.buffer, { flag: "wx" });
  return storedName;
}

export async function deleteStoredAttachment(storedName: string) {
  try {
    await fs.unlink(getAttachmentPath(storedName));
  } catch {
    // Missing files are treated as already cleaned up.
  }
}

export async function pruneAccountStorage(userId: string, incomingBytes: number) {
  if (incomingBytes > ACCOUNT_STORAGE_LIMIT_BYTES) {
    throw new Error("File is larger than the 500MB account storage limit");
  }

  let total = await getAccountStorageUsed(userId);
  const overflow = total + incomingBytes - ACCOUNT_STORAGE_LIMIT_BYTES;
  if (overflow <= 0) return;

  const oldest = await prisma.attachment.findMany({
    where: { uploaderUserId: userId, deletedAt: null },
    orderBy: { createdAt: "asc" }
  });

  let freed = 0;
  for (const attachment of oldest) {
    await markAttachmentDeleted(attachment.id, attachment.storedName, "storage_pruned");
    freed += attachment.byteSize;
    total -= attachment.byteSize;
    if (freed >= overflow || total + incomingBytes <= ACCOUNT_STORAGE_LIMIT_BYTES) break;
  }
}

export async function getAccountStorageUsed(userId: string) {
  const aggregate = await prisma.attachment.aggregate({
    where: { uploaderUserId: userId, deletedAt: null },
    _sum: { byteSize: true }
  });
  return aggregate._sum.byteSize ?? 0;
}

export async function markAttachmentDeleted(id: string, storedName: string, reason = "removed") {
  await deleteStoredAttachment(storedName);
  await prisma.attachment.update({
    where: { id },
    data: { deletedAt: new Date(), deletedReason: reason }
  });
}

export async function cleanupExpiredAndMissingUploads() {
  ensureUploadRoot();
  const now = new Date();
  const expired = await prisma.attachment.findMany({
    where: {
      deletedAt: null,
      OR: [{ expiresAt: { lte: now } }, { messageId: null, createdAt: { lte: new Date(Date.now() - 60 * 60 * 1000) } }]
    }
  });

  for (const attachment of expired) {
    await markAttachmentDeleted(attachment.id, attachment.storedName, "expired");
  }

  const inactiveUsers = await prisma.user.findMany({
    where: { lastActiveAt: { lte: new Date(Date.now() - INACTIVE_ACCOUNT_FILE_TTL_MS) } },
    select: { id: true }
  });
  const inactiveUserIds = inactiveUsers.map((user) => user.id);
  if (inactiveUserIds.length) {
    const inactiveAttachments = await prisma.attachment.findMany({
      where: {
        uploaderUserId: { in: inactiveUserIds },
        deletedAt: null
      }
    });
    for (const attachment of inactiveAttachments) {
      await markAttachmentDeleted(attachment.id, attachment.storedName, "inactivity");
    }
  }

  const active = await prisma.attachment.findMany({ where: { deletedAt: null } });
  const knownFiles = new Set(active.map((attachment) => attachment.storedName));
  for (const attachment of active) {
    if (!existsSync(getAttachmentPath(attachment.storedName))) {
      await prisma.attachment.update({
        where: { id: attachment.id },
        data: { deletedAt: new Date(), deletedReason: "missing" }
      });
    }
  }

  const diskFiles = await fs.readdir(getUploadRoot()).catch(() => []);
  for (const diskFile of diskFiles) {
    if (!knownFiles.has(diskFile)) {
      const stat = await fs.stat(getAttachmentPath(diskFile)).catch(() => null);
      if (stat && stat.mtimeMs <= Date.now() - 60 * 60 * 1000) {
        await deleteStoredAttachment(diskFile);
      }
    }
  }

  console.log(
    `Upload cleanup complete: expired=${expired.length}, inactive=${inactiveUserIds.length}, active=${active.length}`
  );
}

export async function getStorageSummary() {
  const active = await prisma.attachment.findMany({
    where: { deletedAt: null },
    include: { uploaderUser: true }
  });
  const totalUploadsBytes = active.reduce((sum, attachment) => sum + attachment.byteSize, 0);
  const accountUploadsBytes = active
    .filter((attachment) => attachment.uploaderUserId)
    .reduce((sum, attachment) => sum + attachment.byteSize, 0);
  const anonymousUploadsBytes = active
    .filter((attachment) => !attachment.uploaderUserId)
    .reduce((sum, attachment) => sum + attachment.byteSize, 0);
  const temporary = active.filter((attachment) => !attachment.uploaderUserId);
  const oldestTemporaryCreatedAt = temporary.reduce<Date | null>((oldest, attachment) => {
    if (!oldest || attachment.createdAt < oldest) return attachment.createdAt;
    return oldest;
  }, null);

  return {
    totalUploadsBytes,
    accountUploadsBytes,
    anonymousUploadsBytes,
    oldestTemporaryCreatedAt,
    accountStorageLimitBytes: ACCOUNT_STORAGE_LIMIT_BYTES
  };
}

export function startUploadCleanupJob() {
  cleanupExpiredAndMissingUploads().catch((error) => console.error("Upload cleanup failed", error));
  setInterval(() => {
    cleanupExpiredAndMissingUploads().catch((error) => console.error("Upload cleanup failed", error));
  }, 15 * 60 * 1000).unref?.();
}

export function createAttachmentReadStream(storedName: string) {
  return createReadStream(getAttachmentPath(storedName));
}

function sanitizeOriginalName(filename: string) {
  const base = path.basename(filename || "upload").replace(/[\x00-\x1f\x7f]/g, "").trim();
  return base.slice(0, 180) || "upload";
}

function startsWithBytes(buffer: Buffer, signature: number[]) {
  if (buffer.length < signature.length) return false;
  return signature.every((byte, index) => buffer[index] === byte);
}

function isWebp(buffer: Buffer) {
  return buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
}

function hasFtypBox(buffer: Buffer) {
  return buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp";
}

function formatBytes(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}
