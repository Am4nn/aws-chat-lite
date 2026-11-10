export type Role = "owner" | "admin" | "member";

export type Me = { userId: string; username: string; isCreator: boolean };

export type RoomSummary = { roomId: string; name: string; role: Role };

export type Chat = { chatId: string; name: string };

export type Member = { userId: string; username: string; role: Role };

export type RoomView = {
  room: { roomId: string; name: string; ownerId: string };
  me: { role: Role };
  chats: Chat[];
  members: Member[];
};

export const isAdmin = (role: Role) => role === "owner" || role === "admin";
