/** Whether the reader hid the sidebar, kept in a cookie so the server renders it hidden and the page never jumps. */
export const NAV_COOKIE = "cl-nav";

export function saveNavCollapsed(collapsed: boolean) {
  document.cookie = `${NAV_COOKIE}=${collapsed ? "collapsed" : "open"}; path=/; max-age=31536000; samesite=lax`;
}
