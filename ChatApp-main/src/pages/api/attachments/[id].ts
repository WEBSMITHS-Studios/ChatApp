import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { createAttachmentReadStream } from "@/lib/uploads";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = String(req.query.id ?? "");
  const attachment = await prisma.attachment.findUnique({
    where: { id },
    include: { message: true }
  });

  if (
    !attachment ||
    attachment.deletedAt ||
    !attachment.messageId ||
    attachment.message?.deletedAt ||
    (attachment.expiresAt && attachment.expiresAt.getTime() <= Date.now())
  ) {
    return res.status(404).json({ error: "Attachment expired or not found" });
  }

  res.setHeader("Content-Type", attachment.mimeType);
  res.setHeader("Content-Length", String(attachment.byteSize));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `${attachment.kind === "pdf" ? "attachment" : "inline"}; filename="${safeDownloadName(attachment.originalName)}"`);
  res.setHeader("Cache-Control", "private, max-age=300");

  createAttachmentReadStream(attachment.storedName)
    .on("error", () => {
      if (!res.headersSent) res.status(404).end("Attachment not found");
      else res.end();
    })
    .pipe(res);
}

function safeDownloadName(name: string) {
  return name.replace(/["\r\n\\]/g, "_").slice(0, 180) || "attachment";
}
