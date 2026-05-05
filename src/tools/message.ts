interface RcUser {
  _id?: string;
  username?: string;
  name?: string;
}

interface RcReaction {
  usernames?: string[];
}

interface RcAttachment {
  _id?: string;
}

export interface RcMessage {
  _id: string;
  ts?: string;
  u?: RcUser;
  msg?: string;
  editedAt?: string;
  attachments?: RcAttachment[];
  reactions?: Record<string, RcReaction>;
  tmid?: string;
  tcount?: number;
}

export interface MessageRow {
  id: string;
  ts: string | null;
  user: { id: string; username: string; name: string };
  msg: string;
  edited_at: string | null;
  attachments_count: number;
  reactions: Record<string, number>;
  is_thread: boolean;
  thread_count: number;
}

function collapseReactions(
  reactions: Record<string, RcReaction> | undefined
): Record<string, number> {
  if (!reactions) return {};
  const out: Record<string, number> = {};
  for (const [emoji, val] of Object.entries(reactions)) {
    out[emoji] = val?.usernames?.length ?? 0;
  }
  return out;
}

export function stripMessage(m: RcMessage): MessageRow {
  return {
    id: m._id,
    ts: m.ts ?? null,
    user: {
      id: m.u?._id ?? "",
      username: m.u?.username ?? "",
      name: m.u?.name ?? "",
    },
    msg: m.msg ?? "",
    edited_at: m.editedAt ?? null,
    attachments_count: (m.attachments ?? []).length,
    reactions: collapseReactions(m.reactions),
    is_thread: !!m.tmid,
    thread_count: m.tcount ?? 0,
  };
}
