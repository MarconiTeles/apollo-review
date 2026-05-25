// Deep-link contract: how Apollo (Swift) launches this review app for a
// specific ClickUp attachment.
//
// Apollo builds the URL and calls `NSWorkspace.shared.open(url)`.
// On macOS the scheme is registered via CFBundleURLTypes in the review app's
// Info.plist (Tauri: tauri.conf.json → bundle.macOS / a deep-link plugin).
//
// If the app is NOT installed, Apollo falls back to WEB_FALLBACK_BASE.

export const URL_SCHEME = "apolloreview";
export const OPEN_HOST = "open";

/** Web fallback when the desktop app isn't installed. Domain TBD. */
export const WEB_FALLBACK_BASE = "https://review.apollo.app/open";

/**
 * Everything Apollo knows at click-time and hands to the review app.
 * Identity is ClickUp's: ids are ClickUp user ids.
 */
export interface OpenReviewParams {
  /** ClickUp task the attachment lives on. */
  taskId: string;
  listId?: string;
  /** ClickUp attachment id (Attachment.id on the Apollo side). */
  attachmentId: string;
  /** ClickUp attachment URL — used to download the media if no localPath. */
  mediaUrl: string;
  mediaTitle: string;
  /** Lowercased extension, no dot (e.g. "mp4"). Drives MediaKind. */
  ext: string;
  /** If Apollo already downloaded the file, the absolute local path. The
   *  review app prefers this over downloading mediaUrl itself. */
  localPath?: string;
  /** ClickUp user id of whoever uploaded the asset (who to notify). */
  uploaderId?: number;
  /** ClickUp user id + name of the person opening the review (the reviewer). */
  actorId: number;
  actorName: string;
  /** Existing review to resume, if one already exists for this attachment. */
  reviewId?: string;
}

type ParamRecord = Record<string, string>;

function toRecord(p: OpenReviewParams): ParamRecord {
  const r: ParamRecord = {
    taskId: p.taskId,
    attachmentId: p.attachmentId,
    mediaUrl: p.mediaUrl,
    mediaTitle: p.mediaTitle,
    ext: p.ext,
    actorId: String(p.actorId),
    actorName: p.actorName,
  };
  if (p.listId) r.listId = p.listId;
  if (p.localPath) r.localPath = p.localPath;
  if (p.uploaderId != null) r.uploaderId = String(p.uploaderId);
  if (p.reviewId) r.reviewId = p.reviewId;
  return r;
}

/** Build the deep link Apollo opens. */
export function buildDeepLink(p: OpenReviewParams): string {
  const qs = new URLSearchParams(toRecord(p)).toString();
  return `${URL_SCHEME}://${OPEN_HOST}?${qs}`;
}

/** Build the web fallback URL (app not installed). */
export function buildWebFallback(p: OpenReviewParams): string {
  const qs = new URLSearchParams(toRecord(p)).toString();
  return `${WEB_FALLBACK_BASE}?${qs}`;
}

/** Parse an incoming deep link (or web URL) back into params. Returns null
 *  if it isn't a well-formed open request. */
export function parseOpenUrl(raw: string): OpenReviewParams | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const isScheme = url.protocol === `${URL_SCHEME}:` && url.host === OPEN_HOST;
  const isWeb = raw.startsWith(WEB_FALLBACK_BASE);
  if (!isScheme && !isWeb) return null;

  const q = url.searchParams;
  const taskId = q.get("taskId");
  const attachmentId = q.get("attachmentId");
  const mediaUrl = q.get("mediaUrl");
  const mediaTitle = q.get("mediaTitle");
  const ext = q.get("ext");
  const actorIdRaw = q.get("actorId");
  const actorName = q.get("actorName");
  if (
    !taskId || !attachmentId || !mediaUrl || !mediaTitle || !ext ||
    !actorIdRaw || !actorName
  ) {
    return null;
  }

  const uploaderRaw = q.get("uploaderId");
  return {
    taskId,
    attachmentId,
    mediaUrl,
    mediaTitle,
    ext,
    actorId: Number(actorIdRaw),
    actorName,
    listId: q.get("listId") ?? undefined,
    localPath: q.get("localPath") ?? undefined,
    uploaderId: uploaderRaw != null ? Number(uploaderRaw) : undefined,
    reviewId: q.get("reviewId") ?? undefined,
  };
}

/** Map a file extension to the asset kind the player should use. */
export function mediaKindFromExt(ext: string): import("./model").MediaKind {
  const e = ext.toLowerCase();
  if (["mp4", "mov", "avi", "mkv", "webm", "m4v"].includes(e)) return "video";
  if (["png", "jpg", "jpeg", "gif", "heic", "webp", "svg", "bmp", "tiff"].includes(e)) {
    return "image";
  }
  if (["mp3", "wav", "m4a", "flac", "aac", "ogg"].includes(e)) return "audio";
  return "document";
}
