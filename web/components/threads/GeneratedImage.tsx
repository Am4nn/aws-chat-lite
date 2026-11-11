"use client";

import { useEffect, useState } from "react";
import { bffOrNull, errorText } from "@/lib/client/bff";
import type { GeneratedImage as Image } from "@/lib/types";

/**
 * An image a run made, from the room's files. Its box has the image's shape before a byte arrives, so nothing below
 * it moves when it loads, and the picture fades in once it has decoded. Clicking opens it full size in a new tab.
 */
export function GeneratedImage({ roomId, image }: { roomId: string; image: Image }) {
  const [url, setUrl] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let current = true;
    bffOrNull<{ url: string }>(`/bff/api/rooms/${roomId}/files/download?path=${encodeURIComponent(image.path)}&inline=1`)
      .then((r) => current && (r ? setUrl(r.url) : setProblem("This image is no longer in the room's files.")))
      .catch((e) => current && setProblem(errorText(e)));
    return () => {
      current = false;
    };
  }, [roomId, image.path]);

  const box = "relative block w-full max-w-[360px] overflow-hidden rounded-xl border border-line bg-surface-2";
  const style = { aspectRatio: image.aspect.replace(":", "/") };

  if (!url) {
    return (
      <div style={style} className={`${box} grid place-items-center p-4`}>
        {problem && <p className="text-center text-[13px] text-text-3">{problem}</p>}
      </div>
    );
  }
  return (
    <a
      href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${image.path}`} style={style}
      className={`${box} transition-[border-color,transform] hover:border-line-strong active:scale-[0.99]`}
    >
      <img
        src={url} alt={image.path} onLoad={() => setLoaded(true)}
        className={`size-full object-cover transition-opacity duration-300 ease-out motion-reduce:transition-none ${loaded ? "opacity-100" : "opacity-0"}`}
      />
    </a>
  );
}
