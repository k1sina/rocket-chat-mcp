import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { isHttpTransport, loadHttpOptions, startHttpServer } from "./http.js";
import { RocketChatClient, type Fetcher } from "./rocketchat-client.js";
import { createServer } from "./server.js";

const TOKEN = "a".repeat(64);
const TOOL_COUNT = 6;

let server: Server | undefined;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  process.env.ROCKETCHAT_USER_ID = "test-user";
  process.env.ROCKETCHAT_AUTH_TOKEN = "test-token";
});

afterEach(async () => {
  process.env = originalEnv;
  const s = server;
  server = undefined;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
});

/** Answers users.info so a real tool call can run with no network. */
const fetcher: Fetcher = async () =>
  new Response(
    JSON.stringify({
      user: { _id: "u1", username: "lukas", name: "Lukas", status: "online", active: true, roles: ["user"] },
      success: true,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

async function start(token?: string): Promise<string> {
  const client = new RocketChatClient("https://chat.invalid", { fetcher });
  server = await startHttpServer("test", () => createServer(client), { host: "127.0.0.1", port: 0, token });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function connect(base: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "http-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  return client;
}

function raw(
  base: string,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const url = new URL(opts.path ?? "/mcp", base);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: opts.method ?? "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...opts.headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
});

describe("http options", () => {
  it("defaults to stdio and rejects unknown transports", () => {
    assert.equal(isHttpTransport({}), false);
    assert.equal(isHttpTransport({ MCP_TRANSPORT: "http" }), true);
    assert.throws(() => isHttpTransport({ MCP_TRANSPORT: "sse" }), /stdio" or "http/);
  });

  it("defaults to loopback and refuses a public host without a token", () => {
    assert.deepEqual(loadHttpOptions({}, 8702), { host: "127.0.0.1", port: 8702, token: undefined });
    assert.throws(() => loadHttpOptions({ MCP_HTTP_HOST: "0.0.0.0" }, 8702), /not a loopback/);
    assert.throws(() => loadHttpOptions({ MCP_HTTP_TOKEN: "short" }, 8702), /at least 32/);
  });
});

describe("http transport", () => {
  it("lists tools and runs a tool call with the token", async () => {
    const base = await start(TOKEN);
    const client = await connect(base, { Authorization: `Bearer ${TOKEN}` });
    assert.equal((await client.listTools()).tools.length, TOOL_COUNT);
    const result = await client.callTool({ name: "get_user", arguments: { username: "@lukas" } });
    assert.notEqual(result.isError, true);
    assert.match(JSON.stringify(result.content), /lukas/);
    await client.close();
  });

  it("rejects a missing or wrong token with 401", async () => {
    const base = await start(TOKEN);
    const missing = await raw(base, { body: INIT });
    assert.equal(missing.status, 401);
    assert.match(String(missing.headers["www-authenticate"]), /^Bearer/);
    const wrong = await raw(base, { body: INIT, headers: { authorization: `Bearer ${"b".repeat(64)}` } });
    assert.equal(wrong.status, 401);
  });

  it("without a token, serves loopback and rejects a foreign Host header", async () => {
    const base = await start();
    const client = await connect(base);
    assert.equal((await client.listTools()).tools.length, TOOL_COUNT);
    await client.close();
    const res = await raw(base, { body: INIT, headers: { host: "evil.example:8702" } });
    assert.equal(res.status, 403);
  });

  it("routes /healthz, 404s other paths, and 405s GET on /mcp", async () => {
    const base = await start(TOKEN);
    assert.equal((await raw(base, { method: "GET", path: "/healthz" })).status, 200);
    assert.equal((await raw(base, { method: "GET", path: "/" })).status, 404);
    const get = await raw(base, { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(get.status, 405);
  });
});
