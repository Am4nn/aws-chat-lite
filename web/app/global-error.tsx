"use client";

// This replaces the root layout when that fails, so there is no stylesheet or font here: inline styles in the palette.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100dvh", display: "grid", placeItems: "center", padding: 16, background: "#0A0C0D", color: "#ECF1F0", fontFamily: "system-ui, sans-serif" }}>
        <title>chat-lite</title>
        <div role="alert" style={{ width: "100%", maxWidth: 380, display: "flex", flexDirection: "column", gap: 16, boxSizing: "border-box", padding: 20, borderRadius: 16, border: "1px solid #4A2A26", background: "#101315" }}>
          <div style={{ fontSize: 14 }}>chat-lite didn&apos;t load. Nothing was changed.</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              onClick={retry}
              style={{ height: 36, padding: "0 14px", border: 0, borderRadius: 10, background: "#C8F169", color: "#10170A", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
            >
              Try again
            </button>
            {error.digest && <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11.5, color: "#7E8A89" }}>Ref {error.digest}</span>}
          </div>
        </div>
      </body>
    </html>
  );
}
