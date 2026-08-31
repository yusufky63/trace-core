export interface RoomInfo {
  name: string;
  seq: number;
  size: string;
  idle: string;
  topic: string;
  kind: "PUBLIC ROOM" | "UNLISTED SIGNED MAILBOX" | "UNLISTED EPHEMERAL" | "UNLISTED PRIVACY" | "EPHEMERAL ROOM" | "OWNABLE ROOM";
}

export interface RoomsSummary {
  activeRooms: number;
  capRooms: number;
  storedBytes: string;
  capBytes: string;
  rooms: RoomInfo[];
}

export function parseRoomsListing(text: string): RoomsSummary {
  const lines = text.split("\n");
  const meta: RoomsSummary = {
    activeRooms: 0,
    capRooms: 81920,
    storedBytes: "—",
    capBytes: "5.0G",
    rooms: [],
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) {
      const match = trimmed.match(/(\d+)\s+of\s+(\d+)\s+rooms\s+\(cap\s+(\d+),\s*([0-9.]+[MGK]?)\s+of\s+([0-9.]+[MGK]?)\s+stored\)/i);
      if (match) {
        meta.activeRooms = parseInt(match[2], 10);
        meta.capRooms = parseInt(match[3], 10);
        meta.storedBytes = match[4];
        meta.capBytes = match[5];
      }
      continue;
    }

    const match = trimmed.match(/^\/r\/([a-z0-9_-]+)\s+seq\s+(\d+)\s+([0-9.]+[MGK]?)\s+([^\s·]+(?:\s+ago)?)(?:\s+·\s*(.*))?$/i);
    if (match) {
      const name = match[1];
      let kind: RoomInfo["kind"] = "PUBLIC ROOM";
      if (name.startsWith("mb-p-")) kind = "UNLISTED SIGNED MAILBOX";
      else if (name.startsWith("e-p-")) kind = "UNLISTED EPHEMERAL";
      else if (name.startsWith("p-")) kind = "UNLISTED PRIVACY";
      else if (name.startsWith("e-")) kind = "EPHEMERAL ROOM";
      else if (name.startsWith("d-")) kind = "OWNABLE ROOM";

      meta.rooms.push({
        name,
        seq: parseInt(match[2], 10),
        size: match[3],
        idle: match[4],
        topic: (match[5] || "").trim(),
        kind,
      });
    }
  }
  return meta;
}

export function generateRoomSlug(prefix: "public" | "p-" | "e-" | "e-p-" | "mb-p-" | "d-", slug?: string): string {
  const clean = slug ? slug.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) : "";
  const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (prefix === "public") {
    return clean || `room-${randomHex().slice(0, 8)}`;
  }
  if (prefix === "p-") {
    return `p-${clean || randomHex()}`;
  }
  if (prefix === "e-") {
    return `e-${clean || randomHex().slice(0, 8)}`;
  }
  if (prefix === "e-p-") {
    return `e-p-${clean || randomHex()}`;
  }
  if (prefix === "mb-p-") {
    return `mb-p-${clean || randomHex()}`;
  }
  if (prefix === "d-") {
    return `d-${clean || randomHex().slice(0, 8)}`;
  }
  return clean || `room-${randomHex().slice(0, 8)}`;
}

export async function technocore(path: string, method: "GET" | "POST" = "GET", body?: unknown) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch("/api/technocore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, method, body }),
      });
      const text = await response.text();
      if (!response.ok) {
        let parsed: { error?: unknown } | null = null;
        try {
          parsed = JSON.parse(text) as { error?: unknown };
        } catch {}
        const errorMsg = typeof parsed?.error === "string" ? parsed.error : text || `Technocore returned ${response.status}.`;
        if ([502, 503, 504].includes(response.status) && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 300));
          continue;
        }
        throw new Error(errorMsg);
      }
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (err) {
      lastError = err;
      if (attempt < 3 && err instanceof Error && !err.message.includes("404") && !err.message.includes("limit")) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 300));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}
