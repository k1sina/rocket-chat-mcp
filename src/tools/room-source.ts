import type { RocketChatClient, RoomType } from "../rocketchat-client.js";
import { RocketChatApiError } from "../rocketchat-client.js";

// The room list is assembled from the three per-type endpoints.
//
// Unread/mention data comes from subscriptions.get — ONE call returning every
// subscription for the authenticated user. An earlier version of this file
// claimed the endpoint did not exist and fanned out subscriptions.getOne per
// room instead; the endpoint it looked for was subscriptions.getAll, which is
// not what Rocket.Chat calls it. On a 59-room account the fan-out took ~17s
// against ~0.26s for the bulk call. The fan-out is kept as a fallback for
// instances that really do refuse the bulk endpoint.

const PAGE_SIZE = 100;

export interface RoomMetadata {
  rid: string;
  t: RoomType;
  name: string;
  fname?: string;
  lastMessage?: { msg?: string; ts?: string };
  lm?: string;
  _updatedAt?: string;
}

interface ChannelDoc {
  _id: string;
  name?: string;
  fname?: string;
  t?: string;
  lastMessage?: { msg?: string; ts?: string };
  lm?: string;
  _updatedAt?: string;
  usernames?: string[];
}

interface ListResponse {
  channels?: ChannelDoc[];
  groups?: ChannelDoc[];
  ims?: ChannelDoc[];
  total?: number;
  offset?: number;
  count?: number;
  success?: boolean;
}

function pickName(doc: ChannelDoc, t: RoomType, currentUsername?: string): string {
  if (t === "d") {
    // DMs: prefer the *other* participant's username, fall back to fname/name.
    if (doc.usernames && currentUsername) {
      const other = doc.usernames.find((u) => u !== currentUsername);
      if (other) return other;
    }
    if (doc.usernames && doc.usernames.length === 1) return doc.usernames[0]!;
    return doc.fname || doc.name || "(direct message)";
  }
  return doc.name || doc.fname || "(unnamed)";
}

function isRoomType(t: string | undefined): t is RoomType {
  return t === "c" || t === "p" || t === "d";
}

async function fetchAllPages(
  client: RocketChatClient,
  path: string,
  arrayKey: "channels" | "groups" | "ims"
): Promise<ChannelDoc[]> {
  const out: ChannelDoc[] = [];
  let offset = 0;
  while (true) {
    const res = await client.request<ListResponse>("GET", path, {
      query: { count: PAGE_SIZE, offset },
    });
    const page = (res[arrayKey] ?? []) as ChannelDoc[];
    out.push(...page);
    const total = res.total ?? out.length;
    if (page.length === 0 || out.length >= total || page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (offset > 5000) break; // safety stop
  }
  return out;
}

export async function fetchAllRooms(
  client: RocketChatClient,
  opts: { types?: RoomType[]; currentUsername?: string } = {}
): Promise<RoomMetadata[]> {
  const wanted = new Set<RoomType>(opts.types ?? ["c", "p", "d"]);
  const tasks: Promise<{ docs: ChannelDoc[]; t: RoomType }>[] = [];

  if (wanted.has("c")) {
    tasks.push(
      fetchAllPages(client, "/api/v1/channels.list.joined", "channels").then((docs) => ({
        docs,
        t: "c" as const,
      }))
    );
  }
  if (wanted.has("p")) {
    tasks.push(
      fetchAllPages(client, "/api/v1/groups.list", "groups").then((docs) => ({
        docs,
        t: "p" as const,
      }))
    );
  }
  if (wanted.has("d")) {
    tasks.push(
      fetchAllPages(client, "/api/v1/im.list", "ims").then((docs) => ({
        docs,
        t: "d" as const,
      }))
    );
  }

  const groups = await Promise.all(tasks);
  const rooms: RoomMetadata[] = [];
  for (const { docs, t } of groups) {
    for (const doc of docs) {
      const docType = isRoomType(doc.t) ? doc.t : t;
      rooms.push({
        rid: doc._id,
        t: docType,
        name: pickName(doc, docType, opts.currentUsername),
        fname: doc.fname,
        lastMessage: doc.lastMessage,
        lm: doc.lm,
        _updatedAt: doc._updatedAt,
      });
      // Prime the room-type cache so get_room_history doesn't need rooms.info.
      client.primeRoomType(doc._id, docType);
    }
  }
  return rooms;
}

export interface SubscriptionData {
  unread: number;
  userMentions: number;
  groupMentions: number;
  alert: boolean;
  ls?: string;
}

interface SubscriptionDoc {
  rid?: string;
  unread?: number;
  userMentions?: number;
  groupMentions?: number;
  alert?: boolean;
  ls?: string;
}

interface SubscriptionResponse {
  subscription?: SubscriptionDoc;
}

interface SubscriptionsGetResponse {
  update?: SubscriptionDoc[];
  remove?: SubscriptionDoc[];
}

function toSubscriptionData(sub: SubscriptionDoc): SubscriptionData {
  return {
    unread: sub.unread ?? 0,
    userMentions: sub.userMentions ?? 0,
    groupMentions: sub.groupMentions ?? 0,
    alert: sub.alert ?? false,
    ls: sub.ls,
  };
}

/**
 * Every subscription for the authenticated user, in one request.
 *
 * Returns null — never throws — when the instance does not answer, so the
 * caller falls back to the per-room fan-out. A missing bulk endpoint is a
 * reason to take the slow path, not to report "no unread" when there is.
 */
async function fetchAllSubscriptions(
  client: RocketChatClient
): Promise<Map<string, SubscriptionData> | null> {
  try {
    const res = await client.request<SubscriptionsGetResponse>(
      "GET",
      "/api/v1/subscriptions.get"
    );
    const docs = res.update;
    // An instance that answers 200 with no `update` array is not one we can
    // read subscriptions from; treat it as unsupported rather than as "the
    // user has no subscriptions", which would silently blank every unread.
    if (!Array.isArray(docs)) return null;

    const map = new Map<string, SubscriptionData>();
    for (const doc of docs) {
      if (typeof doc.rid !== "string") continue;
      map.set(doc.rid, toSubscriptionData(doc));
    }
    return map;
  } catch (err) {
    if (err instanceof Error) {
      console.error(`[rc] subscriptions.get unavailable, falling back to per-room: ${err.message}`);
    }
    return null;
  }
}

// Short-lived cache over whichever path ran.
//
// It matters most on the fallback: Rocket.Chat rate-limits subscriptions.getOne
// at roughly 50 req / 60s on some instances, so with 50+ rooms one fan-out can
// blow the budget and every call for the next minute comes back 429 — reporting
// "no unread" when there is. On the bulk path it is only saving a ~0.26s call,
// which is why the TTL below is short enough that a caller polling on its own
// schedule still sees new messages promptly.
let subscriptionMapCache: {
  fetchedAt: number;
  roomIds: string;
  map: Map<string, SubscriptionData>;
} | null = null;
const SUBSCRIPTION_CACHE_TTL_MS = 60_000;

export function clearSubscriptionMapCache(): void {
  subscriptionMapCache = null;
}

function parseRetryAfterSec(message: string): number | null {
  const m = message.match(/wait (\d+) seconds?/i);
  return m ? Number(m[1]) : null;
}

async function fetchOneSubscription(
  client: RocketChatClient,
  rid: string
): Promise<SubscriptionData | null> {
  const maxWaitMs = 5_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await client.request<SubscriptionResponse>(
        "GET",
        "/api/v1/subscriptions.getOne",
        { query: { roomId: rid } }
      );
      const sub = res.subscription;
      if (!sub) return null;
      return toSubscriptionData(sub);
    } catch (err) {
      if (err instanceof RocketChatApiError && err.status === 404) {
        return null;
      }
      if (
        err instanceof RocketChatApiError &&
        err.status === 429 &&
        attempt === 0
      ) {
        const askedSec = parseRetryAfterSec(err.message) ?? 2;
        const waitMs = Math.min(maxWaitMs, askedSec * 1000);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (err instanceof Error) {
        console.error(`[rc] subscriptions.getOne failed for ${rid}: ${err.message}`);
      }
      return null;
    }
  }
  return null;
}

export async function fetchSubscriptionMap(
  client: RocketChatClient,
  roomIds: string[],
  opts: { concurrency?: number; useCache?: boolean } = {}
): Promise<Map<string, SubscriptionData>> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const useCache = opts.useCache ?? true;
  const cacheKey = [...roomIds].sort().join(",");

  if (useCache && subscriptionMapCache) {
    const fresh = Date.now() - subscriptionMapCache.fetchedAt < SUBSCRIPTION_CACHE_TTL_MS;
    if (fresh && subscriptionMapCache.roomIds === cacheKey) {
      return subscriptionMapCache.map;
    }
  }

  const out = new Map<string, SubscriptionData>();

  // One request for the whole account. Filtered down to the rooms asked for,
  // so the cached map matches the cache key above and the fallback below
  // returns the same shape.
  const bulk = await fetchAllSubscriptions(client);
  if (bulk) {
    for (const rid of roomIds) {
      const sub = bulk.get(rid);
      if (sub) out.set(rid, sub);
    }
  } else {
    let i = 0;
    async function worker(): Promise<void> {
      while (true) {
        const idx = i++;
        if (idx >= roomIds.length) return;
        const rid = roomIds[idx]!;
        const sub = await fetchOneSubscription(client, rid);
        if (sub) out.set(rid, sub);
      }
    }
    const workerCount = Math.min(concurrency, roomIds.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  if (useCache) {
    subscriptionMapCache = { fetchedAt: Date.now(), roomIds: cacheKey, map: out };
  }
  return out;
}

export interface RoomRow {
  room_id: string;
  room_type: RoomType;
  name: string;
  unread_count: number;
  mention_count: number;
  manually_marked_unread: boolean;
  last_message_at: string | null;
  last_message_preview: string;
}

function previewOf(msg: string | undefined): string {
  if (!msg) return "";
  const trimmed = msg.replace(/\s+/g, " ").trim();
  return trimmed.length > 200 ? trimmed.slice(0, 197) + "..." : trimmed;
}

export function buildRow(
  room: RoomMetadata,
  sub?: SubscriptionData
): RoomRow {
  const lastTs = room.lastMessage?.ts ?? room.lm ?? room._updatedAt ?? null;
  const unread = sub?.unread ?? 0;
  const alert = sub?.alert ?? false;
  return {
    room_id: room.rid,
    room_type: room.t,
    name: room.name,
    unread_count: unread,
    mention_count: sub?.userMentions ?? 0,
    manually_marked_unread: alert && unread === 0,
    last_message_at: lastTs,
    last_message_preview: previewOf(room.lastMessage?.msg),
  };
}

export function sortByLastMessageDesc<T extends { last_message_at: string | null }>(
  rows: T[]
): T[] {
  return [...rows].sort((a, b) => {
    const av = a.last_message_at ? Date.parse(a.last_message_at) : 0;
    const bv = b.last_message_at ? Date.parse(b.last_message_at) : 0;
    return bv - av;
  });
}
