import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { RocketChatClient, type Fetcher } from "../rocketchat-client.js";
import { postMessage, postMessageInputShape } from "./post-message.js";

const inputSchema = z.object(postMessageInputShape);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalEnv: NodeJS.ProcessEnv;
let stderrLines: string[];
let originalStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  originalEnv = { ...process.env };
  process.env.ROCKETCHAT_USER_ID = "test-user";
  process.env.ROCKETCHAT_AUTH_TOKEN = "test-token";
  stderrLines = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
});
afterEach(() => {
  process.env = originalEnv;
  process.stderr.write = originalStderrWrite;
});

function clientWith(fetcher: Fetcher): RocketChatClient {
  return new RocketChatClient("https://chat.example.com", { fetcher });
}

describe("post_message", () => {
  it("POSTs to chat.postMessage with the minimal body and JSON content-type", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetcher: Fetcher = async (raw, init) => {
      captured = { url: String(raw), init: init ?? {} };
      return jsonResponse({
        message: {
          _id: "msg-123",
          rid: "rid-1",
          ts: "2026-04-29T11:00:00.000Z",
          msg: "hello",
        },
        success: true,
      });
    };

    const out = await postMessage(clientWith(fetcher), {
      room_id: "rid-1",
      text: "hello",
    });

    assert.ok(captured);
    const { url, init } = captured as unknown as { url: string; init: RequestInit };
    assert.match(url, /\/api\/v1\/chat\.postMessage$/);
    assert.equal(init.method, "POST");
    const headers = init.headers as Record<string, string>;
    assert.equal(headers["X-User-Id"], "test-user");
    assert.equal(headers["X-Auth-Token"], "test-token");
    assert.equal(headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(String(init.body)), { roomId: "rid-1", text: "hello" });

    assert.deepEqual(out, {
      posted: true,
      message_id: "msg-123",
      room_id: "rid-1",
      thread_id: null,
      ts: "2026-04-29T11:00:00.000Z",
    });
  });

  it("includes tmid in the body when thread_id is set", async () => {
    let capturedBody: unknown = null;
    const fetcher: Fetcher = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({
        message: { _id: "m2", rid: "rid-1", ts: "2026-04-29T11:01:00.000Z", tmid: "thread-7" },
        success: true,
      });
    };
    const out = await postMessage(clientWith(fetcher), {
      room_id: "rid-1",
      text: "in-thread reply",
      thread_id: "thread-7",
    });
    assert.deepEqual(capturedBody, {
      roomId: "rid-1",
      text: "in-thread reply",
      tmid: "thread-7",
    });
    assert.equal(out.thread_id, "thread-7");
  });

  it("trims surrounding whitespace from text before posting", async () => {
    let capturedBody: { text?: string } | null = null;
    const fetcher: Fetcher = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({ message: { _id: "m3", rid: "rid-1" }, success: true });
    };
    await postMessage(clientWith(fetcher), {
      room_id: "rid-1",
      text: "   hello   ",
    });
    assert.equal(capturedBody?.text, "hello");
  });

  it("zod rejects empty text", () => {
    const r = inputSchema.safeParse({ room_id: "rid-1", text: "" });
    assert.equal(r.success, false);
  });

  it("zod rejects whitespace-only text", () => {
    const r = inputSchema.safeParse({ room_id: "rid-1", text: "   \n\t " });
    assert.equal(r.success, false);
  });

  it("zod rejects empty room_id", () => {
    const r = inputSchema.safeParse({ room_id: "", text: "hi" });
    assert.equal(r.success, false);
  });

  it("logs the full payload to stderr prefixed with [WRITE] regardless of DEBUG", async () => {
    delete process.env.DEBUG;
    const fetcher: Fetcher = async () =>
      jsonResponse({ message: { _id: "m4", rid: "rid-1" }, success: true });
    await postMessage(clientWith(fetcher), { room_id: "rid-1", text: "audit me" });

    const writeLine = stderrLines.find((l) => l.startsWith("[WRITE]"));
    assert.ok(writeLine, "expected a [WRITE] log line on stderr");
    assert.match(writeLine!, /chat\.postMessage/);
    assert.match(writeLine!, /"roomId":"rid-1"/);
    assert.match(writeLine!, /"text":"audit me"/);
  });

  it("surfaces RC error body on 4xx (e.g. invalid roomId)", async () => {
    const fetcher: Fetcher = async () =>
      jsonResponse(
        {
          success: false,
          error: "[invalid-channel] error-room-not-found",
          errorType: "error-room-not-found",
        },
        400
      );
    await assert.rejects(
      () => postMessage(clientWith(fetcher), { room_id: "rid-bogus", text: "hi" }),
      (err: Error) => /error-room-not-found/.test(err.message)
    );
  });
});
