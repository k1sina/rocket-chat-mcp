import { z } from "zod";
import type { RocketChatClient } from "../rocketchat-client.js";

interface RcUserResponse {
  user?: {
    _id?: string;
    username?: string;
    name?: string;
    status?: string;
    statusText?: string;
    emails?: { address?: string; verified?: boolean }[];
    active?: boolean;
    roles?: string[];
  };
}

export const getUserInputShape = {
  username: z
    .string()
    .min(1)
    .describe(
      "Username to look up. The leading '@' is optional and will be stripped. Examples: 'lukas', '@julia_koster'."
    ),
};

const inputSchema = z.object(getUserInputShape);
export type GetUserInput = z.infer<typeof inputSchema>;

export const getUserDescription =
  "Looks up a Rocket.Chat user by username. Useful for resolving '@someone' to their full name, role, status, or to confirm they exist before posting. " +
  "Returns id, username, name, status, status_text, email (only when visible to you), active, roles.";

export interface UserRow {
  id: string;
  username: string;
  name: string;
  status: string;
  status_text: string | null;
  email: string | null;
  active: boolean;
  roles: string[];
}

export async function getUser(
  client: RocketChatClient,
  input: GetUserInput
): Promise<UserRow> {
  const username = input.username.replace(/^@+/, "");
  const res = await client.request<RcUserResponse>("GET", "/api/v1/users.info", {
    query: { username },
  });
  const u = res.user ?? {};
  const primaryEmail = u.emails?.find((e) => e.address)?.address ?? null;
  return {
    id: u._id ?? "",
    username: u.username ?? username,
    name: u.name ?? "",
    status: u.status ?? "unknown",
    status_text: u.statusText ?? null,
    email: primaryEmail,
    active: u.active ?? false,
    roles: u.roles ?? [],
  };
}
