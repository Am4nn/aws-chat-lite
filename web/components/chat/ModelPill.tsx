"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronDown, Lock } from "lucide-react";
import { bff, errorText } from "@/lib/client/bff";
import { nextEnabled, pickMenu, pillLabel, shownPick } from "@/lib/client/models";
import { useModels } from "@/lib/client/ModelsProvider";
import { useClickOutside } from "@/lib/client/useClickOutside";
import { useEscape } from "@/lib/client/useEscape";
import { useIsPhone } from "@/lib/client/useIsPhone";
import { easeOut, instant } from "@/lib/motion";
import type { ModelPick, TaintSource } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";

const LOCKED_HINT = "The running agent keeps its model.";
const PRIVATE_HINT = "It has attachments. Private content never goes to DeepSeek.";

/**
 * The composer's model choice. `value`: the chat's own pick, if it has one; without it the pill shows what the room
 * default resolves to. `taint`: the thread's, which turns DeepSeek off. `locked`: a run is live here, and a run keeps
 * the model it started with.
 */
export function ModelPill({ value, onChange, taint, locked = false }: {
  value?: ModelPick; onChange: (pick: ModelPick) => void; taint: TaintSource[]; locked?: boolean;
}) {
  const reduced = useReducedMotion();
  const toast = useToast();
  const phone = useIsPhone();
  const { roomId, models, roomDefault, canSetDefault } = useModels();
  const shown = shownPick(models, value, roomDefault, taint);
  const menu = pickMenu(models, { value: shown, roomDefault, taint, isAdmin: canSetDefault });
  // The room-default button is the last arrow stop after the model rows.
  const stops = menu.canSetDefault ? [...menu.items, { disabled: false }] : menu.items;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  useClickOutside(root, open, () => close(false));
  useEscape(open, () => close(true));

  // Focus moves into the menu once it has mounted.
  useEffect(() => {
    if (open) items.current[active]?.focus();
  }, [open]);

  function focusItem(i: number) {
    setActive(i);
    items.current[i]?.focus();
  }

  function toggle() {
    if (locked) return;
    if (open) return close(false);
    const selected = menu.items.findIndex((i) => i.selected && !i.disabled);
    setActive(selected >= 0 ? selected : nextEnabled(menu.items, -1, 1));
    setOpen(true);
  }

  function choose(pick: ModelPick) {
    onChange(pick);
    close(true);
  }

  async function makeDefault() {
    close(true);
    try {
      // The room hears room.updated, which brings the new default to every member's pill, this one included.
      await bff(`/bff/api/rooms/${roomId}/model`, { method: "PUT", body: { model: shown } });
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      focusItem(nextEnabled(stops, active, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter" && document.activeElement === items.current[active]) {
      e.preventDefault();
      items.current[active]!.click();
    } else if (e.key === "Tab") {
      close(false);
    }
  }

  const fade = reduced ? instant : { duration: 0.15, ease: easeOut };
  const label = pillLabel(models, shown, phone);

  return (
    <div ref={root} className="relative shrink-0 self-center">
      <button
        ref={button}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={locked || undefined}
        aria-label={`Model: ${label}`}
        title={locked ? LOCKED_HINT : undefined}
        className={`flex h-[30px] items-center gap-[7px] rounded-[10px] border border-transparent bg-[#161B1D] px-3 text-[12.5px] text-[#C9D3D2] transition-[color,transform] ${locked ? "cursor-default opacity-60" : "hover:text-[#ECF1F0] active:scale-[0.96]"}`}
      >
        {label}
        <ChevronDown aria-hidden="true" size={11} strokeWidth={2.4} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            aria-label="Model"
            onKeyDown={onKeyDown}
            initial={reduced ? false : { opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, transition: reduced ? instant : { duration: 0.15 } }}
            transition={reduced ? instant : { duration: 0.18, ease: easeOut }}
            style={{ transformOrigin: "bottom right" }}
            className="absolute bottom-full right-0 z-30 mb-2 w-[min(280px,calc(100vw-32px))] rounded-xl border border-[#22282B] bg-[#111416] p-1 shadow-[0_16px_40px_rgba(0,0,0,.5)]"
          >
            {menu.privateNote && (
              <p className="flex h-8 items-center gap-2 px-2.5 text-[12px] text-text-3">
                <Lock aria-hidden="true" size={12} className="shrink-0" />
                Private thread: DeepSeek is off
                <span role="img" aria-label={PRIVATE_HINT} title={PRIVATE_HINT} className="ml-auto grid size-4 place-items-center rounded-full border border-line-strong text-[10px]">?</span>
              </p>
            )}
            {menu.items.map((item, i) => (
              <button
                key={item.pick}
                ref={(el) => { items.current[i] = el; }}
                role="menuitemradio"
                aria-checked={item.selected}
                aria-disabled={item.disabled || undefined}
                tabIndex={i === active ? 0 : -1}
                onClick={() => !item.disabled && choose(item.pick)}
                onMouseEnter={() => !item.disabled && setActive(i)}
                className={`flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left outline-none transition-colors ${item.disabled ? "cursor-default opacity-45" : "hover:bg-surface-3 focus-visible:bg-surface-3"}`}
              >
                <span className="text-[13px] text-text">{item.label}</span>
                {item.isDefault && <span className="font-mono text-[10.5px] text-text-3">default</span>}
                <span className="ml-auto font-mono text-[11px] text-text-3">{item.price}</span>
                <span className="grid w-3.5 place-items-center text-lime">
                  <AnimatePresence initial={false}>
                    {item.selected && (
                      <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
                        <Check aria-hidden="true" size={13} strokeWidth={2.4} />
                      </motion.span>
                    )}
                  </AnimatePresence>
                </span>
              </button>
            ))}
            {menu.canSetDefault && (
              <button
                ref={(el) => { items.current[menu.items.length] = el; }}
                role="menuitem"
                tabIndex={active === menu.items.length ? 0 : -1}
                onClick={makeDefault}
                onMouseEnter={() => setActive(menu.items.length)}
                className="mt-1 flex h-9 w-full items-center rounded-lg border-t border-line px-2.5 text-left text-[12.5px] text-text-2 outline-none transition-[color,background,transform] hover:bg-surface-3 hover:text-text focus-visible:bg-surface-3 focus-visible:text-text active:scale-[0.98]"
              >
                Make {pillLabel(models, shown, false)} the room default
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
