import { getRoomRoleRank } from "./chatTypes";

export function canModerate(role: string) {
  return getRoomRoleRank(role) >= getRoomRoleRank("admin");
}

export function isSuperAdmin(role: string) {
  return role === "super_admin";
}
