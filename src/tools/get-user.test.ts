import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RocketChatClient, type Fetcher } from "../rocketchat-client.js";
import { getUser } from "./get-user.js";

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

describe("get_user", () => {
  it("strips a leading '@' before calling users.info", async () => {
    let captured: URL | null = null;
    const fetcher: Fetcher = async (raw) => {
      const url = new URL(String(raw));
      captured = url;
      return jsonResponse({
        user: {
          _id: "u1",
          username: "lukas",
          name: "Lukas Müller",
          status: "online",
          active: true,
          roles: ["user"],
        },
        success: true,
      });
    };
    await getUser(clientWith(fetcher), { username: "@lukas" });
    const c = captured as unknown as URL;
    assert.equal(c.pathname, "/api/v1/users.info");
    assert.equal(c.searchParams.get("username"), "lukas");
  });

  it("maps the RC user payload to the public shape, picking the primary email", async () => {
    const fetcher: Fetcher = async () =>
      jsonResponse({
        user: {
          _id: "u2",
          username: "julia_koster",
          name: "Julia Saurin",
          status: "away",
          statusText: "in a meeting",
          emails: [
            { address: "julia@example.com", verified: true },
            { address: "alt@example.com", verified: false },
          ],
          active: true,
          roles: ["user", "admin"],
        },
        success: true,
      });

    const out = await getUser(clientWith(fetcher), { username: "julia_koster" });
    assert.deepEqual(out, {
      id: "u2",
      username: "julia_koster",
      name: "Julia Saurin",
      status: "away",
      status_text: "in a meeting",
      email: "julia@example.com",
      active: true,
      roles: ["user", "admin"],
    });
  });

  it("returns null email and sane defaults when fields are absent", async () => {
    const fetcher: Fetcher = async () =>
      jsonResponse({ user: { _id: "u3", username: "anon" }, success: true });

    const out = await getUser(clientWith(fetcher), { username: "anon" });
    assert.equal(out.email, null);
    assert.equal(out.status, "unknown");
    assert.equal(out.status_text, null);
    assert.equal(out.active, false);
    assert.deepEqual(out.roles, []);
  });
});
