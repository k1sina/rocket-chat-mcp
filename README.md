# rocket-chat-mcp

[![npm version](https://img.shields.io/npm/v/rocket-chat-mcp.svg)](https://www.npmjs.com/package/rocket-chat-mcp)
[![license](https://img.shields.io/npm/l/rocket-chat-mcp.svg)](LICENSE)
[![node](https://img.shields.io/node/v/rocket-chat-mcp.svg)](https://nodejs.org)

MCP server for self-hosted [Rocket.Chat](https://rocket.chat). Connects to any instance via env-var configuration; no hostname is hard-coded. Six tools — five read, one write — exposed over stdio for [Claude Code](https://docs.claude.com/en/docs/claude-code), [Claude Desktop](https://claude.ai/download), [MCP Inspector](https://github.com/modelcontextprotocol/inspector), or any MCP-aware client.

- **Read tools**: `list_unread`, `list_my_rooms`, `get_room_history`, `search_messages`, `get_user`
- **Write tool**: `post_message`
- **Auth**: Personal Access Token (`X-User-Id` + `X-Auth-Token` headers)
- **Transport**: stdio
- **Runtime**: Node.js 20+, zero non-JS dependencies

## Requirements

- Node.js **20.0+** (uses native `fetch`)
- A Rocket.Chat user account with a Personal Access Token

## Setup

### 1. Create a Personal Access Token in Rocket.Chat

1. Open Rocket.Chat in your browser.
2. Go to **My Account → Personal Access Tokens**.
3. Enter a name (e.g. `mcp-server`).
4. **Check "Ignore Two Factor Authentication"** before clicking *Add*. Without this, every API call fails with a `totp-required` error.
5. After clicking *Add*, Rocket.Chat shows two values:
   - `Token` — this is your `ROCKETCHAT_AUTH_TOKEN`
   - `User Id` — this is your `ROCKETCHAT_USER_ID`

   Copy both immediately. The token is shown only once.

### 2. Install

**From npm (recommended):**

```sh
npm install -g rocket-chat-mcp
```

This puts a `rocket-chat-mcp` binary on your PATH. You can also run it ad-hoc with `npx rocket-chat-mcp` (no install).

**From source:**

```sh
git clone https://github.com/k1sina/rocket-chat-mcp.git
cd rocket-chat-mcp
npm install
npm run build
```

### 3. Configure environment

Copy `.env.example` to `.env` and fill in:

```sh
ROCKETCHAT_URL=https://chat.example.com   # base URL, no trailing slash, no /api/v1
ROCKETCHAT_USER_ID=...
ROCKETCHAT_AUTH_TOKEN=...
# DEBUG=1                                  # optional: log API metadata to stderr
```

The server validates these on launch and refuses to start if anything is missing or malformed (URL with trailing `/`, URL containing `/api/v1`, missing token, etc.). On a successful start it calls `GET /api/v1/me` and logs `Connected as @<username>` to stderr.

## Run

### Claude Code (CLI)

Register the server with one command:

```sh
claude mcp add rocket-chat \
  -e ROCKETCHAT_URL=https://chat.example.com \
  -e ROCKETCHAT_USER_ID=... \
  -e ROCKETCHAT_AUTH_TOKEN=... \
  -- npx -y rocket-chat-mcp
```

Add `-s user` to make the server available across all projects (default is project-local). Verify with `claude mcp list`, then restart your Claude Code session so the tools load.

If you installed from source instead of npm, replace the `-- npx -y rocket-chat-mcp` part with an absolute path to your built binary:

```sh
  -- /absolute/path/to/node /absolute/path/to/rocket-chat-mcp/dist/index.js
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on your platform:

```json
{
  "mcpServers": {
    "rocket-chat": {
      "command": "npx",
      "args": ["-y", "rocket-chat-mcp"],
      "env": {
        "ROCKETCHAT_URL": "https://chat.example.com",
        "ROCKETCHAT_USER_ID": "...",
        "ROCKETCHAT_AUTH_TOKEN": "..."
      }
    }
  }
}
```

If you installed from source, point `command` at an absolute Node 20+ binary and `args` at `dist/index.js`. Claude Desktop does not source nvm, so something like `/Users/you/.nvm/versions/node/v20.19.5/bin/node` is typical. Restart Claude Desktop after editing the config.

### MCP Inspector (ad-hoc testing)

```sh
ROCKETCHAT_URL=https://chat.example.com \
ROCKETCHAT_USER_ID=... \
ROCKETCHAT_AUTH_TOKEN=... \
DEBUG=1 \
npx @modelcontextprotocol/inspector npx -y rocket-chat-mcp
```

Opens a browser UI where you can invoke each tool with arbitrary arguments.

### Direct stdio

```sh
ROCKETCHAT_URL=... ROCKETCHAT_USER_ID=... ROCKETCHAT_AUTH_TOKEN=... npx -y rocket-chat-mcp
```

## Tools

All tools take JSON input and return JSON output (wrapped in MCP `content[type=text]` blocks). Room IDs are opaque strings — never invent them; always look them up via `list_my_rooms` or `list_unread`.

### `list_unread`

Rooms with unread messages, mentions, or that you've manually marked unread. Use this for **"what needs my attention right now."**

| Param | Type | Default | Description |
|---|---|---|---|
| `mentions_only` | `boolean` | `false` | If `true`, only return rooms where you have unread `@`-mentions. |

**Output:**

```ts
{
  rooms: Array<{
    room_id: string;
    room_type: "c" | "p" | "d";   // channel / private group / DM
    name: string;
    unread_count: number;
    mention_count: number;
    manually_marked_unread: boolean; // true when you marked the room unread but no new messages
    last_message_at: string | null;  // ISO 8601
    last_message_preview: string;
  }>;
}
```

Sorted by `last_message_at` desc.

**Endpoints called:** `channels.list.joined`, `groups.list`, `im.list`, then `subscriptions.get` once for the whole account (falling back to `subscriptions.getOne` per room — see [Architecture](#architecture)).

### `list_my_rooms`

All rooms you're subscribed to. Use this to **look up a `room_id` by name**.

| Param | Type | Default | Description |
|---|---|---|---|
| `type` | `"channel" \| "private" \| "dm" \| "all"` | `"all"` | Filter by room type. |
| `limit` | `integer 1..500` | `100` | Maximum number of rooms to return. |

**Output:** same shape as `list_unread` but **without** `unread_count` / `mention_count` (it reads no subscription data at all). Sorted by `last_message_at` desc.

**Endpoints called:** `channels.list.joined`, `groups.list`, `im.list`.

### `get_room_history`

Recent messages in a room. Pass any `room_id`; type (channel / private / DM) is detected and cached for the session.

| Param | Type | Default | Description |
|---|---|---|---|
| `room_id` | `string` | required | From `list_my_rooms` / `list_unread` / `get_user`. |
| `limit` | `integer 1..200` | `50` | Maximum number of messages. |
| `before` | `string` (ISO 8601) | — | For pagination — pass the `ts` of the oldest message from the previous page. |

**Output:**

```ts
{
  room_id: string;
  room_type: "c" | "p" | "d";
  messages: Array<{
    id: string;
    ts: string | null;          // ISO 8601
    user: { id: string; username: string; name: string };
    msg: string;
    edited_at: string | null;
    attachments_count: number;
    reactions: Record<string, number>; // emoji -> count
    is_thread: boolean;
    thread_count: number;
  }>;
}
```

Messages are returned newest-first.

**Endpoints called:** `channels.history` / `groups.history` / `im.history` (auto-selected by room type), and `rooms.info` once per session per room to determine the type.

### `search_messages`

Full-text search **within a single room**. Requires a `room_id` — there is no global search.

| Param | Type | Default | Description |
|---|---|---|---|
| `room_id` | `string` | required | From `list_my_rooms` / `list_unread`. |
| `query` | `string` | required | Free-text search string. |
| `limit` | `integer 1..200` | `30` | Maximum number of results. |

**Output:** `{ room_id, query, messages }` where `messages` has the same shape as `get_room_history`.

**Endpoint called:** `chat.search`.

### `get_user`

Look up a Rocket.Chat user by username. Useful for resolving `@someone` to their full name, role, or status before posting.

| Param | Type | Default | Description |
|---|---|---|---|
| `username` | `string` | required | Username to look up. The leading `@` is optional. |

**Output:**

```ts
{
  id: string;
  username: string;
  name: string;
  status: string;             // "online", "offline", "away", "busy", "unknown"
  status_text: string | null;
  email: string | null;       // only when visible to you
  active: boolean;
  roles: string[];
}
```

**Endpoint called:** `users.info`.

### `post_message`

**WRITES TO ROCKET.CHAT.** Posts a new message. Do not call without explicit user intent.

> ⚠️ **Rocket.Chat does not deduplicate messages.** If a call appears to fail, the message may still have been delivered, and retrying could post it twice. If unsure, use `get_room_history` immediately afterwards to verify before retrying.

| Param | Type | Default | Description |
|---|---|---|---|
| `room_id` | `string` | required | From `list_my_rooms` / `list_unread` / `get_user`. |
| `text` | `string` (non-whitespace) | required | Message body. |
| `thread_id` | `string` | — | If set, post as a reply in this thread. Pass the parent message's `id`. |

**Output:**

```ts
{
  posted: true;
  message_id: string;
  room_id: string;
  thread_id: string | null;
  ts: string | null;
}
```

Every call also writes a `[WRITE] chat.postMessage {...}` line to stderr regardless of `DEBUG`, as a cheap audit trail.

**Endpoint called:** `chat.postMessage`.

## Architecture

- **Auth.** Every request carries `X-User-Id` and `X-Auth-Token` headers, read from env vars at request time. No token is ever logged or echoed in error messages.
- **Transport.** stdio (`@modelcontextprotocol/sdk`'s `StdioServerTransport`). The server name is `rocket-chat-mcp`, version mirrors `package.json`.
- **Self-test on startup.** On launch the server calls `GET /api/v1/me` and prints `Connected as @<username>` to stderr, or exits non-zero with a diagnostic if it can't.
- **Room-type cache.** Per-session, in-memory map of `room_id → "c"|"p"|"d"`. Primed by `list_my_rooms` / `list_unread`, so subsequent `get_room_history` / `post_message` calls don't re-query `rooms.info`.
- **Unread data comes from one request.** `list_unread` calls `subscriptions.get`, which returns every subscription for the authenticated user. An earlier version looked for `subscriptions.getAll`, concluded the endpoint did not exist, and fanned out `subscriptions.getOne` per room instead — on a 59-room account that cost **~17s** against **~0.26s** for the bulk call.
- **Per-room fallback.** If `subscriptions.get` errors, or answers `200` without an `update` array, the per-room fan-out runs instead, concurrency-limited to **4 in-flight requests** to stay within typical Rocket.Chat per-endpoint rate limits. Falling back matters more than it looks: reading an empty bulk response as "nothing unread" would hide real messages rather than fail loudly.
- **Subscription-map cache.** Whichever path ran, the result is cached for **60 seconds** so repeat calls in the same session are free.
- **429 handling.** On `429 Too Many Requests`, the client parses the "wait X seconds" hint from the response body, sleeps for `min(X, 5s)`, and retries **once**. After that it gives up gracefully (the affected room is reported with whatever metadata is available; the tool does not error out).
- **Manual "Mark as Unread".** Rocket.Chat sets `alert: true` while leaving `unread: 0` for rooms you marked unread without new messages. `list_unread` includes both signals; rooms in this state are flagged with `manually_marked_unread: true`.

## Errors

All Rocket.Chat-side errors are surfaced as `RocketChatApiError` with:

```ts
{
  status: number;           // HTTP status
  errorType?: string;       // e.g. "totp-required", "error-not-allowed"
  path?: string;            // e.g. "/api/v1/chat.postMessage"
  message: string;          // human-readable, includes URL and Rocket.Chat error text
}
```

Network-level failures (DNS, TLS, connection reset) come through as plain `Error` with the original `cause` chained.

| Symptom | Likely cause |
|---|---|
| `Network error … fetch failed` with `ENOTFOUND` | Wrong hostname or VPN required |
| `Network error … UNABLE_TO_VERIFY_LEAF_SIGNATURE` | Internal CA — set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` |
| `Rocket.Chat 401 …` mentioning `ROCKETCHAT_USER_ID` / `ROCKETCHAT_AUTH_TOKEN` | Token revoked, expired, or paired with the wrong user id |
| `totp-required` errors | Personal Access Token was created without "Ignore Two Factor Authentication" |
| `list_unread` sometimes empty after recent calls | Rate limit hit and cache expired — wait ~60s |
| `ROCKETCHAT_URL must not include /api/v1` on startup | Set `ROCKETCHAT_URL` to the base URL only — the client appends `/api/v1` itself |

## Contributing

```sh
git clone https://github.com/k1sina/rocket-chat-mcp.git
cd rocket-chat-mcp
npm install
npm run dev          # tsx watch
npm test             # mocked-fetch unit tests, no network access required
npm run typecheck    # tsc --noEmit
npm run build        # tsc -> dist/
```

All write-tool behavior (`post_message`) is covered exclusively by mocked-fetch tests; no live `chat.postMessage` is ever invoked from the test suite. PRs and issues welcome at <https://github.com/k1sina/rocket-chat-mcp>.

## License

MIT — see [LICENSE](LICENSE).
