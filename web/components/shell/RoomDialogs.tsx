"use client";

import { Confirm } from "@/components/overlays/Confirm";
import { Modal } from "@/components/overlays/Modal";
import { CreateChat } from "@/components/rooms/CreateChat";
import { CreateRoom } from "@/components/rooms/CreateRoom";

export type Dialog = "chat" | "room" | "leave" | "archive" | null;

export function RoomDialogs({ dialog, roomId, roomName, onClose, onExit }: {
  dialog: Dialog; roomId: string; roomName: string; onClose: () => void;
  onExit: (action: "leave" | "archive", done: string) => Promise<void>;
}) {
  return (
    <>
      <Modal open={dialog === "chat"} onClose={onClose} title="New chat">
        <CreateChat roomId={roomId} onDone={onClose} />
      </Modal>
      <Modal open={dialog === "room"} onClose={onClose} title="New room">
        <CreateRoom onDone={onClose} />
      </Modal>
      <Modal open={dialog === "leave"} onClose={onClose} title={`Leave ${roomName}?`}>
        <Confirm action="Leave room" onCancel={onClose} onConfirm={() => onExit("leave", `You left ${roomName}`)}>
          You&apos;ll stop seeing its chats. To come back you&apos;ll need a new invite link.
        </Confirm>
      </Modal>
      <Modal open={dialog === "archive"} onClose={onClose} title={`Archive ${roomName}?`}>
        <Confirm action="Archive room" onCancel={onClose} onConfirm={() => onExit("archive", `${roomName} archived`)}>
          Read-only and hidden from everyone&apos;s room list. Messages and files stay; the invite link stops working.
        </Confirm>
      </Modal>
    </>
  );
}
