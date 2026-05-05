import { z } from "zod";
import type { RocketChatClient, RoomType } from "../rocketchat-client.js";
import {
  buildRow,
  fetchAllRooms,
  sortByLastMessageDesc,
  type RoomRow,
} from "./room-source.js";

const TYPE_FILTER = z.enum(["channel", "private", "dm", "all"]);
type TypeFilter = z.infer<typeof TYPE_FILTER>;

export const listMyRoomsInputShape = {
  type: TYPE_FILTER.optional().describe(
    "Filter by room type. 'channel' = public channels, 'private' = private groups, 'dm' = direct messages, 'all' = everything. Default 'all'."
  ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Maximum number of rooms to return (default 100)."),
};

const inputSchema = z.object(listMyRoomsInputShape);
export type ListMyRoomsInput = z.infer<typeof inputSchema>;

export const listMyRoomsDescription =
  "Lists ALL rooms you are subscribed to (channels, private groups, DMs). " +
  "Use list_unread instead if you only want rooms with unread activity. " +
  "Room IDs are opaque strings — they are NOT human-readable. To find a room by name, " +
  "call this tool first, then pass the resulting room_id to get_room_history or post_message. " +
  "Never invent room_ids. " +
  "Note: unread/mention counts are NOT included here (would require an extra request per room); " +
  "use list_unread when you specifically need that information.";

const TYPE_TO_LETTER: Record<Exclude<TypeFilter, "all">, RoomType> = {
  channel: "c",
  private: "p",
  dm: "d",
};

export async function listMyRooms(
  client: RocketChatClient,
  input: ListMyRoomsInput
): Promise<{ rooms: Omit<RoomRow, "unread_count" | "mention_count">[] }> {
  const typeFilter = input.type ?? "all";
  const limit = input.limit ?? 100;
  const types =
    typeFilter === "all" ? (["c", "p", "d"] as RoomType[]) : [TYPE_TO_LETTER[typeFilter]];

  const rooms = await fetchAllRooms(client, { types });
  const rows = rooms.map((r) => buildRow(r));
  const sorted = sortByLastMessageDesc(rows).slice(0, limit);
  const stripped = sorted.map(
    ({ unread_count: _u, mention_count: _m, ...rest }) => rest
  );
  return { rooms: stripped };
}
