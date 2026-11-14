export function visibleRoomMembers(role, members) {
  if (role !== "host" && role !== "guest") return [];
  if (!Array.isArray(members)) return [];
  return members.filter((member) => member && typeof member.name === "string" && member.name.trim());
}
