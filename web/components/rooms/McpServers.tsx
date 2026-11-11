"use client";

import { useState, type FormEvent, type InputHTMLAttributes } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDown, Server } from "lucide-react";
import { bff, errorText } from "@/lib/client/bff";
import { markFlowStarted } from "@/lib/client/flow-return";
import { keptLine, toolLabel } from "@/lib/client/mcp";
import { dur, easeOut, instant } from "@/lib/motion";
import type { McpConnection } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { panelInput } from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/overlays/Toast";

type Answer = { authorizeUrl: string } | { connection: McpConnection };

/**
 * The room's remote MCP servers. Every member sees them and what each tool may do; admins add, reconnect, refresh and
 * remove them. One change runs at a time, and `busy` names it: "add", or the action and the row, such as "refresh test".
 */
export function McpServers({ roomId, servers, manage, onChange }: {
  roomId: string; servers: McpConnection[]; manage: boolean; onChange: (servers: McpConnection[]) => void;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const base = `/bff/api/rooms/${roomId}/connections/mcp`;

  const put = (c: McpConnection) =>
    onChange(servers.some((s) => s.name === c.name) ? servers.map((s) => (s.name === c.name ? c : s)) : [...servers, c]);

  /** Returns true when the browser is leaving for the server's sign-in, so the spinner stays until the page goes. */
  function connected(answer: Answer): boolean {
    if ("authorizeUrl" in answer) {
      markFlowStarted();
      window.location.assign(answer.authorizeUrl);
      return true;
    }
    put(answer.connection);
    setFresh(answer.connection.name);
    setAdding(false);
    toast(`Connected ${answer.connection.name}`);
    return false;
  }

  async function act(key: string, action: () => Promise<boolean | void>) {
    setBusy(key);
    try {
      if (await action()) return;
    } catch (e) {
      toast(errorText(e), "error");
    }
    setBusy(null);
  }

  const redirectUri = () => `${window.location.origin}/bff/mcp/callback`;
  const add = (name: string, url: string) => act("add", async () =>
    connected(await bff<Answer>(base, { body: { name, url, redirectUri: redirectUri() } })));
  const reconnect = (name: string) => act(`reconnect ${name}`, async () =>
    connected(await bff<Answer>(`${base}/${name}/reconnect`, { body: { redirectUri: redirectUri() } })));
  const refresh = (name: string) => act(`refresh ${name}`, async () =>
    put((await bff<{ connection: McpConnection }>(`${base}/${name}/refresh`, { body: {} })).connection));
  const remove = (name: string) => act(`remove ${name}`, async () => {
    await bff(`${base}/${name}`, { method: "DELETE", body: {} });
    onChange(servers.filter((s) => s.name !== name));
  });

  return (
    <div className="flex flex-col gap-2">
      {/* Always mounted, so the last row removed can still fold away; empty, it takes no space. */}
      <ul className="flex flex-col gap-2 empty:hidden">
        <AnimatePresence initial={false}>
          {servers.map((s) => (
            <ServerRow
              key={s.name} server={s} fresh={s.name === fresh} manage={manage} busy={busy}
              onReconnect={() => reconnect(s.name)} onRefresh={() => refresh(s.name)} onRemove={() => remove(s.name)}
            />
          ))}
        </AnimatePresence>
      </ul>
      {!manage && servers.length === 0 && <p className="text-[12.5px] text-text-3">None yet.</p>}
      {manage && (adding
        ? <AddServer busy={busy === "add"} onCancel={() => setAdding(false)} onSubmit={add} />
        : <Button onClick={() => setAdding(true)} disabled={busy !== null} className="w-full"><Server aria-hidden="true" size={14} />Add MCP server</Button>)}
    </div>
  );
}

/** A server that just connected slides in (when new) and flashes lime once; a removed one fades and folds away. */
function ServerRow({ server, fresh, manage, busy, onReconnect, onRefresh, onRemove }: {
  server: McpConnection; fresh: boolean; manage: boolean; busy: string | null;
  onReconnect: () => void; onRefresh: () => void; onRemove: () => void;
}) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const kept = keptLine(server);
  const working = (action: string) => busy === `${action} ${server.name}` && <Spinner />;
  const toolsId = `mcp-tools-${server.name}`;

  return (
    <motion.li
      aria-label={server.name}
      initial={fresh && !reduced ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0, transition: instant } : { opacity: 0, height: 0, transition: { duration: dur.fast, ease: easeOut } }}
      transition={{ duration: dur.base, ease: easeOut }}
      className="relative isolate overflow-hidden rounded-xl border border-line-strong bg-surface-2 p-3"
    >
      {fresh && !reduced && (
        <motion.span
          key={server.toolsAt} aria-hidden="true" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: dur.slow, ease: easeOut }}
          className="absolute inset-0 -z-10 bg-[rgba(200,241,105,.10)]"
        />
      )}
      <p className="flex items-center gap-2 text-[13px]">
        <Server aria-hidden="true" size={14} className="shrink-0 text-text-3" />
        <span className="font-medium">{server.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-3">{new URL(server.url).host}</span>
        {server.status === "connected"
          ? <span className="shrink-0 rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] text-text-2">connected</span>
          : <span className="shrink-0 rounded-md bg-[#2a2010] px-1.5 py-0.5 text-[11px] text-amber">needs reconnecting</span>}
      </p>
      <p className="mt-2 flex items-center gap-2 text-[12px] text-text-3">
        <button
          onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={toolsId}
          className="-mx-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-text-2 transition-colors hover:text-text"
        >
          {open ? "Hide tools" : "Show tools"}
          <ChevronDown aria-hidden="true" size={13} className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
        </button>
        {kept}
      </p>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            id={toolsId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transition: reduced ? instant : { height: { duration: dur.base, ease: easeOut }, opacity: { duration: dur.base } } }}
            exit={{ height: 0, opacity: 0, transition: reduced ? instant : { height: { duration: dur.base, ease: easeOut }, opacity: { duration: dur.fast } } }}
            className="overflow-hidden"
          >
            {server.tools.map((t) => (
              <li key={t.name} aria-label={t.name} title={t.description} className="flex items-center gap-2 pt-1.5 text-[12px]">
                <span className="min-w-0 flex-1 truncate font-mono text-text-2">{t.name}</span>
                <span className={`shrink-0 ${t.readOnly ? "text-text-3" : "text-amber"}`}>{toolLabel(t)}</span>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
      {manage && (confirming ? (
        <div className="mt-3 flex flex-col gap-2 rounded-xl border border-[#4a2a26] bg-[#150f0e] p-3">
          <p className="text-[12.5px] text-[#ffb4aa]">Remove {server.name}? Agents lose its tools at once.</p>
          <div className="flex justify-end gap-2">
            <Button autoFocus onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="danger" onClick={onRemove} disabled={busy !== null}>{working("remove")}Remove</Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={onReconnect} disabled={busy !== null} className="h-8 px-2.5 text-[12.5px]">{working("reconnect")}Reconnect</Button>
          <Button onClick={onRefresh} disabled={busy !== null} className="h-8 px-2.5 text-[12.5px]">{working("refresh")}Refresh tools</Button>
          <Button onClick={() => setConfirming(true)} disabled={busy !== null} className="h-8 px-2.5 text-[12.5px]">Remove</Button>
        </div>
      ))}
    </motion.li>
  );
}

function AddServer({ busy, onCancel, onSubmit }: { busy: boolean; onCancel: () => void; onSubmit: (name: string, url: string) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(name, url.trim());
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl border border-line-strong bg-surface-2 p-3">
      <FormField
        id="mcp-name" label="Name" autoFocus maxLength={20} autoComplete="off" autoCapitalize="none" spellCheck={false}
        hint="Lowercase letters, digits and dashes. Agents see its tools as <name> · <tool>."
        value={name} onChange={(e) => setName(e.target.value.toLowerCase())}
      />
      <FormField
        id="mcp-url" label="Server URL" type="url" inputMode="url" placeholder="https://…/mcp" autoComplete="off" spellCheck={false}
        hint="An MCP server's Streamable HTTP address. chat-lite signs in with OAuth; don't put keys in the URL."
        value={url} onChange={(e) => setUrl(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !name || !url.trim()}>{busy && <Spinner />}Connect</Button>
      </div>
    </form>
  );
}

/** A label with its "?" hint, which opens under the row: the panel is too narrow for a tip beside it. */
function FormField({ id, label, hint, ...input }: InputHTMLAttributes<HTMLInputElement> & { id: string; label: string; hint: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative flex items-center">
        <label htmlFor={id} className="text-xs font-medium text-text-3">{label}</label>
        <Hint below text={hint} />
      </div>
      <input
        id={id} {...input}
        className={`${panelInput} h-10`}
      />
    </div>
  );
}
