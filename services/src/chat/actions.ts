import { broadcastToRoom, sendToConnection, sendToUser } from "../live/broadcast.js";
import { subscribe } from "../live/connections.js";
import type { User } from "../lib/auth.js";
import { UserError, ValidationError } from "../lib/errors.js";
import { requireMember } from "./membership.js";
import { REACTIONS, seqNumber, type Message, type Reaction } from "./model.js";
import { chatRepo, type ChatRepo } from "./repo.js";

type Frame = Record<string, unknown>;

/** What a successful action answers its sender with, and how everyone else hears about it. */
interface Outcome { data?: unknown; notify?: () => Promise<unknown> }

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function id(raw: unknown, name: string): string {
  if (typeof raw !== "string" || !ID.test(raw)) throw new ValidationError(`${name} is missing or invalid.`);
  return raw;
}

const chatRef = (f: Frame) => ({ roomId: id(f.roomId, "roomId"), chatId: id(f.chatId, "chatId") });

// Built on first use, so importing this module needs no table configured.
let repo: ChatRepo | undefined;
const chat = () => (repo ??= chatRepo());

const updated = (message: Message): Outcome =>
  ({ data: message, notify: () => broadcastToRoom(message.roomId, { type: "message.updated", message }) });

async function perform(connId: string, user: User, f: Frame): Promise<Outcome> {
  switch (f.action) {
    case "send": {
      const message = await chat().send(user, {
        ...chatRef(f), clientId: id(f.clientId, "clientId"), text: f.text, attachments: f.attachments,
        replyToSeq: f.replyToSeq === undefined ? undefined : seqNumber(f.replyToSeq),
      });
      return { data: message, notify: () => broadcastToRoom(message.roomId, { type: "message.new", message }) };
    }
    case "edit":
      return updated(await chat().edit(user, { ...chatRef(f), seq: seqNumber(f.seq), text: f.text }));
    case "delete":
      return updated(await chat().remove(user, { ...chatRef(f), seq: seqNumber(f.seq) }));
    case "react": {
      if (!REACTIONS.includes(f.reaction as Reaction) || typeof f.on !== "boolean") {
        throw new ValidationError("react needs one of the six reactions and on: true or false.");
      }
      return updated(await chat().react(user, { ...chatRef(f), seq: seqNumber(f.seq), reaction: f.reaction as Reaction, on: f.on }));
    }
    case "typing": {
      const { roomId, chatId } = chatRef(f);
      await chat().assertCanType(user.userId, { roomId, chatId });
      const event = { type: "typing", roomId, chatId, userId: user.userId, username: user.username };
      return { notify: () => broadcastToRoom(roomId, event, { exceptConnId: connId }) };
    }
    case "read": {
      const { roomId, chatId } = chatRef(f);
      const { lastReadSeq } = await chat().markRead(user, { roomId, chatId, seq: seqNumber(f.seq) });
      // The reader's other tabs clear their badge too; this tab already knows.
      const event = { type: "read", roomId, chatId, lastReadSeq };
      return { data: { lastReadSeq }, notify: () => sendToUser(user.userId, event, { exceptConnId: connId }) };
    }
    case "subscribe": {
      // Sent whenever a room opens, so a room joined after the socket connected starts getting its events at once.
      // The member read is consistent; the user's room index that $connect reads (gsi1) can lag behind a join.
      const roomId = id(f.roomId, "roomId");
      await requireMember(roomId, user.userId);
      await subscribe(connId, user.userId, roomId);
      return {};
    }
    default:
      throw new ValidationError("Unknown action.");
  }
}

/**
 * Runs one client action and acks it with the frame's requestId. Expected refusals reach the client in their own
 * words; anything else is logged and answered generically, so internals never leak. The ack goes out before the
 * fan-out, so the sender's pending message settles as soon as it is stored.
 */
export async function handleAction(connId: string, user: User, frame: Frame): Promise<void> {
  const ack = (r: object) => sendToConnection(connId, { type: "ack", requestId: frame.requestId, ...r });
  let outcome: Outcome;
  try {
    outcome = await perform(connId, user, frame);
  } catch (e) {
    if (e instanceof UserError) return ack({ ok: false, error: e.message });
    console.error(`${String(frame.action)} failed`, e);
    return ack({ ok: false, error: "Something went wrong." });
  }
  await ack({ ok: true, data: outcome.data });
  await outcome.notify?.();
}
