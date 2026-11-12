/** The app's mark and name, at the top of pages that stand outside a room. */
export function Brand() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-9 place-items-center rounded-[10px] bg-lime font-display text-lg font-bold text-lime-ink">c</span>
      <span className="font-display text-xl font-bold">chat-lite</span>
    </div>
  );
}
