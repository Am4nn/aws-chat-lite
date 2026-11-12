"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Download, FileText, X } from "lucide-react";
import { fileSize } from "@/lib/client/format";
import { isInlineImage } from "@/lib/client/uploads";
import { dur, easeOut, instant } from "@/lib/motion";
import type { Attachment } from "@/lib/types";
import { Spinner } from "@/components/ui/Spinner";
import type { Upload } from "./useUploads";

const PREVIEW = { width: 320, height: 240 };

/** Images preview inline; everything else is a download card. A message not yet sent shows local previews, which never expire. */
export function MessageAttachments({ attachments, onExpired }: { attachments: Attachment[]; onExpired?: () => void }) {
  if (!attachments.length) return null;
  const images = attachments.filter((a) => isInlineImage(a.type));
  const files = attachments.filter((a) => !isInlineImage(a.type));
  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {images.length > 0 && <div className="flex flex-wrap gap-2">{images.map((a) => <ImagePreview key={a.key} attachment={a} onExpired={onExpired} />)}</div>}
      {files.map((a) => <FileCard key={a.key} attachment={a} />)}
    </div>
  );
}

/**
 * Attachments carry no dimensions, so the preview reserves a fixed 4:3 box and the whole image fits inside it, never
 * cropped: nothing below moves when it loads. It fades in once decoded; a cached image may finish before hydration, hence the `complete` check.
 * A failed load is most likely its signed link expiring in a tab left open, so it asks once for a fresh link; asking
 * again for a file that is really gone would loop.
 */
function ImagePreview({ attachment: a, onExpired }: { attachment: Attachment; onExpired?: () => void }) {
  const img = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [askedAgain, setAskedAgain] = useState(false);
  useEffect(() => { if (img.current?.complete) setLoaded(true); }, []);
  return (
    <a
      href={a.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${a.name}`}
      style={{ maxWidth: PREVIEW.width }}
      className="block aspect-[4/3] w-full overflow-hidden rounded-xl border border-line bg-surface-3 transition-[border-color] hover:border-line-strong"
    >
      {a.url && (
        <img
          ref={img}
          src={a.url}
          alt={a.name}
          width={PREVIEW.width}
          height={PREVIEW.height}
          onLoad={() => setLoaded(true)}
          onError={() => {
            if (askedAgain) return;
            setAskedAgain(true);
            onExpired?.();
          }}
          className={`size-full object-contain transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
        />
      )}
    </a>
  );
}

function FileCard({ attachment: a }: { attachment: Attachment }) {
  const body = (
    <>
      <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-surface-3 text-text-2">
        <FileText aria-hidden="true" size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{a.name}</span>
        <span className="block font-mono text-[11.5px] text-text-3">{fileSize(a.size)}</span>
      </span>
      {a.url && <Download aria-hidden="true" size={15} className="shrink-0 text-text-3 transition-colors group-hover/file:text-text" />}
    </>
  );
  const className = "group/file flex w-[300px] max-w-full items-center gap-3 rounded-xl border border-line bg-surface-2 px-3 py-2.5";
  return a.url
    ? <a href={a.url} download={a.name} className={`${className} transition-[border-color] hover:border-line-strong`}>{body}</a>
    : <div className={className}>{body}</div>;
}

/** A file waiting in the composer. There is no percentage: fetch can't report upload progress, so it says only "uploading". */
export function UploadChip({ upload, onRemove }: { upload: Upload; onRemove: () => void }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      layout={!reduced}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={reduced ? instant : { duration: dur.fast, ease: easeOut }}
      className="flex h-12 w-[208px] items-center gap-2.5 rounded-xl border border-line bg-surface-3 pl-2 pr-1.5"
    >
      {upload.previewUrl
        ? <img src={upload.previewUrl} alt="" width={32} height={32} className="size-8 shrink-0 rounded-md object-cover" />
        : <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-4 text-text-2"><FileText aria-hidden="true" size={14} /></span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px]">{upload.file.name}</span>
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-text-3">
          {fileSize(upload.file.size)}
          {!upload.key && <><Spinner />uploading</>}
        </span>
      </span>
      <button
        onClick={onRemove}
        aria-label={`Remove ${upload.file.name}`}
        className="grid size-6 shrink-0 place-items-center rounded-md text-text-3 transition-colors hover:bg-surface-4 hover:text-text"
      >
        <X aria-hidden="true" size={13} />
      </button>
    </motion.div>
  );
}
