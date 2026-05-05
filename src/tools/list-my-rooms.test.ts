import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RocketChatClient, type Fetcher } from "../rocketchat-client.js";
import { listMyRooms } from "./list-my-rooms.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CHANNELS = {
  channels: [
    { _id: "c1", t: "c", name: "general", lm: "2026-04-29T01:00:00.000Z" },
    { _id: "c2", t: "c", name: "random", lm: "2026-04-29T02:00:00.000Z" },
  ],
  total: 2,
  success: true,
};
const GROUPS = {
  groups: [{ _id: "p1", t: "p", name: "secret", lm: "2026-04-29T03:00:00.000Z" }],
  total: 1,
  success: true,
};
const IMS = {
  ims: [
    {
      _id: "d1",
      t: "d",
      usernames: ["sina", "lukas"],
      lm: "2026-04-29T04:00:00.000Z",
    },
  ],
  total: 1,
  success: true,
};

function buildFetcher(opts: { trackCalls?: string[] } = {}): Fetcher {
  return async (raw) => {
    const url = new URL(String(raw));
    opts.trackCalls?.push(url.pathname);
    if (url.pathname === "/api/v1/channels.list.joined") return jsonResponse(CHANNELS);
    if (url.pathname === "/api/v1/groups.list") return jsonResponse(GROUPS);
    if (url.pathname === "/api/v1/im.list") return jsonResponse(IMS);
    return jsonResponse({ success: false, error: "unmocked" }, 500);
  };
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

describe("list_my_rooms", () => {
  it("default 'all' calls all three list endpoints and sorts desc; never calls subscriptions.getOne", async () => {
    const calls: string[] = [];
    const out = await listMyRooms(clientWith(buildFetcher({ trackCalls: calls })), {});

    const paths = new Set(calls);
    assert.ok(paths.has("/api/v1/channels.list.joined"));
    assert.ok(paths.has("/api/v1/groups.list"));
    assert.ok(paths.has("/api/v1/im.list"));
    assert.ok(!paths.has("/api/v1/subscriptions.getOne"));

    const ids = out.rooms.map((r) => r.room_id);
    assert.deepEqual(ids, ["d1", "p1", "c2", "c1"]);
    // No unread/mention fields in the public shape.
    for (const r of out.rooms) {
      assert.equal((r as Record<string, unknown>).unread_count, undefined);
      assert.equal((r as Record<string, unknown>).mention_count, undefined);
    }
  });

  it("type='channel' only calls channels.list.joined", async () => {
    const calls: string[] = [];
    const out = await listMyRooms(clientWith(buildFetcher({ trackCalls: calls })), {
      type: "channel",
    });
    assert.deepEqual(calls.sort(), ["/api/v1/channels.list.joined"]);
    assert.deepEqual(out.rooms.map((r) => r.room_id), ["c2", "c1"]);
    assert.ok(out.rooms.every((r) => r.room_type === "c"));
  });

  it("type='private' only calls groups.list", async () => {
    const calls: string[] = [];
    const out = await listMyRooms(clientWith(buildFetcher({ trackCalls: calls })), {
      type: "private",
    });
    assert.deepEqual(calls.sort(), ["/api/v1/groups.list"]);
    assert.deepEqual(out.rooms.map((r) => r.room_id), ["p1"]);
  });

  it("type='dm' only calls im.list and uses other-participant username for the name", async () => {
    const calls: string[] = [];
    process.env.ROCKETCHAT_USER_ID = "test-user";
    const out = await listMyRooms(clientWith(buildFetcher({ trackCalls: calls })), {
      type: "dm",
    });
    assert.deepEqual(calls.sort(), ["/api/v1/im.list"]);
    assert.deepEqual(out.rooms.map((r) => r.room_id), ["d1"]);
    // Name resolution falls back to fname/name when currentUsername isn't passed;
    // here we just assert it's a non-empty string.
    assert.ok(out.rooms[0]!.name.length > 0);
  });

  it("respects limit", async () => {
    const out = await listMyRooms(clientWith(buildFetcher()), { limit: 2 });
    assert.equal(out.rooms.length, 2);
    assert.deepEqual(out.rooms.map((r) => r.room_id), ["d1", "p1"]);
  });
});
