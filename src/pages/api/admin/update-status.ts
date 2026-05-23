import type { NextApiRequest, NextApiResponse } from "next";
import { requireSiteAdmin } from "@/lib/admin";
import { getUpdateStatus } from "@/lib/adminUpdate";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await requireSiteAdmin(req, res))) return;
  return res.status(200).json({ update: await getUpdateStatus() });
}
