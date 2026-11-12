"use client";

import { useEffect, useState } from "react";
import { bffOrNull, errorText } from "@/lib/client/bff";
import type { GeneratedImage as Image } from "@/lib/types";

/** Signed links last an hour; signing again a little sooner keeps the full-size link working in a thread left open. */
const RESIGN_MS = 50 * 60_000;

/**
 * An image a run made, from the room's files. Its box has the image's shape before a byte arrives, so nothing below
 * it moves when it loads, and the picture fades in once it has decoded. Clicking opens it full size in a new tab.
 */
export function GeneratedImage({ roomId, image }: { roomId: string; image: Image }) {
  // The picture keeps its first URL, so signing the link again doesn't download it again.
  const [src, setSrc] = useState<string>();
  const [href, setHref] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let current = true;
    let signed = false;
    const sign = () =>
      bffOrNull<{ url: string }>(`/bff/api/rooms/${roomId}/files/download?path=${encodeURIComponent(image.path)}&inline=1`)
        .then((r) => {
          if (!current) return;
          if (!r) return setProblem("This image is no longer in the room's files.");
          signed = true;
          setHref(r.url);
          setSrc((first) => first ?? r.url);
        })
        // A later signing that fails for a moment leaves the picture up; the link keeps working until its hour is out.
        .catch((e) => current && !signed && setProblem(errorText(e)));
    sign();
    const timer = setInterval(sign, RESIGN_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [roomId, image.path]);

  const box = "relative block w-full max-w-[360px] overflow-hidden rounded-xl border border-line bg-surface-2";
  const style = { aspectRatio: image.aspect.replace(":", "/") };

  if (problem || !src) {
    return (
      <div style={style} className={`${box} grid place-items-center p-4`}>
        {problem && <p className="text-center text-[13px] text-text-3">{problem}</p>}
      </div>
    );
  }
  return (
    <a
      href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${image.path}`} style={style}
      className={`${box} transition-[border-color,scale] hover:border-line-strong active:scale-[0.99]`}
    >
      <img
        src={src} alt={image.path} onLoad={() => setLoaded(true)} onError={() => setProblem("This image couldn't load.")}
        className={`size-full object-cover transition-opacity duration-300 ease-out motion-reduce:transition-none ${loaded ? "opacity-100" : "opacity-0"}`}
      />
    </a>
  );
}
