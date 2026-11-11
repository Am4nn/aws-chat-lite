import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { cut } from "../../tools/cut.js";
import type { ToolResult } from "../../tools/types.js";

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
    case "audio":
      return `[${block.type}: ${block.mimeType}]`;
    case "resource_link":
      return `[link] ${block.name} ${block.uri}`;
    case "resource":
      return "text" in block.resource ? block.resource.text : `[resource: ${block.resource.mimeType ?? "binary"}]`;
  }
}

/** A remote tool's result as text for the model; binary content is named, never inlined. */
export function toolOutput(r: CallToolResult): ToolResult {
  const text = r.content.length ? r.content.map(blockText).join("\n\n") : JSON.stringify(r.structuredContent ?? {});
  return { ok: r.isError !== true, output: cut(text) };
}
