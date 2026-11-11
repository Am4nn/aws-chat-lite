import { ImageResponse } from "next/og";

// A ring with its right side open, so the mark is a bold lowercase "c" without shipping a font to the icon routes.
const RADIUS = 22;
const ARC = 2 * Math.PI * RADIUS;
const GAP = ARC * 0.3;

/** The app's mark, a lime "c" on ink, as a PNG of any size for the home screen and the browser tab. */
export function appIcon(size: number) {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#0A0C0D" }}>
        <svg width={size} height={size} viewBox="0 0 100 100">
          <circle
            cx="50" cy="50" r={RADIUS} fill="none" stroke="#C8F169" strokeWidth="11" strokeLinecap="round"
            strokeDasharray={`${ARC - GAP} ${GAP}`} strokeDashoffset={-GAP / 2}
          />
        </svg>
      </div>
    ),
    { width: size, height: size },
  );
}
