/** An arc that turns. It says "working" without pretending to know how far along the work is. */
export function Spinner() {
  return (
    <svg aria-hidden="true" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="animate-spin motion-reduce:animate-none">
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}
