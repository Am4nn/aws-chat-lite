type SseFrame = { id: string; event: string; data: string };

export function createSseParser() {
  let buffer = "";
  return {
    push(chunk: string): SseFrame[] {
      buffer = (buffer + chunk).replace(/\r\n/g, "\n");
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      const frames: SseFrame[] = [];
      for (const part of parts) {
        const frame: SseFrame = { id: "", event: "message", data: "" };
        let any = false;
        for (const line of part.split("\n")) {
          if (line.startsWith(":")) continue;
          const i = line.indexOf(":");
          if (i < 0) continue;
          const field = line.slice(0, i);
          const value = line.slice(i + 1).replace(/^ /, "");
          if (field === "id") frame.id = value;
          else if (field === "event") frame.event = value;
          else if (field === "data") frame.data += (frame.data ? "\n" : "") + value;
          else continue;
          any = true;
        }
        if (any) frames.push(frame);
      }
      return frames;
    },
  };
}
