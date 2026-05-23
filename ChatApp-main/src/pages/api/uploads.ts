import type { NextApiRequest, NextApiResponse } from "next";
import { normalizeAttachmentKind } from "@/lib/chatTypes";
import { getCurrentUser, touchUserActivity } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  ANON_UPLOAD_TTL_MS,
  deleteStoredAttachment,
  pruneAccountStorage,
  validateUploadFile,
  writeUploadFile
} from "@/lib/uploads";

export const config = {
  api: {
    bodyParser: false
  }
};

const MAX_UPLOAD_REQUEST_BYTES = 55 * 1024 * 1024;

type MultipartFile = {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const ip = getClientIp(req);
  const limit = checkRateLimit(`upload:${ip}`, 20, 60 * 1000);
  if (!limit.allowed) return res.status(429).json({ error: "Too many uploads. Try again shortly." });

  try {
    const currentUser = await getCurrentUser(req);
    const { fields, files } = parseMultipart(req, await readRequest(req));
    const roomId = firstField(fields.roomId);
    const identityId = firstField(fields.identityId);

    if (!roomId || !identityId || identityId.length > 100) {
      return res.status(400).json({ error: "Invalid upload context" });
    }
    if (identityId.startsWith("user:")) {
      if (!currentUser || identityId !== `user:${currentUser.id}`) {
        return res.status(401).json({ error: "Sign in again before uploading" });
      }
    }

    const member = await prisma.roomMember.findUnique({
      where: { roomId_identityId: { roomId, identityId } },
      include: { room: true }
    });
    if (!member) return res.status(403).json({ error: "Join the room before uploading" });
    if (member.room.expiresAt && member.room.expiresAt.getTime() <= Date.now()) {
      return res.status(410).json({ error: "This room has expired" });
    }
    if (files.length === 0) return res.status(400).json({ error: "Choose a file to upload" });
    if (files.length > 4) return res.status(400).json({ error: "Upload up to 4 files at once" });

    const uploaded = [];
    for (const file of files) {
      const safeFile = validateUploadFile(file);
      if (currentUser) {
        await pruneAccountStorage(currentUser.id, safeFile.byteSize);
      }
      const storedName = await writeUploadFile(safeFile);
      let attachment;
      try {
        attachment = await prisma.attachment.create({
          data: {
            roomId,
            memberId: member.id,
            uploaderUserId: currentUser?.id ?? null,
            uploaderIdentityId: identityId,
            originalName: safeFile.originalName,
            storedName,
            mimeType: safeFile.mimeType,
            extension: safeFile.extension,
            kind: safeFile.kind,
            byteSize: safeFile.byteSize,
            expiresAt: currentUser ? null : new Date(Date.now() + ANON_UPLOAD_TTL_MS)
          }
        });
      } catch (error) {
        await deleteStoredAttachment(storedName);
        throw error;
      }
      if (currentUser) {
        await touchUserActivity(currentUser.id);
      }
      uploaded.push(publicAttachment(attachment));
    }

    return res.status(201).json({ attachments: uploaded });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Upload failed" });
  }
}

function readRequest(req: NextApiRequest) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_REQUEST_BYTES) {
        req.destroy(new Error("Upload request is too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(req: NextApiRequest, body: Buffer) {
  const contentType = req.headers["content-type"] ?? "";
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) throw new Error("Invalid upload request");

  const delimiter = Buffer.from(`--${boundary}`);
  const fields: Record<string, string[]> = {};
  const files: MultipartFile[] = [];
  let cursor = 0;

  while (cursor < body.length) {
    const start = body.indexOf(delimiter, cursor);
    if (start < 0) break;
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next < 0) break;

    let part = body.subarray(start + delimiter.length, next);
    if (part.subarray(0, 2).toString() === "--") break;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(part.length - 2).toString() === "\r\n") part = part.subarray(0, part.length - 2);

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd > 0) {
      const headerText = part.subarray(0, headerEnd).toString("utf8");
      const data = part.subarray(headerEnd + 4);
      const disposition = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(headerText)?.[1] ?? "";
      const name = /name="([^"]+)"/i.exec(disposition)?.[1] ?? "";
      const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
      const contentTypePart = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() ?? "application/octet-stream";

      if (filename !== undefined && filename !== "") {
        files.push({ fieldName: name, filename, contentType: contentTypePart, data });
      } else if (name) {
        fields[name] = [...(fields[name] ?? []), data.toString("utf8")];
      }
    }
    cursor = next;
  }

  return { fields, files };
}

function firstField(value: string[] | undefined) {
  return value?.[0]?.trim() ?? "";
}

function getClientIp(req: NextApiRequest) {
  const forwarded = req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return first?.trim() || req.socket.remoteAddress || "unknown";
}

function publicAttachment(attachment: {
  id: string;
  originalName: string;
  mimeType: string;
  kind: string;
  byteSize: number;
  expiresAt: Date | null;
  deletedAt: Date | null;
  deletedReason?: string | null;
}) {
  return {
    id: attachment.id,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    kind: normalizeAttachmentKind(attachment.kind),
    byteSize: attachment.byteSize,
    expiresAt: attachment.expiresAt?.toISOString() ?? null,
    deletedAt: attachment.deletedAt?.toISOString() ?? null,
    deletedReason: attachment.deletedReason ?? null,
    url: `/api/attachments/${attachment.id}`
  };
}
