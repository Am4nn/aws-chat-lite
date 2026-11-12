"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Lock, Pencil, Trash2 } from "lucide-react";
import { bff, errorText } from "@/lib/client/bff";
import { useLiveEvent } from "@/lib/client/LiveProvider";
import { MEMORY_CHARS, MEMORY_MAX, sourceLine } from "@/lib/client/memory";
import { removeOptimistically } from "@/lib/client/optimistic";
import { useNow } from "@/lib/client/useNow";
import { easeOut, instant, swap } from "@/lib/motion";
import type { MemoryEntry } from "@/lib/types";
import { Confirm } from "@/components/overlays/Confirm";
import { Modal } from "@/components/overlays/Modal";
import { useToast } from "@/components/overlays/Toast";
import { Button } from "@/components/ui/Button";
import { panelInput } from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { PanelLoading } from "@/components/ui/PanelLoading";
import { RowButton } from "@/components/ui/RowButton";
import { useRoomData } from "./useRoomData";

const PRIVATE_HINT = "Saved from a thread with private content, so DeepSeek never sees it.";
const AGE_TICK_MS = 60_000;
const FRESH_MS = 1500;

/**
 * What the room's agents saved to remember, which goes into every run. Any member corrects or deletes an entry; only
 * agents add them. It is fetched again whenever memory changes, and an entry that arrives that way slides in. Edits
 * and deletes show on the tap; a refusal undoes them and says why, and a refused edit opens again with what was typed.
 */
export function MemoryPanel({ roomId, archived }: { roomId: string; archived: boolean }) {
  const toast = useToast();
  const now = useNow(true, AGE_TICK_MS);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [deleting, setDeleting] = useState<MemoryEntry | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  // The list last looked at, and every id shown so far: null until the first list (cached or fetched), whose entries
  // were already there.
  const [seen, setSeen] = useState<{ list?: MemoryEntry[]; ids: Set<string> | null }>({ ids: null });
  const base = `/bff/api/rooms/${roomId}/memory`;
  const { data, setData, failed, reload } = useRoomData<{ entries: MemoryEntry[] }>(base);
  const entries = data?.entries;
  const setEntries = (change: (list: MemoryEntry[]) => MemoryEntry[]) => setData((d) => d && { entries: change(d.entries) });
  useLiveEvent("memory.changed", (e) => {
    if (e.roomId === roomId) reload();
  });

  // Marked while rendering, not in an effect: a row's entrance is fixed when it mounts, so it must mount already new.
  if (entries && entries !== seen.list) {
    const ids = entries.map((m) => m.memoryId);
    const added = seen.ids ? ids.filter((id) => !seen.ids!.has(id)) : [];
    setSeen({ list: entries, ids: new Set([...(seen.ids ?? []), ...ids]) });
    if (added.length) setFresh(new Set(added));
  }
  useEffect(() => {
    if (!fresh.size) return;
    const timer = setTimeout(() => setFresh(new Set()), FRESH_MS);
    return () => clearTimeout(timer);
  }, [fresh]);

  const put = (entry: MemoryEntry) => setEntries((list) => list.map((m) => (m.memoryId === entry.memoryId ? entry : m)));

  async function save(entry: MemoryEntry, text: string) {
    put({ ...entry, text });
    setEditing(null);
    try {
      put((await bff<{ entry: MemoryEntry }>(`${base}/${entry.memoryId}`, { method: "PATCH", body: { text } })).entry);
    } catch (e) {
      // Only undone while the row still shows this edit: a refetch may have brought something newer.
      setEntries((list) => list.map((m) => (m.memoryId === entry.memoryId && m.text === text ? entry : m)));
      setEditing({ id: entry.memoryId, text });
      toast(errorText(e), "error");
    }
  }

  function remove(entry: MemoryEntry) {
    setDeleting(null);
    removeOptimistically({ list: entries!, item: entry, key: (m) => m.memoryId, set: setEntries }, () =>
      bff(`${base}/${entry.memoryId}`, { method: "DELETE", body: {} })).catch((e) => toast(errorText(e), "error"));
  }

  if (!entries) return <PanelLoading failed={failed} onRetry={reload} />;

  return (
    <section className="flex flex-col gap-2">
      <p className="font-mono text-[11.5px] text-text-3">{entries.length} of {MEMORY_MAX}</p>
      {entries.length === 0 && <p className="text-[12.5px] text-text-3">Nothing yet. Agents save lasting facts and decisions here as they work.</p>}
      <ul className="flex flex-col gap-1 empty:hidden">
        <AnimatePresence initial={false}>
          {entries.map((m) => (
            <MemoryRow
              key={m.memoryId} entry={m} meta={sourceLine(m, now)} fresh={fresh.has(m.memoryId)}
              draft={editing?.id === m.memoryId ? editing.text : undefined}
              canEdit={!archived} onEdit={() => setEditing({ id: m.memoryId, text: m.text })} onCancel={() => setEditing(null)}
              onSave={(text) => save(m, text)} onDelete={() => setDeleting(m)}
            />
          ))}
        </AnimatePresence>
      </ul>
      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="Delete this memory?">
        {deleting && (
          <Confirm action="Delete" onCancel={() => setDeleting(null)} onConfirm={async () => remove(deleting)}>
            Agents won&apos;t see it in their next runs.
          </Confirm>
        )}
      </Modal>
    </section>
  );
}

/** `draft`: the text in the open editor, if this row is being edited. */
function MemoryRow({ entry, meta, fresh, draft, canEdit, onEdit, onCancel, onSave, onDelete }: {
  entry: MemoryEntry; meta: string; fresh: boolean; draft?: string; canEdit: boolean;
  onEdit: () => void; onCancel: () => void; onSave: (text: string) => void; onDelete: () => void;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.li
      aria-label={entry.text}
      initial={fresh && !reduced ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0, transition: instant } : { opacity: 0, height: 0, transition: { duration: 0.18, ease: easeOut } }}
      transition={{ duration: 0.22, ease: easeOut }}
      className="group relative isolate overflow-hidden rounded-[10px] px-2 py-2 hover:bg-surface-2 focus-within:bg-surface-2"
    >
      {fresh && !reduced && (
        <motion.span
          aria-hidden="true" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: 0.5, ease: easeOut }}
          className="absolute inset-0 -z-10 bg-[rgba(200,241,105,.10)]"
        />
      )}
      <AnimatePresence mode="wait" initial={false}>
        {draft !== undefined
          ? <motion.div key="edit" {...swap}><EditMemory draft={draft} saved={entry.text} onCancel={onCancel} onSave={onSave} /></motion.div>
          : (
            <motion.div key="view" {...swap} className="flex gap-1.5">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="whitespace-pre-wrap break-words text-[13px] leading-snug">{entry.text}</p>
                <p className="relative flex items-center gap-1 text-[11px] text-text-3">
                  {entry.private && <Hint below text={PRIVATE_HINT} mark={<Lock aria-hidden="true" size={11} className="text-text-3" />} />}
                  <span suppressHydrationWarning className="truncate">{meta}</span>
                </p>
              </div>
              {canEdit && (
                <span className="-mr-1 -mt-0.5 flex shrink-0 self-start">
                  <RowButton label="Edit memory" onClick={onEdit}><Pencil aria-hidden="true" size={13} /></RowButton>
                  <RowButton label="Delete memory" onClick={onDelete}><Trash2 aria-hidden="true" size={13} /></RowButton>
                </span>
              )}
            </motion.div>
          )}
      </AnimatePresence>
    </motion.li>
  );
}

function EditMemory({ draft, saved, onCancel, onSave }: { draft: string; saved: string; onCancel: () => void; onSave: (text: string) => void }) {
  const [text, setText] = useState(draft);
  const trimmed = text.trim();

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    // Handled here, so the phone overlay around the panel stays open.
    e.preventDefault();
    onCancel();
  }

  return (
    <div className="flex flex-col gap-2" onKeyDown={onKeyDown}>
      <textarea
        autoFocus aria-label="Memory" rows={3} maxLength={MEMORY_CHARS} value={text} onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.setSelectionRange(e.target.value.length, e.target.value.length)}
        className={`${panelInput} resize-none py-2 leading-snug`}
      />
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] tabular-nums text-text-3">{text.length}/{MEMORY_CHARS}</span>
        <Button onClick={onCancel} size="sm" className="ml-auto">Cancel</Button>
        <Button variant="primary" onClick={() => onSave(trimmed)} disabled={!trimmed || trimmed === saved} size="sm">Save</Button>
      </div>
    </div>
  );
}
