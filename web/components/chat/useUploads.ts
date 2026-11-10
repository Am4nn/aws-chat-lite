"use client";

import { useState } from "react";
import { errorText } from "@/lib/client/bff";
import { isInlineImage, screenFiles, uploadFile } from "@/lib/client/uploads";
import type { Attachment } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";

export type Upload = { id: string; file: File; type: string; previewUrl?: string; key?: string; abort: AbortController };

/** Files attached in the composer: each starts uploading the moment it's added, so sending rarely has to wait. */
export function useUploads(roomId: string) {
  const toast = useToast();
  const [uploads, setUploads] = useState<Upload[]>([]);

  function remove(id: string) {
    const u = uploads.find((x) => x.id === id);
    u?.abort.abort();
    if (u?.previewUrl) URL.revokeObjectURL(u.previewUrl);
    setUploads((list) => list.filter((x) => x.id !== id));
  }

  function add(files: File[]) {
    const { accepted, errors } = screenFiles(files, uploads.length);
    errors.forEach((e) => toast(e, "error"));
    const added = accepted.map((file): Upload => {
      const type = file.type || "application/octet-stream";
      return { id: crypto.randomUUID(), file, type, previewUrl: isInlineImage(type) ? URL.createObjectURL(file) : undefined, abort: new AbortController() };
    });
    setUploads((list) => [...list, ...added]);
    for (const u of added) {
      uploadFile(roomId, u.file, u.abort.signal).then(
        (key) => setUploads((list) => list.map((x) => (x.id === u.id ? { ...x, key } : x))),
        (e) => {
          if (u.abort.signal.aborted) return;
          toast(errorText(e), "error");
          setUploads((list) => list.filter((x) => x.id !== u.id));
        },
      );
    }
  }

  /** Hands the finished uploads to a message and empties the composer. Previews travel along for the pending row. */
  function take(): Attachment[] {
    setUploads([]);
    return uploads.map((u) => ({ key: u.key!, name: u.file.name, size: u.file.size, type: u.type, url: u.previewUrl }));
  }

  return { uploads, add, remove, take, busy: uploads.some((u) => !u.key) };
}
