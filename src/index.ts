#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RocketChatClient } from "./rocketchat-client.js";
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

function readEnv(): { url: string; debug: boolean } {
  const url = process.env.ROCKETCHAT_URL?.trim();
  if (!url) {
    console.error("Missing ROCKETCHAT_URL. Set it to your Rocket.Chat base URL (e.g. https://chat.example.com).");
    process.exit(1);
  }
  if (url.endsWith("/")) {
    console.error(`ROCKETCHAT_URL must not end with a slash. Got: ${url}`);
    process.exit(1);
  }
  if (/\/api\/v\d+/i.test(url)) {
    console.error(`ROCKETCHAT_URL must not include /api/v1. Got: ${url}`);
    process.exit(1);
  }
  // headers.ts will validate user id / token on first request.
  if (!process.env.ROCKETCHAT_USER_ID?.trim() || !process.env.ROCKETCHAT_AUTH_TOKEN?.trim()) {
    console.error(
      "Missing ROCKETCHAT_USER_ID or ROCKETCHAT_AUTH_TOKEN. Create a Personal Access Token in Rocket.Chat (My Account → Personal Access Tokens) and set both env vars."
    );
    process.exit(1);
  }
  return { url, debug: process.env.DEBUG === "1" };
}

async function main(): Promise<void> {
  const { url, debug } = readEnv();
  const client = new RocketChatClient(url, { debug });

  try {
    const me = await client.selfTest();
    console.error(`[rocket-chat-mcp] Connected as @${me.username} (${url})`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[rocket-chat-mcp] Startup self-test failed: ${reason}`);
    process.exit(1);
  }

  const server = new McpServer({
    name: "rocket-chat-mcp",
    version: "0.1.0",
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[rocket-chat-mcp] Listening on stdio.");
}

main().catch((err: unknown) => {
  const reason = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[rocket-chat-mcp] Fatal: ${reason}`);
  process.exit(1);
});
