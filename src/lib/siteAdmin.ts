import { normalizeEmail } from "./auth";

export function getAdminEmails() {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => normalizeEmail(email))
      .filter(Boolean)
  );
}

export function isSiteAdminEmail(email: string | null | undefined) {
  if (!email) return false;
  return getAdminEmails().has(normalizeEmail(email));
}
