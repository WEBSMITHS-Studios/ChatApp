import type { NextApiRequest, NextApiResponse } from "next";
import { requireSiteAdmin } from "@/lib/admin";
import { clearGlobalChatMessages } from "@/lib/adminStatus";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await requireSiteAdmin(req, res))) return;

  try {
    return res.status(200).json(await clearGlobalChatMessages());
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Could not clear global chat" });
  }
}
