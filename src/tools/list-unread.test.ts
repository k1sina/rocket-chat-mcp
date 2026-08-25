import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RocketChatClient, type Fetcher } from "../rocketchat-client.js";
import { listUnread } from "./list-unread.js";
import { clearSubscriptionMapCache } from "./room-source.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CHANNELS = {
  channels: [
    {
      _id: "c-noise",
      t: "c",
      name: "general",
      lm: "2026-04-29T08:00:00.000Z",
      lastMessage: { msg: "boring", ts: "2026-04-29T08:00:00.000Z" },
    },
    {
      _id: "c-mention",
      t: "c",
      name: "release-train",
      lm: "2026-04-29T07:30:00.000Z",
      lastMessage: { msg: "@sina please review", ts: "2026-04-29T07:30:00.000Z" },
    },
  ],
  total: 2,
  success: true,
};
const GROUPS = {
  groups: [
    {
      _id: "p-unread",
      t: "p",
      name: "secret-project",
      lm: "2026-04-29T09:00:00.000Z",
      lastMessage: { msg: "design doc draft", ts: "2026-04-29T09:00:00.000Z" },
    },
  ],
  total: 1,
  success: true,
};
const IMS = {
  ims: [
    {
      _id: "d-mention",
      t: "d",
      usernames: ["sina", "lukas"],
      lm: "2026-04-29T10:00:00.000Z",
      lastMessage: { msg: "hey @sina got a sec?", ts: "2026-04-29T10:00:00.000Z" },
    },
  ],
  total: 1,
  success: true,
};

interface SubFixture {
  unread: number;
  userMentions: number;
  alert?: boolean;
}
const SUBS: Record<string, SubFixture> = {
  "c-noise": { unread: 0, userMentions: 0 },
  "c-mention": { unread: 0, userMentions: 2, alert: true },
  "p-unread": { unread: 5, userMentions: 0, alert: true },
  "d-mention": { unread: 1, userMentions: 1, alert: true },
};

function buildFetcher(opts: { trackCalls?: string[] } = {}): Fetcher {
  return async (raw, _init) => {
    const url = new URL(String(raw));
    opts.trackCalls?.push(url.pathname + url.search);
    if (url.pathname === "/api/v1/channels.list.joined") return jsonResponse(CHANNELS);
    if (url.pathname === "/api/v1/groups.list") return jsonResponse(GROUPS);
    if (url.pathname === "/api/v1/im.list") return jsonResponse(IMS);
    if (url.pathname === "/api/v1/subscriptions.getOne") {
      const rid = url.searchParams.get("roomId") ?? "";
      const sub = SUBS[rid];
      if (!sub) return jsonResponse({ success: false, error: "not found" }, 404);
      return jsonResponse({
        subscription: {
          rid,
          unread: sub.unread,
          userMentions: sub.userMentions,
          alert: sub.alert ?? false,
          t: "c",
        },
        success: true,
      });
    }
    return jsonResponse({ success: false, error: "no mock for " + url.pathname }, 500);
  };
}

let originalEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  process.env.ROCKETCHAT_USER_ID = "test-user";
  process.env.ROCKETCHAT_AUTH_TOKEN = "test-token";
  clearSubscriptionMapCache();
});
afterEach(() => {
  process.env = originalEnv;
  clearSubscriptionMapCache();
});

function clientWith(fetcher: Fetcher): RocketChatClient {
  return new RocketChatClient("https://chat.example.com", { fetcher });
}

describe("list_unread", () => {
  it("fans out across channels.list.joined + groups.list + im.list, then subscriptions.getOne per room", async () => {
    const calls: string[] = [];
    const out = await listUnread(clientWith(buildFetcher({ trackCalls: calls })), {});

    const paths = new Set(calls.map((c) => c.split("?")[0]));
    assert.ok(paths.has("/api/v1/channels.list.joined"));
    assert.ok(paths.has("/api/v1/groups.list"));
    assert.ok(paths.has("/api/v1/im.list"));
    assert.ok(paths.has("/api/v1/subscriptions.getOne"));

    // 4 rooms total -> 4 subscription lookups.
    const subCalls = calls.filter((c) => c.startsWith("/api/v1/subscriptions.getOne"));
    assert.equal(subCalls.length, 4);
  });

  it("returns only rooms with unread > 0 OR userMentions > 0, sorted desc", async () => {
    const out = await listUnread(clientWith(buildFetcher()), {});
    const ids = out.rooms.map((r) => r.room_id);
    // c-noise has unread=0/mentions=0 -> filtered. The rest sort by lastMessage.ts desc:
    // d-mention 10:00, p-unread 09:00, c-mention 07:30
    assert.deepEqual(ids, ["d-mention", "p-unread", "c-mention"]);
    const dRow = out.rooms.find((r) => r.room_id === "d-mention")!;
    assert.equal(dRow.room_type, "d");
    // DM display name should resolve to the *other* participant when current_username is unknown:
    // we don't pass currentUsername to the listUnread path; pickName falls back to fname/name/usernames-default.
    assert.ok(typeof dRow.name === "string" && dRow.name.length > 0);
    assert.equal(dRow.unread_count, 1);
    assert.equal(dRow.mention_count, 1);
  });

  it("includes rooms with alert=true even when unread=0 (manually marked unread); flags them", async () => {
    const fetcher: Fetcher = async (raw) => {
      const url = new URL(String(raw));
      if (url.pathname === "/api/v1/channels.list.joined")
        return jsonResponse({
          channels: [
            {
              _id: "c-marked",
              t: "c",
              name: "marked-channel",
              lm: "2026-04-29T05:00:00.000Z",
              lastMessage: { msg: "old msg", ts: "2026-04-29T05:00:00.000Z" },
            },
          ],
          total: 1,
          success: true,
        });
      if (url.pathname === "/api/v1/groups.list") return jsonResponse({ groups: [], total: 0, success: true });
      if (url.pathname === "/api/v1/im.list") return jsonResponse({ ims: [], total: 0, success: true });
      if (url.pathname === "/api/v1/subscriptions.getOne") {
        return jsonResponse({
          subscription: { rid: "c-marked", unread: 0, userMentions: 0, alert: true, t: "c" },
          success: true,
        });
      }
      return jsonResponse({}, 500);
    };
    const out = await listUnread(clientWith(fetcher), {});
    assert.equal(out.rooms.length, 1);
    assert.equal(out.rooms[0]!.room_id, "c-marked");
    assert.equal(out.rooms[0]!.unread_count, 0);
    assert.equal(out.rooms[0]!.manually_marked_unread, true);
  });

  it("with mentions_only=true keeps only userMentions > 0", async () => {
    const out = await listUnread(clientWith(buildFetcher()), { mentions_only: true });
    const ids = out.rooms.map((r) => r.room_id).sort();
    assert.deepEqual(ids, ["c-mention", "d-mention"]);
  });

  it("does not crash if a single subscriptions.getOne returns 404", async () => {
    let pHit = 0;
    const fetcher: Fetcher = async (raw) => {
      const url = new URL(String(raw));
      if (url.pathname === "/api/v1/channels.list.joined") return jsonResponse(CHANNELS);
      if (url.pathname === "/api/v1/groups.list") return jsonResponse(GROUPS);
      if (url.pathname === "/api/v1/im.list") return jsonResponse(IMS);
      if (url.pathname === "/api/v1/subscriptions.getOne") {
        const rid = url.searchParams.get("roomId") ?? "";
        if (rid === "p-unread") {
          pHit++;
          return jsonResponse({ success: false, error: "not found" }, 404);
        }
        const sub = SUBS[rid]!;
        return jsonResponse({
          subscription: { rid, unread: sub.unread, userMentions: sub.userMentions, t: "c" },
          success: true,
        });
      }
      return jsonResponse({ success: false }, 500);
    };
    const out = await listUnread(clientWith(fetcher), {});
    assert.equal(pHit, 1);
    // p-unread has no subscription data after the 404; treated as unread=0 -> filtered out.
    const ids = out.rooms.map((r) => r.room_id).sort();
    assert.deepEqual(ids, ["c-mention", "d-mention"]);
  });

  it("retries once on 429 and succeeds when the second attempt returns 200", async () => {
    const callsByRoom: Record<string, number> = {};
    const fetcher: Fetcher = async (raw) => {
      const url = new URL(String(raw));
      if (url.pathname === "/api/v1/channels.list.joined")
        return jsonResponse({
          channels: [{ _id: "c-rate", t: "c", name: "rate-room", lm: "2026-04-29T05:00:00.000Z" }],
          total: 1,
          success: true,
        });
      if (url.pathname === "/api/v1/groups.list") return jsonResponse({ groups: [], total: 0, success: true });
      if (url.pathname === "/api/v1/im.list") return jsonResponse({ ims: [], total: 0, success: true });
      if (url.pathname === "/api/v1/subscriptions.getOne") {
        const rid = url.searchParams.get("roomId") ?? "";
        callsByRoom[rid] = (callsByRoom[rid] ?? 0) + 1;
        if (callsByRoom[rid] === 1) {
          return jsonResponse(
            {
              status: "error",
              message:
                "Error, too many requests. Please slow down. You must wait 1 seconds before trying this endpoint again.",
              error: "Error, too many requests. You must wait 1 seconds.",
              errorType: "error-too-many-requests",
            },
            429
          );
        }
        return jsonResponse({
          subscription: { rid, unread: 3, userMentions: 0, alert: true, t: "c" },
          success: true,
        });
      }
      return jsonResponse({}, 500);
    };
    const out = await listUnread(clientWith(fetcher), {});
    assert.equal(callsByRoom["c-rate"], 2, "should have retried once after 429");
    assert.equal(out.rooms.length, 1);
    assert.equal(out.rooms[0]!.unread_count, 3);
  });

  it("caches the subscription map across calls so a second list_unread makes zero subscription requests", async () => {
    let subCalls = 0;
    const fetcher: Fetcher = async (raw) => {
      const url = new URL(String(raw));
      if (url.pathname === "/api/v1/channels.list.joined") return jsonResponse(CHANNELS);
      if (url.pathname === "/api/v1/groups.list") return jsonResponse(GROUPS);
      if (url.pathname === "/api/v1/im.list") return jsonResponse(IMS);
      if (url.pathname === "/api/v1/subscriptions.getOne") {
        subCalls++;
        const rid = url.searchParams.get("roomId") ?? "";
        const sub = SUBS[rid];
        if (!sub) return jsonResponse({ success: false, error: "not found" }, 404);
        return jsonResponse({
          subscription: {
            rid,
            unread: sub.unread,
            userMentions: sub.userMentions,
            alert: sub.alert ?? false,
            t: "c",
          },
          success: true,
        });
      }
      return jsonResponse({}, 500);
    };
    const client = clientWith(fetcher);
    const first = await listUnread(client, {});
    const firstCallCount = subCalls;
    const second = await listUnread(client, {});
    assert.equal(subCalls, firstCallCount, "second call must hit the cache, not the API");
    assert.deepEqual(second.rooms.map((r) => r.room_id), first.rooms.map((r) => r.room_id));
  });

  it("sends auth headers and surfaces 401 with explicit env-var hint", async () => {
    let captured: Record<string, string> = {};
    const fetcher: Fetcher = async (raw, init) => {
      captured = (init?.headers ?? {}) as Record<string, string>;
      const url = new URL(String(raw));
      if (url.pathname === "/api/v1/channels.list.joined") {
        return jsonResponse({ status: "error", message: "Unauthorized" }, 401);
      }
      return jsonResponse({}, 200);
    };
    await assert.rejects(
      () => listUnread(clientWith(fetcher), {}),
      (err: Error) =>
        /ROCKETCHAT_USER_ID/.test(err.message) && /ROCKETCHAT_AUTH_TOKEN/.test(err.message)
    );
    assert.equal(captured["X-User-Id"], "test-user");
    assert.equal(captured["X-Auth-Token"], "test-token");
  });
});

/**
 * The bulk path. Every test above mocks only subscriptions.getOne, so they
 * exercise the fallback — which is exactly what should still happen on an
 * instance without the bulk endpoint. These cover the fast path.
 */
describe("list_unread — bulk subscriptions.get", () => {
  /** Same fixtures as the fan-out tests, served from one endpoint. */
  function bulkFetcher(opts: { trackCalls?: string[] } = {}): Fetcher {
    return async (raw) => {
      const url = new URL(String(raw));
      opts.trackCalls?.push(url.pathname);
      if (url.pathname === "/api/v1/channels.list.joined") return jsonResponse(CHANNELS);
      if (url.pathname === "/api/v1/groups.list") return jsonResponse(GROUPS);
      if (url.pathname === "/api/v1/im.list") return jsonResponse(IMS);
      if (url.pathname === "/api/v1/subscriptions.get") {
        return jsonResponse({
          update: Object.entries(SUBS).map(([rid, sub]) => ({
            rid,
            unread: sub.unread,
            userMentions: sub.userMentions,
            alert: sub.alert ?? false,
          })),
          remove: [],
          success: true,
        });
      }
      return jsonResponse({ success: false, error: "no mock for " + url.pathname }, 500);
    };
  }

  it("reads every subscription in one call and never touches subscriptions.getOne", async () => {
    const calls: string[] = [];
    const out = await listUnread(clientWith(bulkFetcher({ trackCalls: calls })), {});

    assert.equal(
      calls.filter((c) => c === "/api/v1/subscriptions.get").length,
      1,
      "exactly one bulk call"
    );
    assert.equal(
      calls.filter((c) => c === "/api/v1/subscriptions.getOne").length,
      0,
      "the per-room fan-out must not run when the bulk call succeeds"
    );
    // Identical result to the fan-out: c-noise filtered, rest by lastMessage desc.
    assert.deepEqual(
      out.rooms.map((r) => r.room_id),
      ["d-mention", "p-unread", "c-mention"]
    );
  });

  it("falls back to the per-room fan-out when the bulk endpoint 404s", async () => {
    const calls: string[] = [];
    const base = buildFetcher({ trackCalls: calls });
    const fetcher: Fetcher = async (raw, init) => {
      const url = new URL(String(raw));
      if (url.pathname === "/api/v1/subscriptions.get") {
        calls.push(url.pathname);
        return jsonResponse({ success: false, error: "unknown endpoint" }, 404);
      }
      return base(raw, init);
    };

    const out = await listUnread(clientWith(fetcher), {});
    assert.ok(calls.includes("/api/v1/subscriptions.get"), "bulk is tried first");
    assert.equal(
      calls.filter((c) => c.startsWith("/api/v1/subscriptions.getOne")).length,
      4,
      "all four rooms fall back to getOne"
    );
    assert.deepEqual(
      out.rooms.map((r) => r.room_id),
      ["d-mention", "p-unread", "c-mention"]
    );
  });

  it("falls back rather than reporting no unread when the bulk call answers 200 with no update array", async () => {
    const calls: string[] = [];
    const base = buildFetcher({ trackCalls: calls });
    const fetcher: Fetcher = async (raw, init) => {
      const url = new URL(String(raw));
      if (url.pathname === "/api/v1/subscriptions.get") {
        calls.push(url.pathname);
        return jsonResponse({ success: true });
      }
      return base(raw, init);
    };

    const out = await listUnread(clientWith(fetcher), {});
    // The dangerous failure this guards: an empty map read as "nothing unread".
    assert.equal(out.rooms.length, 3);
    assert.equal(
      calls.filter((c) => c.startsWith("/api/v1/subscriptions.getOne")).length,
      4
    );
  });

  it("ignores subscriptions for rooms that are not in the room list", async () => {
    const fetcher: Fetcher = async (raw) => {
      const url = new URL(String(raw));
      if (url.pathname === "/api/v1/channels.list.joined") return jsonResponse(CHANNELS);
      if (url.pathname === "/api/v1/groups.list") return jsonResponse({ groups: [], total: 0, success: true });
      if (url.pathname === "/api/v1/im.list") return jsonResponse({ ims: [], total: 0, success: true });
      if (url.pathname === "/api/v1/subscriptions.get") {
        return jsonResponse({
          update: [
            { rid: "c-mention", unread: 0, userMentions: 2, alert: true },
            // A room the user is subscribed to but which no list endpoint
            // returned — it must not appear as a phantom row.
            { rid: "ghost-room", unread: 9, userMentions: 9, alert: true },
          ],
          success: true,
        });
      }
      return jsonResponse({}, 500);
    };
    const out = await listUnread(clientWith(fetcher), {});
    assert.deepEqual(out.rooms.map((r) => r.room_id), ["c-mention"]);
  });
});
