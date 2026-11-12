"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { List, Workflow } from "lucide-react";
import { spring } from "@/lib/motion";

/** A thread's Timeline | Map pill; the highlight glides to the view picked. A phone shows the icons only. */
export function ViewSwitch({ map }: { map: boolean }) {
  const pathname = usePathname();
  const views = [
    { label: "Timeline", href: pathname, icon: List, active: !map },
    { label: "Map", href: `${pathname}?view=map`, icon: Workflow, active: map },
  ];

  return (
    <nav aria-label="Thread view" className="flex shrink-0 rounded-[11px] border border-line bg-surface-2 p-[3px]">
      {views.map(({ label, href, icon: Icon, active }) => (
        <Link
          key={label}
          href={href}
          scroll={false}
          aria-current={active ? "page" : undefined}
          className={`relative isolate flex h-[26px] items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] transition-[color,transform] active:scale-[0.96] ${active ? "text-text" : "text-text-2 hover:text-text"}`}
        >
          {active && <motion.span layoutId="thread-view" transition={spring.glide} className="absolute inset-0 -z-10 rounded-lg bg-surface-4" />}
          <Icon aria-hidden="true" size={13} className="sm:hidden" />
          <span className="max-sm:sr-only">{label}</span>
        </Link>
      ))}
    </nav>
  );
}
