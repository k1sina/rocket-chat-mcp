import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RocketChatClient, type Fetcher } from "../rocketchat-client.js";
import { getRoomHistory } from "./get-room-history.js";

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

const SAMPLE_MESSAGE = {
  _id: "m1",
  ts: "2026-04-29T10:00:00.000Z",
  u: { _id: "u1", username: "sina", name: "Keivan Sina" },
  msg: "hello world",
  editedAt: "2026-04-29T10:01:00.000Z",
  attachments: [{ _id: "a1" }, { _id: "a2" }],
  reactions: {
    ":thumbsup:": { usernames: ["alice", "bob"] },
    ":heart:": { usernames: ["carol"] },
  },
  tmid: "parent-id",
  tcount: 4,
};

describe("get_room_history", () => {
  it("routes 'c' rooms to channels.history (after rooms.info lookup)", async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (raw) => {
      const url = new URL(String(raw));
      calls.push(url.pathname);
      if (url.pathname === "/api/v1/rooms.info") {
        assert.equal(url.searchParams.get("roomId"), "rid-c");
        return jsonResponse({ room: { _id: "rid-c", t: "c" }, success: true });
      }
      if (url.pathname === "/api/v1/channels.history") {
        assert.equal(url.searchParams.get("roomId"), "rid-c");
        assert.equal(url.searchParams.get("count"), "50");
        return jsonResponse({ messages: [SAMPLE_MESSAGE], success: true });
      }
      return jsonResponse({ success: false }, 500);
    };
    const out = await getRoomHistory(clientWith(fetcher), { room_id: "rid-c" });
    assert.deepEqual(calls, ["/api/v1/rooms.info", "/api/v1/channels.history"]);
    assert.equal(out.room_type, "c");
    assert.equal(out.messages.length, 1);
  });

  it("routes 'p' rooms to groups.history", async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (raw) => {
      const url = new URL(String(raw));
      calls.push(url.pathname);
      if (url.pathname === "/api/v1/rooms.info") {
        return jsonResponse({ room: { _id: "rid-p", t: "p" }, success: true });
      }
      if (url.pathname === "/api/v1/groups.history") {
        return jsonResponse({ messages: [], success: true });
      }
      return jsonResponse({}, 500);
    };
    const out = await getRoomHistory(clientWith(fetcher), { room_id: "rid-p" });
    assert.deepEqual(calls, ["/api/v1/rooms.info", "/api/v1/groups.history"]);
    assert.equal(out.room_type, "p");
  });

  it("routes 'd' rooms to im.history", async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (raw) => {
      const url = new URL(String(raw));
      calls.push(url.pathname);
      if (url.pathname === "/api/v1/rooms.info") {
        return jsonResponse({ room: { _id: "rid-d", t: "d" }, success: true });
      }
      if (url.pathname === "/api/v1/im.history") {
        return jsonResponse({ messages: [], success: true });
      }
      return jsonResponse({}, 500);
    };
    const out = await getRoomHistory(clientWith(fetcher), { room_id: "rid-d" });
    assert.deepEqual(calls, ["/api/v1/rooms.info", "/api/v1/im.history"]);
    assert.equal(out.room_type, "d");
  });

  it("caches room type — second call for the same room skips rooms.info", async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (raw) => {
      const url = new URL(String(raw));
      calls.push(url.pathname);
      if (url.pathname === "/api/v1/rooms.info") {
        return jsonResponse({ room: { _id: "rid-c", t: "c" }, success: true });
      }
      if (url.pathname === "/api/v1/channels.history") {
        return jsonResponse({ messages: [], success: true });
      }
      return jsonResponse({}, 500);
    };
    const client = clientWith(fetcher);
    await getRoomHistory(client, { room_id: "rid-c" });
    await getRoomHistory(client, { room_id: "rid-c" });

    const infoCalls = calls.filter((c) => c === "/api/v1/rooms.info").length;
    const historyCalls = calls.filter((c) => c === "/api/v1/channels.history").length;
    assert.equal(infoCalls, 1, "rooms.info should be called only on first lookup");
    assert.equal(historyCalls, 2);
  });

  it("primed cache (e.g. by list_my_rooms) avoids rooms.info entirely", async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (raw) => {
      const url = new URL(String(raw));
      calls.push(url.pathname);
      if (url.pathname === "/api/v1/groups.history") {
        return jsonResponse({ messages: [], success: true });
      }
      return jsonResponse({}, 500);
    };
    const client = clientWith(fetcher);
    client.primeRoomType("primed-rid", "p");

    await getRoomHistory(client, { room_id: "primed-rid" });
    assert.deepEqual(calls, ["/api/v1/groups.history"]);
  });

  it("strips noisy message fields and collapses reactions to emoji→count", async () => {
    const fetcher: Fetcher = async (raw) => {
      const url = new URL(String(raw));
      if (url.pathname === "/api/v1/rooms.info")
        return jsonResponse({ room: { _id: "rid", t: "c" }, success: true });
      if (url.pathname === "/api/v1/channels.history")
        return jsonResponse({ messages: [SAMPLE_MESSAGE], success: true });
      return jsonResponse({}, 500);
    };
    const out = await getRoomHistory(clientWith(fetcher), { room_id: "rid" });
    const m = out.messages[0]!;
    assert.equal(m.id, "m1");
    assert.equal(m.ts, "2026-04-29T10:00:00.000Z");
    assert.deepEqual(m.user, { id: "u1", username: "sina", name: "Keivan Sina" });
    assert.equal(m.msg, "hello world");
    assert.equal(m.edited_at, "2026-04-29T10:01:00.000Z");
    assert.equal(m.attachments_count, 2);
    assert.deepEqual(m.reactions, { ":thumbsup:": 2, ":heart:": 1 });
    assert.equal(m.is_thread, true);
    assert.equal(m.thread_count, 4);
    // No raw RC fields should leak through.
    assert.equal((m as Record<string, unknown>).attachments, undefined);
    assert.equal((m as Record<string, unknown>).u, undefined);
    assert.equal((m as Record<string, unknown>).tmid, undefined);
  });

  it("forwards 'before' as the latest=… query param and respects limit", async () => {
    let captured: URL | null = null;
    const fetcher: Fetcher = async (raw) => {
      const url = new URL(String(raw));
      if (url.pathname === "/api/v1/rooms.info")
        return jsonResponse({ room: { _id: "rid", t: "c" }, success: true });
      if (url.pathname === "/api/v1/channels.history") {
        captured = url;
        return jsonResponse({ messages: [], success: true });
      }
      return jsonResponse({}, 500);
    };
    await getRoomHistory(clientWith(fetcher), {
      room_id: "rid",
      limit: 100,
      before: "2026-04-29T08:00:00.000Z",
    });
    assert.ok(captured);
    const c = captured as unknown as URL;
    assert.equal(c.searchParams.get("count"), "100");
    assert.equal(c.searchParams.get("latest"), "2026-04-29T08:00:00.000Z");
  });

  it("propagates the explicit env-var hint when rooms.info returns 401", async () => {
    const fetcher: Fetcher = async (raw) => {
      const url = new URL(String(raw));
      if (url.pathname === "/api/v1/rooms.info")
        return jsonResponse({ status: "error", message: "Unauthorized" }, 401);
      return jsonResponse({}, 500);
    };
    await assert.rejects(
      () => getRoomHistory(clientWith(fetcher), { room_id: "rid" }),
      (err: Error) =>
        /ROCKETCHAT_USER_ID/.test(err.message) && /ROCKETCHAT_AUTH_TOKEN/.test(err.message)
    );
  });
});
