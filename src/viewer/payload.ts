// The JSON the Swift side (ReviewKit ReviewView.ReviewPayload) writes and Apollo
// attaches to the ClickUp task. This web viewer reads it from `?d=<jsonURL>`.
// Keep in sync with apollo-review-swift/Sources/ReviewKit/ReviewView.swift.

import type { MediaKind, ReviewComment } from "../contract/model";

export interface ReviewPayload {
  taskId: string;
  listId?: string | null;
  attachmentId: string;
  commentId?: string | null;
  uploaderId?: number | null;
  status: string; // in_review | changes_requested | approved
  summaryText: string;
  mediaUrl: string;
  ext: string;
  mediaTitle: string;
  comments: ReviewComment[];
}

/** Decode an inline review payload carried in the URL (`?z=<gzip+base64url>`).
 *  Mirrors ReviewKit's ReviewHandoff.encode (zlib + base64url). No network
 *  fetch — so it works cross-origin (the ClickUp CDN doesn't send CORS). */
export async function decodeInlinePayload(z: string): Promise<ReviewPayload> {
  const packed = b64urlToBytes(z);
  let jsonBytes: Uint8Array;
  try {
    jsonBytes = await inflate(packed);
  } catch {
    jsonBytes = packed; // wasn't compressed
  }
  return JSON.parse(new TextDecoder().decode(jsonBytes)) as ReviewPayload;
}

/** Encode a review payload for an inline `?z=` link (zlib + base64url), the
 *  inverse of decodeInlinePayload. Matches ReviewKit's ReviewHandoff so the
 *  link opens in both the web viewer and Apollo's native reopen. */
export async function encodeInlinePayload(payload: ReviewPayload): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const packed = await deflate(json);
  return bytesToB64url(packed);
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  // RAW deflate (RFC 1951) — matches Apple's NSData.compressed(.zlib), which is
  // raw deflate despite the name (NOT the zlib RFC 1950 wrapper). Using "deflate"
  // here would add a zlib header that ReviewKit's ReviewHandoff can't decode.
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  // Swift's NSData.compressed(.zlib) is RAW deflate (RFC 1951) → "deflate-raw"
  // first; keep "deflate"/"gzip" as fallbacks for older/other encoders.
  for (const fmt of ["deflate-raw", "deflate", "gzip"] as const) {
    try {
      const stream = new Blob([bytes as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream(fmt));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      /* try next format */
    }
  }
  throw new Error("inflate failed");
}

/** Derive the media kind from a file extension (no leading dot needed). */
export function mediaKindFor(ext: string): MediaKind {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (["mp4", "mov", "m4v", "webm", "avi", "mkv"].includes(e)) return "video";
  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff"].includes(e))
    return "image";
  if (["mp3", "wav", "m4a", "aac", "flac", "ogg"].includes(e)) return "audio";
  return "document";
}

/** mm:ss (or h:mm:ss) from milliseconds. */
export function fmtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** Human label for a comment anchor, e.g. "0:12", "0:12–0:15", "p.3", "—". */
export function anchorLabel(c: ReviewComment): string {
  const a = c.anchor;
  switch (a.kind) {
    case "video":
      return a.endMs != null && a.endMs > a.timeMs
        ? `${fmtTime(a.timeMs)}–${fmtTime(a.endMs)}`
        : fmtTime(a.timeMs);
    case "document":
      return `p.${a.page}`;
    default:
      return "—";
  }
}

/** Status pill label + accent class. */
export function statusInfo(status: string): { label: string; tone: string } {
  switch (status) {
    case "approved":
      return { label: "Aprovado", tone: "ok" };
    case "changes_requested":
      return { label: "Pede alterações", tone: "warn" };
    default:
      return { label: "Em revisão", tone: "review" };
  }
}
