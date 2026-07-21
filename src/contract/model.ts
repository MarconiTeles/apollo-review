// Shared data model — the contract between the review app (this Tauri/React
// project), the Cloudflare KV backend, and the Apollo (Swift) side.
//
// State is stored as ONE JSON blob per attachment in Cloudflare KV (see
// worker/clickup-proxy.js). Mirror any change here in:
//   - worker/clickup-proxy.js    (KV blob shape + ClickUp mapping)
//   - src/contract/urlscheme.ts  (how Apollo opens a review)
//   - the Swift Codable structs on the Apollo side (condensed panel)

/** What kind of asset is under review. Derived from the file extension. */
export type MediaKind = "video" | "image" | "document" | "audio";

/** Lifecycle of a whole review session. */
export type ReviewStatus = "in_review" | "changes_requested" | "approved";

// ── Anchors ──────────────────────────────────────────────────────────────
// Where a comment is pinned on the asset. Discriminated by `kind`.

export interface VideoAnchor {
  kind: "video";
  /** Position in the timeline, milliseconds. Source of truth. For a range
   *  comment this is the start (in point). */
  timeMs: number;
  /** Resolved frame index when fps is known. Optional, derived. */
  frame?: number;
  /** End of the span for a RANGE comment (out point). Absent = point comment. */
  endMs?: number;
  endFrame?: number;
}
export interface ImageAnchor {
  kind: "image";
}
export interface DocumentAnchor {
  kind: "document";
  /** 1-based page number. */
  page: number;
}
/** Unanchored — a general note about the asset, not a point in time/page. */
export interface GeneralAnchor {
  kind: "general";
}

export type Anchor =
  | VideoAnchor
  | ImageAnchor
  | DocumentAnchor
  | GeneralAnchor;

// ── Annotations (vector markup) ──────────────────────────────────────────
// All coordinates are NORMALIZED to [0..1] relative to the asset's intrinsic
// width/height (or the page box for documents), so markup scales with any
// display size and any future re-encode of the same content.

export type AnnotationShape =
  | "rect"
  | "ellipse"
  | "arrow"
  | "line"
  | "freehand"
  | "text"
  | "textBox";

export interface RectGeom {
  shape: "rect" | "ellipse";
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface SegmentGeom {
  shape: "arrow" | "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface FreehandGeom {
  shape: "freehand";
  points: Array<{ x: number; y: number }>;
}
export interface TextGeom {
  shape: "text";
  x: number;
  y: number;
  text: string;
}
/** Movable + resizable speech-bubble. `text` IS the comment body
 *  (auto-saved on every edit) and `tailX`/`tailY` is the dialogue
 *  tail's tip — initially the click point, re-aimable by the user. */
export interface TextBoxGeom {
  shape: "textBox";
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  tailX: number;
  tailY: number;
}

export type AnnotationGeom =
  | RectGeom
  | SegmentGeom
  | FreehandGeom
  | TextGeom
  | TextBoxGeom;

export interface Annotation {
  id: string;
  commentId: string;
  color: string; // hex, e.g. "#7C5CFF"
  strokeWidth: number; // in normalized units (× asset width)
  geom: AnnotationGeom;
}

// ── Comments ─────────────────────────────────────────────────────────────

export interface ReviewComment {
  id: string;
  reviewId: string;
  versionId: string;
  authorClickupId: number;
  authorName: string;
  body: string;
  anchor: Anchor;
  /** Reply threading. null = top-level comment. */
  parentId: string | null;
  resolved: boolean;
  /** Checkbox attribution: who ticked this item done (display name — the web
   *  reviewer/executor has no ClickUp login) and when. Null while open. */
  resolvedByName?: string | null;
  resolvedAt?: string | null;
  /** Vector markup attached to this comment (drawn at its anchor). */
  annotations: Annotation[];
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

// ── Versions ─────────────────────────────────────────────────────────────

export interface ReviewVersion {
  id: string;
  reviewId: string;
  /** Human label, e.g. "V1". */
  label: string;
  /** Where the media lives — a ClickUp attachment URL in V1. */
  mediaUrl: string;
  mediaTitle: string;
  mediaKind: MediaKind;
  /** Video-only: frames per second, for frame-accurate anchoring. */
  fps: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  /** Document-only: total page count. */
  pageCount: number | null;
  createdByClickupId: number;
  createdAt: string;
}

// ── Review session (the top-level object) ────────────────────────────────

export interface ReviewSession {
  id: string;
  // ── ClickUp linkage (how Apollo finds & matches this review) ──
  clickupTaskId: string;
  clickupListId: string | null;
  clickupAttachmentId: string;
  /** ClickUp user id of whoever uploaded the asset → who to notify. */
  uploaderClickupId: number | null;
  /** ClickUp user id of whoever started/owns the review. */
  createdByClickupId: number;
  // ── State ──
  status: ReviewStatus;
  currentVersionId: string | null;
  /** The single ClickUp comment that announces this review — posted once on
   *  the first conclusion, then edited in place. Null until then. */
  clickupCommentId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Condensed summary (what the Apollo panel reads) ──────────────────────
// A denormalized read-model so Apollo can render the panel from one row
// without pulling every comment. Computed from the full data.

export interface ReviewSummary {
  reviewId: string;
  clickupTaskId: string;
  clickupAttachmentId: string;
  status: ReviewStatus;
  totalComments: number;
  resolvedComments: number;
  /** Up to N most recent comment previews for the panel. */
  recentPreviews: Array<{
    authorName: string;
    body: string;
    anchorLabel: string; // e.g. "00:12" or "p.3" or "—"
    createdAt: string;
  }>;
  updatedAt: string;
}
