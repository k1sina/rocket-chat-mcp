import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RocketChatClient } from "./rocketchat-client.js";
import {
  listUnread,
  listUnreadDescription,
  listUnreadInputShape,
} from "./tools/list-unread.js";
import {
  listMyRooms,
  listMyRoomsDescription,
  listMyRoomsInputShape,
} from "./tools/list-my-rooms.js";
import {
  getRoomHistory,
  getRoomHistoryDescription,
  getRoomHistoryInputShape,
} from "./tools/get-room-history.js";
import {
  searchMessages,
  searchMessagesDescription,
  searchMessagesInputShape,
} from "./tools/search-messages.js";
import {
  getUser,
  getUserDescription,
  getUserInputShape,
} from "./tools/get-user.js";
import {
  postMessage,
  postMessageDescription,
  postMessageInputShape,
} from "./tools/post-message.js";

export const SERVER_NAME = "rocket-chat-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Build a fully registered McpServer. Cheap enough to call per request, which
 * is what the stateless HTTP transport does; stdio calls it once.
 */
export function createServer(client: RocketChatClient): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  function ok<T>(data: T) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }

  server.registerTool(
    "list_unread",
    {
      description: listUnreadDescription,
      inputSchema: listUnreadInputShape,
    },
    async (input) => ok(await listUnread(client, input))
  );

  server.registerTool(
    "list_my_rooms",
    {
      description: listMyRoomsDescription,
      inputSchema: listMyRoomsInputShape,
    },
    async (input) => ok(await listMyRooms(client, input))
  );

  server.registerTool(
    "get_room_history",
    {
      description: getRoomHistoryDescription,
      inputSchema: getRoomHistoryInputShape,
    },
    async (input) => ok(await getRoomHistory(client, input))
  );

  server.registerTool(
    "search_messages",
    {
      description: searchMessagesDescription,
      inputSchema: searchMessagesInputShape,
    },
    async (input) => ok(await searchMessages(client, input))
  );

  server.registerTool(
    "get_user",
    {
      description: getUserDescription,
      inputSchema: getUserInputShape,
    },
    async (input) => ok(await getUser(client, input))
  );

  server.registerTool(
    "post_message",
    {
      description: postMessageDescription,
      inputSchema: postMessageInputShape,
    },
    async (input) => ok(await postMessage(client, input))
  );

  return server;
}
