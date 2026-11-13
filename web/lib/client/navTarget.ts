type ClickLike = Pick<MouseEvent, "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "target">;

/** A room page, read from its URL. */
type Place = { roomId: string; chatId?: string; threadNumber?: number; map: boolean; newThread: boolean; apps: boolean };

export type SkeletonKind = "chat" | "thread" | "map" | "new-thread" | "apps";

const keyOf = (url: URL) => url.pathname + url.search;

/**
 * Where an in-app link click is heading (path and search), or null when it isn't one the router takes over. Next's
 * Link calls preventDefault on exactly the clicks it handles, so a click it left alone opens a tab, a download or
 * another site and is no navigation of this page.
 */
export function clickTarget(e: ClickLike, here: string): string | null {
  if (!e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = e.target instanceof Element ? e.target.closest("a") : null;
  if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return null;
  const from = new URL(here);
  const to = new URL(a.href, from);
  if (to.origin !== from.origin || keyOf(to) === keyOf(from)) return null;
  return keyOf(to);
}

export function placeOf(href: string): Place | null {
  const url = new URL(href, "http://x");
  const [r, roomId, kind, id] = url.pathname.split("/").filter(Boolean);
  if (r !== "r" || !roomId) return null;
  const place: Place = { roomId, map: false, newThread: false, apps: kind === "apps" };
  if (kind === "c" && id) place.chatId = id;
  else if (kind === "t" && id === "new") place.newThread = true;
  else if (kind === "t" && id) {
    place.threadNumber = Number(id);
    place.map = url.searchParams.get("view") === "map";
  }
  return place;
}

/** The skeleton a room page shows while it loads. A bare room redirects to its first chat. */
export function skeletonKind(href: string): SkeletonKind | null {
  const place = placeOf(href);
  if (!place) return null;
  if (place.newThread) return "new-thread";
  if (place.apps) return "apps";
  if (place.threadNumber !== undefined) return place.map ? "map" : "thread";
  return "chat";
}
