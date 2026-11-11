"use client";

import { useEffect, useRef, useState } from "react";
import { bff, errorText } from "@/lib/client/bff";
import { applyFilesUpdate } from "@/lib/client/files";
import { useLiveEvent } from "@/lib/client/LiveProvider";
import type { RoomFile } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";

const FRESH_MS = 1500;

type Update = { files: RoomFile[]; deleted: string[] };

export type RoomFiles = {
  files: RoomFile[];
  usedBytes: number;
  /** Paths that changed in the last 1.5 s, which the list highlights. */
  fresh: Set<string>;
  uploading: number;
  upload: (files: File[]) => Promise<void>;
  remove: (path: string) => Promise<void>;
  download: (path: string) => Promise<void>;
};

/**
 * The room's files: fetched once, then kept current by `files.updated` from the socket (fetched again after a
 * reconnect, which may have missed some). Updates that land while a fetch is out are applied again on top of its
 * answer, which may have been read before them, and only the latest fetch is kept.
 */
export function useRoomFiles(roomId: string): RoomFiles {
  const toast = useToast();
  const [files, setFiles] = useState<RoomFile[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(0);
  const sinceFetch = useRef<Update[] | null>(null);
  const base = `/bff/api/rooms/${roomId}/files`;
  const [shownRoom, setShownRoom] = useState(roomId);
  if (shownRoom !== roomId) {
    setShownRoom(roomId);
    setFiles([]);
  }

  function apply(update: Update) {
    sinceFetch.current?.push(update);
    setFiles((list) => applyFilesUpdate(list, update));
    const paths = update.files.map((f) => f.path);
    setFresh((s) => new Set([...s, ...paths]));
    setTimeout(() => setFresh((s) => new Set([...s].filter((p) => !paths.includes(p)))), FRESH_MS);
  }

  async function load() {
    const updates: Update[] = [];
    sinceFetch.current = updates;
    try {
      const { files: listed } = await bff<{ files: RoomFile[] }>(base);
      if (sinceFetch.current === updates) setFiles(updates.reduce(applyFilesUpdate, listed));
    } catch (e) {
      if (sinceFetch.current === updates) toast(errorText(e), "error");
    } finally {
      if (sinceFetch.current === updates) sinceFetch.current = null;
    }
  }

  useEffect(() => { void load(); }, [roomId]);
  useLiveEvent("files.updated", (e) => { if (e.roomId === roomId) apply(e); });
  useLiveEvent("reconnected", () => { void load(); });

  async function uploadOne(file: File) {
    const type = file.type || "application/octet-stream";
    const form = await bff<{ url: string; fields: Record<string, string>; uploadKey: string }>(
      `${base}/uploads`, { body: { path: file.name, size: file.size, type } },
    );
    const body = new FormData();
    for (const [k, v] of Object.entries(form.fields)) body.append(k, v);
    body.append("file", file);
    if (!(await fetch(form.url, { method: "POST", body })).ok) throw new Error(`${file.name} didn't upload.`);
    apply({ files: [await bff<RoomFile>(base, { method: "PUT", body: { path: file.name, uploadKey: form.uploadKey } })], deleted: [] });
  }

  async function upload(picked: File[]) {
    setUploading((n) => n + picked.length);
    await Promise.all(picked.map((f) => uploadOne(f).catch((e) => toast(errorText(e), "error")).finally(() => setUploading((n) => n - 1))));
  }

  async function remove(path: string) {
    try {
      await bff(`${base}?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      apply({ files: [], deleted: [path] });
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  async function download(path: string) {
    try {
      const { url } = await bff<{ url: string }>(`${base}/download?path=${encodeURIComponent(path)}`);
      // The link answers as an attachment, so the page stays where it is.
      window.location.assign(url);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  return { files, usedBytes: files.reduce((n, f) => n + f.size, 0), fresh, uploading, upload, remove, download };
}
