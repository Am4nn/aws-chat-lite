"use client";

import { useRef, useState, type DragEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Download, FileText, Trash2, Upload } from "lucide-react";
import { bff, errorText } from "@/lib/client/bff";
import { authorLabel, ROOM_FILES_BYTES, screenUploads } from "@/lib/client/files";
import { fileSize, timeAgo } from "@/lib/client/format";
import { useNow } from "@/lib/client/useNow";
import { easeOut, instant } from "@/lib/motion";
import type { RoomFile, ThreadSummary } from "@/lib/types";
import { Confirm } from "@/components/overlays/Confirm";
import { Modal } from "@/components/overlays/Modal";
import { useToast } from "@/components/overlays/Toast";
import { Button } from "@/components/ui/Button";
import { Hint } from "@/components/ui/Hint";
import { PanelLoading } from "@/components/ui/PanelLoading";
import { RowButton } from "@/components/ui/RowButton";
import { Spinner } from "@/components/ui/Spinner";
import { Switch } from "@/components/ui/Switch";
import type { RoomFiles } from "./useRoomFiles";

const INTERNET_HINT = "Off: code can't reach the internet. On: pip install and git clone work. Applies to new runs.";
const AGE_TICK_MS = 60_000;

type Ask = { kind: "replace"; file: File } | { kind: "delete"; path: string };

const ASKS = {
  replace: { title: (name: string) => `Replace ${name}?`, body: "The old version is gone for good.", action: "Replace" },
  delete: { title: (path: string) => `Delete ${path}?`, body: "This can't be undone.", action: "Delete" },
};

/**
 * The room's shared files, which every member and every agent's sandbox reads and writes. Uploads land in the root
 * under their own names; replacing or deleting a file asks first, since the room keeps only the latest version.
 */
export function FilesPanel({ roomId, store, threads, internet, canSwitch, canWrite }: {
  roomId: string; store: RoomFiles; threads: ThreadSummary[]; internet: boolean; canSwitch: boolean; canWrite: boolean;
}) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [asks, setAsks] = useState<Ask[]>([]);
  const now = useNow(true, AGE_TICK_MS);
  const ask = asks[0];
  const next = () => setAsks((a) => a.slice(1));

  function pick(picked: File[]) {
    const { upload, replace, refused } = screenUploads(picked, store.files, store.usedBytes);
    refused.forEach((r) => toast(`${r.name}: ${r.why}`, "error"));
    const named = (names: string[]) => names.map((n) => picked.find((f) => f.name === n)!);
    if (upload.length) void store.upload(named(upload));
    setAsks((a) => [...a, ...named(replace).map((file): Ask => ({ kind: "replace", file }))]);
  }

  function drop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    pick([...e.dataTransfer.files]);
  }

  // A delete closes the dialog on the tap; a replace waits, since the upload can take a while to land.
  async function answer(a: Ask) {
    if (a.kind === "delete") store.remove(a.path);
    else await store.upload([a.file]);
    next();
  }

  const copy = ask && ASKS[ask.kind];
  const subject = ask && (ask.kind === "replace" ? ask.file.name : ask.path);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11.5px] text-text-3">{fileSize(store.usedBytes)} of {fileSize(ROOM_FILES_BYTES)}</span>
        {canWrite && (
          <>
            <Button onClick={() => input.current?.click()} size="sm" className="ml-auto">
              {store.uploading ? <Spinner /> : <Upload aria-hidden="true" size={14} />}
              Upload
            </Button>
            <input
              ref={input} type="file" multiple hidden
              onChange={(e) => {
                pick([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </>
        )}
      </div>

      <InternetRow roomId={roomId} internet={internet} canSwitch={canSwitch} />

      <div
        onDragOver={canWrite ? (e) => { e.preventDefault(); setDragging(true); } : undefined}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={canWrite ? drop : undefined}
        className={`min-h-24 rounded-xl border p-1 transition-colors duration-150 ${dragging ? "border-lime/40" : "border-line-strong"}`}
      >
        {store.state !== "ready"
          // One row stays inside the box's minimum height, so a short list lands without moving anything.
          ? <PanelLoading rows={1} failed={store.state === "failed"} onRetry={store.reload} />
          : store.files.length === 0
          ? <p className="px-2 py-3 text-[12.5px] text-text-3">No files yet. Upload one, or ask an agent to make one.</p>
          : (
            <ul className="flex flex-col">
              <AnimatePresence initial={false}>
                {store.files.map((f) => (
                  <FileRow
                    key={f.path} file={f} fresh={store.fresh.has(f.path)} meta={`${fileSize(f.size)} · ${authorLabel(f.updatedBy, threads)} · ${timeAgo(f.updatedAt, now)}`}
                    onDownload={() => store.download(f.path)}
                    onDelete={canWrite ? () => setAsks((a) => [...a, { kind: "delete", path: f.path }]) : undefined}
                  />
                ))}
              </AnimatePresence>
            </ul>
          )}
      </div>

      <Modal open={!!ask} onClose={next} title={copy && subject ? copy.title(subject) : ""}>
        {ask && copy && <Confirm action={copy.action} onCancel={next} onConfirm={() => answer(ask)}>{copy.body}</Confirm>}
      </Modal>
    </section>
  );
}

/** A file that just changed slides in (when new) and flashes lime once; a removed one fades and folds away. */
function FileRow({ file, fresh, meta, onDownload, onDelete }: {
  file: RoomFile; fresh: boolean; meta: string; onDownload: () => void; onDelete?: () => void;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.li
      data-fresh={fresh || undefined}
      initial={fresh && !reduced ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0, transition: instant } : { opacity: 0, height: 0, transition: { duration: 0.18, ease: easeOut } }}
      transition={{ duration: 0.22, ease: easeOut }}
      className="group relative isolate flex h-10 shrink-0 items-center gap-2.5 overflow-hidden rounded-[10px] px-2 hover:bg-surface-2 focus-within:bg-surface-2"
    >
      {fresh && !reduced && (
        <motion.span
          aria-hidden="true" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: 0.5, ease: easeOut }}
          className="absolute inset-0 -z-10 bg-[rgba(200,241,105,.10)]"
        />
      )}
      <FileText aria-hidden="true" size={14} className="shrink-0 text-text-3" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span title={file.path} className="truncate font-mono text-[12.5px] leading-4">{file.path}</span>
        <span suppressHydrationWarning className="truncate text-[11px] leading-4 text-text-3">{meta}</span>
      </span>
      <RowButton label={`Download ${file.path}`} onClick={onDownload}><Download aria-hidden="true" size={14} /></RowButton>
      {onDelete && <RowButton label={`Delete ${file.path}`} onClick={onDelete}><Trash2 aria-hidden="true" size={14} /></RowButton>}
    </motion.li>
  );
}

/**
 * Whether code in this room's sandbox reaches the internet. An admin's switch moves at once and moves back if the
 * server refuses; the room view brings everyone else the change.
 */
function InternetRow({ roomId, internet, canSwitch }: { roomId: string; internet: boolean; canSwitch: boolean }) {
  const toast = useToast();
  const [on, setOn] = useState(internet);
  const [stored, setStored] = useState(internet);
  if (stored !== internet) {
    setStored(internet);
    setOn(internet);
  }

  async function toggle() {
    const wanted = !on;
    setOn(wanted);
    try {
      await bff(`/bff/api/rooms/${roomId}/sandbox`, { method: "PUT", body: { internet: wanted } });
    } catch (e) {
      setOn(!wanted);
      toast(errorText(e), "error");
    }
  }

  return (
    <div className="relative flex h-8 items-center gap-1 text-xs text-text-2">
      Sandbox internet
      <Hint text={INTERNET_HINT} below />
      {canSwitch
        ? <Switch on={on} label="Sandbox internet" onToggle={toggle} className="ml-auto" />
        : <span className="ml-auto font-mono text-text-3">{on ? "on" : "off"}</span>}
    </div>
  );
}
