import { randomUUID } from "node:crypto";
import { mentionedAgents } from "../../agents/model.js";
import { parseMentions } from "../../chat/mentions.js";
import { messageText } from "../../chat/model.js";
import { chatRepo } from "../../chat/repo.js";
import { bestEffort } from "../../lib/best-effort.js";
import { NotFound, ValidationError } from "../../lib/errors.js";
import { broadcastToRoom } from "../../live/broadcast.js";
import { roomDirectory } from "../../rooms/repo.js";
import { runsRepo } from "../../runs/repo.js";
import { tagNames, tagNumbers } from "../../threads/route.js";
import type { Agent, RunEvent, ThreadSummary } from "../../threads/types.js";
import { answer } from "../answer.js";
import type { Tool, ToolEnv } from "../types.js";

type Chat = { chatId: string; name: string; archived: boolean };

const chatName = (input: Record<string, unknown>) => String(input.chat ?? "").replace(/^#/, "").toLowerCase();
const postText = (input: Record<string, unknown>) => (typeof input.text === "string" ? input.text.trim() : "");

/**
 * Why a post's text would reach more than the people it names, or null. A post never routes, so the `@agent` or the
 * thread `#tag` it carries would only mislead its readers into thinking an agent was asked. A `#tag` that is no
 * thread's (a chat's, or nothing) is just text.
 */
export function postRefusal(
  text: string, room: { agents: Pick<Agent, "name">[]; threads: Pick<ThreadSummary, "number" | "name">[] },
): string | null {
  if (parseMentions(text, []).everyone) return "Posts can't use @everyone.";
  const [agent] = mentionedAgents(text, room.agents);
  if (agent) return `Posts can't mention agents (@${agent.name}). Hand work to an agent with delegate.`;
  const numbers = new Set(room.threads.map((t) => t.number));
  const names = new Set(room.threads.map((t) => t.name));
  const tag = tagNumbers(text).find((n) => numbers.has(n)) ?? tagNames(text).find((n) => names.has(n));
  return tag === undefined ? null : `Posts can't tag threads (#${tag}). Name the thread without the #.`;
}

/** The posts a run has made, in every lane: a refused or failed post doesn't count towards the room's cap. */
export function postsMade(events: RunEvent[]): number {
  const key = (e: RunEvent & { step: number }) => `${e.lane ?? 0}#${e.step}`;
  const posts = new Set(events.flatMap((e) => (e.type === "step.started" && e.call.name === "room_post" ? [key(e)] : [])));
  return events.filter((e) => e.type === "step.finished" && e.ok && posts.has(key(e))).length;
}

/** Only a people chat takes a post: a thread's messages go to its agent. */
const peopleChat = (chats: Chat[], name: string) => chats.find((c) => c.name === name);

async function refusal(input: Record<string, unknown>, env: ToolEnv): Promise<string | null> {
  const text = postText(input);
  if (!text) return "A post needs text.";
  try {
    messageText(text);
  } catch (e) {
    if (e instanceof ValidationError) return e.message;
    throw e;
  }
  const { postCap } = env.room;
  if (postsMade(await runsRepo().allEvents(env.room.runId)) >= postCap) return `This run has made its ${postCap} posts, the room's cap per run.`;
  const directory = await roomDirectory(env.room.roomId);
  const name = chatName(input);
  const chat = peopleChat(directory.chats, name);
  if (!chat) return `There's no chat #${name} here. Chats: ${directory.chats.map((c) => `#${c.name}`).join(", ")}.`;
  if (chat.archived) return `#${chat.name} is archived.`;
  return postRefusal(text, directory);
}

/**
 * The agent posts in its own name, marked with the thread it posts from. It is stored as the server's own message, as
 * a schedule's card is: the agent is no member, so `admit` is skipped, and the post goes through no routing, so it
 * never starts or steers an agent nor reaches a thread. The people it names are notified as by any message. Each post
 * has its own client id, since a tab keys a chat's rows by it.
 */
export const ROOM_POST: Tool = {
  spec: {
    name: "room_post",
    description: "Post a message in one of this room's people chats, as yourself. @mention people to notify them. A post "
      + "can't use @everyone, mention agents or tag threads.",
    inputSchema: {
      type: "object",
      properties: { chat: { type: "string", description: "The chat's name, like general." }, text: { type: "string" } },
      required: ["chat", "text"],
    },
  },
  kind: "room_post",
  write: true,
  detail: (input) => `#${chatName(input)}`,
  check: refusal,
  ask: (input) => `Post in #${chatName(input)}: "${postText(input).slice(0, 80)}"?`,
  run: (input, env) => answer(async () => {
    const { roomId, threadId, threadNumber, agentName } = env.room;
    const chat = peopleChat((await roomDirectory(roomId)).chats, chatName(input));
    if (!chat) throw new NotFound(`There's no chat #${chatName(input)} here.`);
    const text = postText(input);
    const message = await chatRepo().send(
      { userId: "agent", username: agentName }, { roomId, chatId: chat.chatId, clientId: `agent-${randomUUID()}`, text },
      { text, attachments: [] }, { system: true, agentPost: { threadId, number: threadNumber } },
    );
    await bestEffort("message.new broadcast", () => broadcastToRoom(roomId, { type: "message.new", message }));
    return `Posted in #${chat.name} (message ${message.seq}).`;
  }),
};
