import { mentionedAgent } from "../agents/model.js";
import { agentsRepo } from "../agents/repo.js";
import type { User } from "../lib/auth.js";
import { NotFound, ValidationError } from "../lib/errors.js";
import { CODE } from "../chat/mentions.js";
import type { Message } from "../chat/model.js";
import { chatRepo, type Admitted } from "../chat/repo.js";
import { broadcastToRoom } from "../live/broadcast.js";
import { parsePick } from "../models/picks.js";
import { mergeTaint, messageTaint, pickRefusal } from "../models/privacy.js";
import { startOrSteer } from "../runs/start.js";
import { threadsRepo, type ThreadsRepo } from "./repo.js";

interface SendInput {
  roomId: string; chatId: string; clientId: string; text: unknown; attachments?: unknown; replyToSeq?: number;
  /** Deliver into this thread, as a `#tag` would. */
  threadId?: string;
  /** The model the client picked for the agent's answer. */
  model?: unknown;
}

/** A `#tag` that stands on its own: not part of a word, and not the start of a longer name. */
const TAG = /(?<!\w)#([a-z0-9-]{1,32})(?![\w-])/gi;
/** A tag made only of digits is a thread number already; one with a letter is a name. */
const isName = (tag: string) => /[a-z]/i.test(tag);

/** A message delivered into this many threads at most; further tags are only links. */
const MAX_DELIVERIES = 3;

const tagsOutsideCode = (text: string) => [...text.replace(CODE, " ").matchAll(TAG)].map((m) => m[1]!.toLowerCase());

/** The distinct `#name` tags outside code, lowercased as thread names are. */
export function tagNames(text: string): string[] {
  return [...new Set(tagsOutsideCode(text).filter(isName))];
}

/** The distinct `#number` tags outside code, in the order they appear. */
export function tagNumbers(text: string): number[] {
  return [...new Set(tagsOutsideCode(text).filter((tag) => !isName(tag)).map(Number))];
}

/**
 * Turns each thread `#name` into its `#number`, which stays right after the thread is renamed. Code is left as
 * written, and a name `resolve` doesn't know (a chat's, or no thread's) stays a name.
 */
export function rewriteTags(text: string, resolve: (name: string) => number | null): string {
  const rewrite = (plain: string) => plain.replace(TAG, (tag, name: string) => {
    const n = isName(name) ? resolve(name.toLowerCase()) : null;
    return n === null ? tag : `#${n}`;
  });
  let out = "";
  let from = 0;
  for (const code of text.matchAll(CODE)) {
    out += rewrite(text.slice(from, code.index)) + code[0];
    from = code.index + code[0].length;
  }
  return out + rewrite(text.slice(from));
}

async function withThreadNumbers(threads: ThreadsRepo, roomId: string, text: string): Promise<string> {
  const names = tagNames(text);
  if (!names.length) return text;
  const found = await Promise.all(names.map((name) => threads.threadByTag(roomId, { name })));
  const numbers = new Map(found.flatMap((t, i) => (t ? [[names[i]!, t.number] as const] : [])));
  return rewriteTags(text, (name) => numbers.get(name) ?? null);
}

/**
 * The threads a people-chat message goes into: the one it names by id, else the first few its tags name. The text's
 * thread names are numbers by now, so a tag that is still a name is a chat's or nobody's, and goes nowhere.
 */
async function deliveryTargets(threads: ThreadsRepo, roomId: string, threadId: string | undefined, text: string) {
  if (threadId) {
    const thread = await threads.threadById(roomId, threadId);
    if (!thread) throw new NotFound("Thread not found.");
    return [thread];
  }
  const found = await Promise.all(tagNumbers(text).map((number) => threads.threadByTag(roomId, { number })));
  return found.filter((t) => t !== null).slice(0, MAX_DELIVERIES);
}

/**
 * Stores a send and returns it with `route`, the hand-off to the agent, which the caller runs after acking the
 * sender. A message in a thread starts or steers its run. A people-chat message that tags threads is copied into each,
 * and one that mentions a room agent starts a new thread for the first one it names; either way the original then
 * points at the threads. The sender has its ack by the time the hand-off runs, so a hand-off failure is logged and the
 * message stands.
 *
 * A message for the agent may pick its model. A pick that may not see private content is refused before anything is
 * stored when the message carries a file or its thread is already private; a message only people read needs no check.
 */
export async function routeSend(user: User, input: SendInput): Promise<{ message: Message; route: () => Promise<void> }> {
  const chat = chatRepo();
  const threads = threadsRepo();
  const { roomId, chatId, clientId } = input;
  const pick = parsePick(input.model, process.env.STAGE ?? "");
  const admitted = await chat.admit(user, { roomId, chatId, text: input.text, attachments: input.attachments });
  const ready: Admitted = { ...admitted, text: await withThreadNumbers(threads, roomId, admitted.text) };
  const ownThread = await threads.threadById(roomId, chatId);
  const targets = ownThread ? [] : await deliveryTargets(threads, roomId, input.threadId, ready.text);
  const agentThreads = ownThread ? [ownThread] : targets;
  const mentioned = !agentThreads.length && ready.text.includes("@") ? mentionedAgent(ready.text, await agentsRepo().list(roomId)) : null;
  if (agentThreads.length || mentioned) {
    const refusal = pickRefusal(pick, mergeTaint(...agentThreads.map((t) => t.taint), messageTaint(admitted)));
    if (refusal) throw new ValidationError(refusal);
  }
  const message = await chat.send(user, { roomId, chatId, clientId, text: ready.text, replyToSeq: input.replyToSeq }, ready);

  const link = async (threadRef: NonNullable<Message["threadRef"]>) => {
    const linked = await chat.linkThread(message, threadRef);
    await broadcastToRoom(roomId, { type: "message.updated", message: linked });
  };
  // Its own client id, so a tab settling its pending send by client id never takes the copy for the original.
  const copyId = `${clientId}:t`;

  const route = async () => {
    try {
      if (ownThread) {
        await startOrSteer(user, roomId, ownThread.threadId, message, pick);
      } else if (targets.length) {
        // Linked after each hand-off rather than once at the end, so one that fails part way still points at (and so a
        // deletion still reaches) the copies before it.
        const delivered: { threadId: string; seq: number }[] = [];
        for (const target of targets) {
          const copy = await chat.send(user, { roomId, chatId: target.threadId, clientId: copyId, text: ready.text }, ready, { copy: true });
          await broadcastToRoom(roomId, { type: "message.new", message: copy });
          await startOrSteer(user, roomId, target.threadId, copy, pick);
          delivered.push({ threadId: target.threadId, seq: copy.seq });
          await link({ kind: "delivered", threads: [...delivered] });
        }
      } else if (mentioned) {
        const started = await threads.createThread(user, roomId, {
          text: ready.text, clientId: copyId, from: { chatId, seq: message.seq }, admitted: ready, agentId: mentioned.agentId,
        });
        await startOrSteer(user, roomId, started.thread.threadId, started.message, pick);
        await link({ kind: "started", threadId: started.thread.threadId, seq: started.message.seq });
      }
    } catch (e) {
      console.error("handing a message to the agent failed", roomId, chatId, message.seq, e);
    }
  };
  return { message, route };
}
