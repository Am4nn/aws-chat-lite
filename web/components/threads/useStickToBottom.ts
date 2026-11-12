import { useCallback, useLayoutEffect, useRef, useState } from "react";

const PINNED_PX = 40;

/**
 * Keeps the newest content in view while I'm at the bottom, as steps and words arrive. Scrolled up, the browser's own
 * scroll anchoring holds what I'm reading in place when content above it changes size.
 */
export function useStickToBottom() {
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastTop = useRef(0);
  const [atBottom, setAtBottom] = useState(true);

  useLayoutEffect(() => {
    const el = ref.current!;
    el.scrollTop = el.scrollHeight;
    const follow = () => { if (pinned.current) el.scrollTop = el.scrollHeight; };
    const observer = new ResizeObserver(follow);
    observer.observe(el);
    observer.observe(content.current!);
    return () => observer.disconnect();
  }, []);

  // Only my own move upwards lets go of the bottom, so a smooth scroll down to it never flickers "unpinned" on the way.
  const onScroll = useCallback(() => {
    const el = ref.current!;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_PX) pinned.current = true;
    else if (el.scrollTop < lastTop.current) pinned.current = false;
    lastTop.current = el.scrollTop;
    setAtBottom(pinned.current);
  }, []);

  const toBottom = useCallback((smooth = false) => {
    pinned.current = true;
    setAtBottom(true);
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  }, []);

  return { ref, content, atBottom, onScroll, toBottom };
}
