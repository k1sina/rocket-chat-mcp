import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RocketChatClient, type Fetcher } from "../rocketchat-client.js";
import { searchMessages } from "./search-messages.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  process.env.ROCKETCHAT_USER_ID = "test-user";
  process.env.ROCKETCHAT_AUTH_TOKEN = "test-token";
});
afterEach(() => {
  process.env = originalEnv;
});

function clientWith(fetcher: Fetcher): RocketChatClient {
  return new RocketChatClient("https://chat.example.com", { fetcher });
}

describe("search_messages", () => {
  it("calls chat.search with roomId, searchText, count and returns stripped messages", async () => {
    let captured: URL | null = null;
    const fetcher: Fetcher = async (raw) => {
      const url = new URL(String(raw));
      if (url.pathname === "/api/v1/chat.search") {
        captured = url;
        return jsonResponse({
          messages: [
            {
              _id: "m1",
              ts: "2026-04-29T08:00:00.000Z",
              u: { _id: "u1", username: "sina", name: "Keivan Sina" },
              msg: "found term here",
              attachments: [],
              reactions: { ":eyes:": { usernames: ["a", "b"] } },
              tcount: 0,
            },
          ],
          success: true,
        });
      }
      return jsonResponse({}, 500);
    };

    const out = await searchMessages(clientWith(fetcher), {
      room_id: "rid-1",
      query: "deadline",
      limit: 50,
    });

    assert.ok(captured);
    const c = captured as unknown as URL;
    assert.equal(c.searchParams.get("roomId"), "rid-1");
    assert.equal(c.searchParams.get("searchText"), "deadline");
    assert.equal(c.searchParams.get("count"), "50");

    assert.equal(out.room_id, "rid-1");
    assert.equal(out.query, "deadline");
    assert.equal(out.messages.length, 1);
    const m = out.messages[0]!;
    assert.equal(m.id, "m1");
    assert.equal(m.msg, "found term here");
    assert.deepEqual(m.reactions, { ":eyes:": 2 });
    assert.equal(m.is_thread, false);
  });

  it("defaults count=30 when limit is omitted", async () => {
    let captured: URL | null = null;
    const fetcher: Fetcher = async (raw) => {
      const url = new URL(String(raw));
      captured = url;
      return jsonResponse({ messages: [], success: true });
    };
    await searchMessages(clientWith(fetcher), { room_id: "rid-1", query: "x" });
    const c = captured as unknown as URL;
    assert.equal(c.searchParams.get("count"), "30");
  });
});
