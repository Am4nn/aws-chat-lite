"use client";

import { useContext, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Globe, Pencil, Plus, Trash2 } from "lucide-react";
import { agentLabel, RoomAgentsContext } from "@/lib/client/agents";
import { bff, BffError, errorText } from "@/lib/client/bff";
import { useLiveEvent } from "@/lib/client/LiveProvider";
import { cadenceLabel, canEditSchedule, nextLabel } from "@/lib/client/schedules";
import { swap } from "@/lib/motion";
import { isAdmin, type Chat, type Role, type Schedule } from "@/lib/types";
import { Confirm } from "@/components/overlays/Confirm";
import { Modal } from "@/components/overlays/Modal";
import { useToast } from "@/components/overlays/Toast";
import { Button } from "@/components/ui/Button";
import { panelInput } from "@/components/ui/Field";
import { PanelLoading } from "@/components/ui/PanelLoading";
import { RowButton } from "@/components/ui/RowButton";
import { Switch } from "@/components/ui/Switch";
import { ScheduleForm, type ScheduleInput } from "./ScheduleForm";
import { useRoomData } from "./useRoomData";

type Schedules = { schedules: Schedule[]; timeZone: string; max: number };
type Me = { userId: string; role: Role };

/**
 * Agent runs on a clock: each fire opens a new thread and posts its card in a chat. Any member adds one; its creator
 * or an admin changes, pauses or deletes it. Times are on the room's clock, which admins set. The server's list is the
 * truth (it works out each next fire), fetched again whenever schedules change.
 */
export function SchedulesPanel({ roomId, me, chats, archived }: { roomId: string; me: Me; chats: Chat[]; archived: boolean }) {
  const toast = useToast();
  const agents = useContext(RoomAgentsContext);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/bff/api/rooms/${roomId}/schedules`;
  const { data, setData, failed, reload: refetch } = useRoomData<Schedules>(base);
  useLiveEvent("schedules.changed", (e) => {
    if (e.roomId === roomId) refetch();
  });

  const put = (s: Schedule) => setData((d) => d && { ...d, schedules: d.schedules.map((x) => (x.scheduleId === s.scheduleId ? s : x)) });

  async function save(schedule: Schedule | undefined, input: ScheduleInput) {
    setBusy(true);
    try {
      if (schedule) await bff(`${base}/${schedule.scheduleId}`, { method: "PATCH", body: input });
      else await bff(base, { body: input });
      setEditing(null);
      refetch();
    } catch (e) {
      toast(errorText(e), "error");
      // A 503 on create means the schedule was saved but left off: its row is there to switch on, and a second
      // press would make a copy.
      if (!schedule && e instanceof BffError && e.status === 503) {
        setEditing(null);
        refetch();
      }
    } finally {
      setBusy(false);
    }
  }

  /** Moves at once; a refusal (Scheduler unreachable, say) moves it back with the reason. */
  async function toggle(s: Schedule) {
    put({ ...s, enabled: !s.enabled });
    try {
      put((await bff<{ schedule: Schedule }>(`${base}/${s.scheduleId}`, { method: "PATCH", body: { enabled: !s.enabled } })).schedule);
    } catch (e) {
      put(s);
      toast(errorText(e), "error");
    }
  }

  async function remove(s: Schedule) {
    try {
      await bff(`${base}/${s.scheduleId}`, { method: "DELETE", body: {} });
      setDeleting(null);
      refetch();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  async function setTimeZone(timeZone: string) {
    try {
      const res = await bff<{ timeZone: string }>(`/bff/api/rooms/${roomId}/timezone`, { method: "PUT", body: { timeZone } });
      setData((d) => d && { ...d, timeZone: res.timeZone });
      refetch();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  if (!data) return <PanelLoading failed={failed} onRetry={refetch} />;
  const { schedules, timeZone, max } = data;
  const form = (s?: Schedule) => (
    <ScheduleForm initial={s} agents={agents} chats={chats} busy={busy} onCancel={() => setEditing(null)} onSubmit={(input) => save(s, input)} />
  );

  return (
    <section className="flex flex-col gap-2">
      <div className="flex h-8 items-center gap-2">
        <span className="font-mono text-[11.5px] text-text-3">{schedules.length} of {max}</span>
        {!archived && schedules.length < max && editing !== "new" && (
          <Button onClick={() => setEditing("new")} size="sm" className="ml-auto"><Plus aria-hidden="true" size={14} />New</Button>
        )}
      </div>
      <TimeZoneRow timeZone={timeZone} canSet={isAdmin(me.role) && !archived} onSet={setTimeZone} />
      {editing === "new" && form()}
      {schedules.length === 0 && editing !== "new" && (
        <p className="text-[12.5px] text-text-3">None yet. A schedule runs an agent on a clock, such as a digest every morning.</p>
      )}
      <ul className="flex flex-col gap-1 empty:hidden">
        {schedules.map((s) => {
          const canEdit = !archived && canEditSchedule(s, me);
          return (
            <li key={s.scheduleId}>
              <AnimatePresence mode="wait" initial={false}>
                {editing === s.scheduleId
                  ? <motion.div key="form" {...swap}>{form(s)}</motion.div>
                  : (
                    <motion.div key="row" {...swap} className="group flex items-start gap-2 rounded-[10px] px-2 py-2 hover:bg-surface-2 focus-within:bg-surface-2">
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <p className="truncate text-[13px] font-medium">{s.title}</p>
                        <p className="truncate text-[11.5px] text-text-3">
                          <span className="font-mono">{agentLabel(s.agentId, agents)}</span> · {cadenceLabel(s.cadence)}
                        </p>
                        {s.enabled && s.nextAt && <p className="font-mono text-[11px] text-text-2">{nextLabel(s.nextAt, timeZone)}</p>}
                        {s.lastRun?.skipped && <p className="text-[11.5px] text-amber">{s.lastRun.skipped}</p>}
                      </div>
                      {canEdit && (
                        <>
                          <RowButton label={`Edit ${s.title}`} onClick={() => setEditing(s.scheduleId)}><Pencil aria-hidden="true" size={13} /></RowButton>
                          <RowButton label={`Delete ${s.title}`} onClick={() => setDeleting(s)}><Trash2 aria-hidden="true" size={13} /></RowButton>
                        </>
                      )}
                      {canEdit
                        ? <Switch on={s.enabled} label={`${s.title} on`} onToggle={() => toggle(s)} className="mt-1.5" />
                        : <span className="mt-1 font-mono text-[11.5px] text-text-3">{s.enabled ? "on" : "off"}</span>}
                    </motion.div>
                  )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>
      <Modal open={!!deleting} onClose={() => setDeleting(null)} title={`Delete ${deleting?.title}?`}>
        {deleting && (
          <Confirm action="Delete schedule" onCancel={() => setDeleting(null)} onConfirm={() => remove(deleting)}>
            It stops running. The threads it already opened stay.
          </Confirm>
        )}
      </Modal>
    </section>
  );
}

/**
 * Every zone the browser knows; the server checks the pick and stores it exactly as given. Browsers list some zones
 * under older names (Asia/Calcutta for Asia/Kolkata), so the room's own zone is added in case it isn't listed.
 */
function TimeZoneRow({ timeZone, canSet, onSet }: { timeZone: string; canSet: boolean; onSet: (tz: string) => void }) {
  const zones = canSet ? [...new Set([...Intl.supportedValuesOf("timeZone"), timeZone])].sort() : [];
  return (
    <div className="flex h-8 items-center gap-2 text-xs text-text-2">
      <Globe aria-hidden="true" size={13} className="shrink-0 text-text-3" />
      {canSet
        ? (
          <>
            <label htmlFor="room-time-zone" className="shrink-0">Times in</label>
            <select
              id="room-time-zone" value={timeZone} onChange={(e) => onSet(e.target.value)}
              className={`${panelInput} h-8 min-w-0 flex-1 font-mono text-xs`}
            >
              {zones.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </>
        )
        : <span>Times in <span className="font-mono text-text">{timeZone}</span></span>}
    </div>
  );
}
