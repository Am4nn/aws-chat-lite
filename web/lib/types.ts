export type Role = "owner" | "admin" | "member";

export type Me = { userId: string; username: string; isCreator: boolean };

export type RoomSummary = { roomId: string; name: string; role: Role };

/** `unread` and `mentions` are mine; a muted chat still counts them, it just doesn't badge unread. */
export type Chat = { chatId: string; name: string; lastSeq: number; unread: number; mentions: number; muted: boolean };

export type Member = { userId: string; username: string; role: Role; online: boolean; lastSeen?: string };

export type RoomView = {
  room: { roomId: string; name: string; ownerId: string; archived: boolean };
  me: { role: Role };
  chats: Chat[];
  members: Member[];
};

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
};

export type LiveEvent =
  | { type: "message.new" | "message.updated"; message: Message }
  | { type: "typing"; roomId: string; chatId: string; userId: string; username: string }
  | { type: "presence"; userId: string; online: boolean; lastSeen: string }
  | { type: "read"; roomId: string; chatId: string; lastReadSeq: number }
  | { type: "room.updated"; roomId: string }
  | { type: "pong" };

export const isAdmin = (role: Role) => role === "owner" || role === "admin";
