import type { NextApiRequest, NextApiResponse } from "next";
import { getCurrentUser } from "./auth";
import { isSiteAdminEmail } from "./siteAdmin";

export async function requireSiteAdmin(req: NextApiRequest, res: NextApiResponse) {
  const user = await getCurrentUser(req);
  if (!user || !isSiteAdminEmail(user.email)) {
    res.status(403).json({ error: "Site admin access required" });
    return null;
  }
  return user;
}
