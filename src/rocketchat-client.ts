import { buildHeaders } from "./headers.js";

export type RoomType = "c" | "p" | "d";

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

interface RocketChatErrorBody {
  success?: boolean;
  error?: string;
  errorType?: string;
  message?: string;
}

export class RocketChatApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly errorType?: string,
    public readonly path?: string
  ) {
    super(message);
    this.name = "RocketChatApiError";
  }
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export class RocketChatClient {
  readonly baseUrl: string;
  private readonly debug: boolean;
  private readonly fetcher: Fetcher;
  private readonly roomTypeCache = new Map<string, RoomType>();

  constructor(baseUrl: string, opts: { debug?: boolean; fetcher?: Fetcher } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.debug = opts.debug ?? false;
    this.fetcher = opts.fetcher ?? ((input, init) => fetch(input, init));
  }

  buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: RequestOptions = {}
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const isPost = method === "POST";
    const headers = buildHeaders(isPost);
    const init: RequestInit = { method, headers };
    if (isPost && opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await this.fetcher(url, init);
    } catch (err) {
      const parts: string[] = [];
      if (err instanceof Error) parts.push(err.message);
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof Error) {
        const code = (cause as NodeJS.ErrnoException).code;
        parts.push(`cause: ${code ? `${code} — ` : ""}${cause.message}`);
      } else if (cause !== undefined) {
        parts.push(`cause: ${String(cause)}`);
      }
      throw new Error(
        `Network error calling ${method} ${url}: ${parts.join(" | ") || String(err)}`
      );
    }
    const durationMs = Date.now() - startedAt;

    if (this.debug) {
      console.error(`[rc] ${method} ${path} -> ${res.status} (${durationMs}ms)`);
    }

    if (res.status === 401) {
      throw new RocketChatApiError(
        "Rocket.Chat returned 401 Unauthorized. Check ROCKETCHAT_USER_ID and ROCKETCHAT_AUTH_TOKEN — the token may be revoked, expired, or paired with the wrong user id.",
        401,
        "unauthorized",
        path
      );
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      let body: RocketChatErrorBody | undefined;
      try {
        body = raw ? (JSON.parse(raw) as RocketChatErrorBody) : undefined;
      } catch {
        // non-JSON error body — keep raw for diagnostics
      }
      const jsonDetail = body?.error ?? body?.message;
      const rawDetail = raw && !body ? raw.slice(0, 200).replace(/\s+/g, " ").trim() : "";
      const detail = jsonDetail ?? (rawDetail ? `non-JSON body: ${rawDetail}` : res.statusText);
      throw new RocketChatApiError(
        `Rocket.Chat ${res.status} on ${method} ${url}: ${detail}`,
        res.status,
        body?.errorType,
        path
      );
    }

    return (await res.json()) as T;
  }

  async getRoomType(roomId: string): Promise<RoomType> {
    const cached = this.roomTypeCache.get(roomId);
    if (cached) return cached;

    const res = await this.request<{ room?: { t?: string }; success?: boolean }>(
      "GET",
      "/api/v1/rooms.info",
      { query: { roomId } }
    );
    const t = res.room?.t;
    if (t !== "c" && t !== "p" && t !== "d") {
      throw new RocketChatApiError(
        `rooms.info returned unsupported room type ${JSON.stringify(t)} for ${roomId}`,
        500,
        "unsupported_room_type",
        "/api/v1/rooms.info"
      );
    }
    this.roomTypeCache.set(roomId, t);
    return t;
  }

  /** Test-only: prime the cache without an HTTP call. */
  primeRoomType(roomId: string, type: RoomType): void {
    this.roomTypeCache.set(roomId, type);
  }

  async selfTest(): Promise<{ username: string; userId: string }> {
    const me = await this.request<{
      _id: string;
      username: string;
      success?: boolean;
    }>("GET", "/api/v1/me");
    if (!me.username || !me._id) {
      throw new Error("GET /api/v1/me returned an unexpected payload (missing username or _id).");
    }
    return { username: me.username, userId: me._id };
  }
}
