import type { Role } from "../rooms/access.js";
import { ValidationError } from "../lib/errors.js";

export type Reaction = "thumbs" | "heart" | "joy" | "tada" | "eyes" | "check";
export type Attachment = { key: string; name: string; size: number; type: string; url?: string };
export type Message = {
  roomId: string;
  chatId: string;
  seq: number;
  authorId: string;
  authorName: string;
  clientId?: string;
  text: string;
  createdAt: string;
  editedAt?: string;
  deleted?: "self" | "admin";
  replyTo?: { seq: number; authorName: string; excerpt: string };
  attachments: Attachment[];
  reactions: Partial<Record<Reaction, string[]>>;
  mentions: string[];
  everyone: boolean;
  /** How many times the message has changed (edit, delete, reaction); absent until the first change. */
  v?: number;
};
/** `textLower` backs search; it never leaves the server. */
export type StoredMessage = Message & { textLower: string };

export const REACTIONS: readonly Reaction[] = ["thumbs", "heart", "joy", "tada", "eyes", "check"];
export const EDIT_WINDOW_SEC = 900;
const MAX_TEXT = 4000;
export const MAX_ATTACHMENTS = 5;
export const MAX_FILE_BYTES = 10_485_760;
export const RATE_PER_MIN = 30;
export const PAGE = 50;

const MAX_NAME = 200;
const MAX_TYPE = 100;
const EXCERPT_LENGTH = 140;

/** The highest seq the 10-digit sort key can hold. */
export const LAST_SEQ = 9_999_999_999;

const padded = (seq: number) => String(seq).padStart(10, "0");

/** Zero-padded so DynamoDB's string sort order matches numeric order. */
export function seqKey(seq: number): string {
  return `MSG#${padded(seq)}`;
}

/** An earlier text of message `seq`, replaced at `editedAt`. */
export function versionKey(seq: number, editedAt: string): string {
  return `VER#${padded(seq)}#${editedAt}`;
}

/** A message number from a client: a whole number that fits the sort key. */
export function seqNumber(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > LAST_SEQ) {
    throw new ValidationError("seq must be a whole number.");
  }
  return raw;
}

export function messageText(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("text must be a string");
  const text = raw.trim();
  if (text.length > MAX_TEXT) throw new ValidationError(`text must be at most ${MAX_TEXT} characters`);
  return text;
}

type Authored = { authorId: string; createdAt: string; deleted?: "self" | "admin" };

function withinWindow(msg: Authored, nowMs: number): boolean {
  return nowMs - Date.parse(msg.createdAt) <= EDIT_WINDOW_SEC * 1000;
}

export function canEdit(msg: Authored, userId: string, nowMs: number): boolean {
  return !msg.deleted && msg.authorId === userId && withinWindow(msg, nowMs);
}

export function deleteMode(msg: Authored, userId: string, role: Role, nowMs: number): "self" | "admin" | null {
  if (msg.authorId === userId && withinWindow(msg, nowMs)) return "self";
  return role === "owner" || role === "admin" ? "admin" : null;
}

/** Cut by code point, not UTF-16 unit, so an emoji at the cut is never split into half a surrogate pair. */
export function excerpt(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > EXCERPT_LENGTH ? `${chars.slice(0, EXCERPT_LENGTH).join("")}…` : chars.join("");
}

/** A deleted message keeps its text and files in the table; readers get neither. */
export function forReaders({ textLower: _textLower, ...message }: StoredMessage): Message {
  return message.deleted ? { ...message, text: "", attachments: [] } : message;
}

export function validAttachment(a: unknown, roomId: string, userId: string): Attachment {
  const { key, name, size, type } = (a ?? {}) as Record<string, unknown>;
  if (
    typeof key !== "string" ||
    !key.startsWith(`rooms/${roomId}/${userId}/`) ||
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > MAX_NAME ||
    typeof size !== "number" ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > MAX_FILE_BYTES ||
    typeof type !== "string" ||
    type.length < 1 ||
    type.length > MAX_TYPE
  ) {
    throw new ValidationError("invalid attachment");
  }
  return { key, name, size, type };
}
