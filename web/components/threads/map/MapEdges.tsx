"use client";

import { motion, useReducedMotion } from "motion/react";
import type { MapEdge } from "@/lib/client/runMap";

const DRAW = { duration: 0.6, ease: [0.4, 0, 0.2, 1] } as const;
// The theme's sky, line and amber, written out: the end-to-end check finds a hand-off by its stroke="#7CC7FF".
const COLOR = { flow: "#34403F", helper: "#7CC7FF", waiting: "#FFC46B", waits: "#2C3437" };

/**
 * The Map's edges, drawn under its cards. Each draws itself in when it appears; a hand-off to or from a helper is sky,
 * the edge into a step waiting on a member flows amber, and a dotted arc marks a lane waiting for its helper. Under
 * reduced motion they are simply there, the waiting edge's dashes still. A page shows one Map, so the ids are fixed.
 */
export function MapEdges({ edges, width, height, delayOf }: { edges: MapEdge[]; width: number; height: number; delayOf: (nodeId: string) => number }) {
  const reduced = useReducedMotion();

  return (
    <svg aria-hidden="true" width={width} height={height} className="pointer-events-none absolute left-0 top-0" fill="none" strokeLinecap="round" strokeWidth={1.6}>
      <defs>
        {(["flow", "helper"] as const).map((kind) => (
          <marker key={kind} id={`map-${kind}`} viewBox="0 0 6 6" refX="3" refY="3" markerWidth="6" markerHeight="6">
            <circle cx="3" cy="3" r="2.4" fill={kind === "flow" ? "#4A5557" : COLOR.helper} />
          </marker>
        ))}
      </defs>
      {edges.map((e) => {
        const key = `${e.from}>${e.to}`;
        const delay = delayOf(e.to);
        if (e.waitsForHelper) {
          return (
            <motion.g key={key} initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay }}>
              <path id={`map-arc-${e.from}-${e.to}`} d={e.d} stroke={COLOR.waits} strokeDasharray="1 6" />
              <text dy={-6} className="fill-text-4 font-mono text-[10.5px]">
                <textPath href={`#map-arc-${e.from}-${e.to}`} startOffset="50%" textAnchor="middle">waits for helper</textPath>
              </text>
            </motion.g>
          );
        }
        if (e.waiting) {
          return (
            <motion.path
              key={key} d={e.d} stroke={COLOR.waiting} strokeDasharray="4 4"
              animate={reduced ? undefined : { strokeDashoffset: [0, -16] }}
              transition={{ duration: 0.9, ease: "linear", repeat: Infinity }}
            />
          );
        }
        const kind = e.helper ? "helper" : "flow";
        return (
          <motion.path
            key={key} d={e.d} stroke={COLOR[kind]} markerEnd={`url(#map-${kind})`}
            initial={reduced ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ ...DRAW, delay }}
          />
        );
      })}
    </svg>
  );
}
