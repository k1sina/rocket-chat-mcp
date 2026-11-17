#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RocketChatClient } from "./rocketchat-client.js";
import { isHttpTransport, loadHttpOptions, startHttpServer } from "./http.js";
import { createServer, SERVER_NAME } from "./server.js";

const DEFAULT_HTTP_PORT = 8702;

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
  // Validate transport settings before any network call, so a typo fails fast.
  const http = isHttpTransport() ? loadHttpOptions(process.env, DEFAULT_HTTP_PORT) : undefined;
  const client = new RocketChatClient(url, { debug });

  let username: string;
  try {
    ({ username } = await client.selfTest());
    console.error(`[${SERVER_NAME}] Connected as @${username} (${url})`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[${SERVER_NAME}] Startup self-test failed: ${reason}`);
    process.exit(1);
  }

  if (http) {
    await startHttpServer(SERVER_NAME, () => createServer(client), http);
    console.error(
      `[${SERVER_NAME}] Listening on http://${http.host}:${http.port}/mcp as @${username}` +
        `${http.token ? "" : " (no MCP_HTTP_TOKEN: loopback only)"}`,
    );
    return;
  }

  await createServer(client).connect(new StdioServerTransport());
  console.error(`[${SERVER_NAME}] Listening on stdio.`);
}

main().catch((err: unknown) => {
  const reason = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[${SERVER_NAME}] Fatal: ${reason}`);
  process.exit(1);
});
