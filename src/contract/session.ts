// Web → Worker client for the SERVER-BACKED review.
//
// A review is no longer a self-contained `?z=` URL — it's a JSON blob in
// Cloudflare KV that the single REVIEW link resolves to (by attachment) for
// both "revisar" and "ver". This module is the browser's only door to that
// state; all calls go through the Cloudflare Worker (worker/review-backend.js),
// which owns the KV binding. No ClickUp token, no secrets.

import type { MediaKind, ReviewComment } from "./model";

// Serverless backend. Empty string disables server mode (offline / preview),
// in which case the Editor falls back to the legacy self-contained flow.
export const WORKER_URL = "https://apollo-review-proxy.marconimpn.workers.dev";

/** Everything needed to find-or-create the session for an attachment. */
export interface ResolveParams {
  taskId: string;
  listId?: string | null;
  attachmentId: string;
  mediaUrl: string;
  mediaTitle: string;
  mediaKind: MediaKind;
  uploaderId?: number | null;
  /** ClickUp id of whoever owns/created the review (for notification). */
  createdById?: number | null;
  /** ClickUp id of whoever is opening it now. */
  actorId?: number | null;
}

/** The live review as the Worker returns it. */
export interface ResolvedReview {
  reviewId: string;
  versionId: string;
  status: string;
  comments: ReviewComment[];
}

/** What the Editor needs to read/write the server-backed review. Absent =
 *  legacy self-contained flow (no autosave, no live link). */
export interface SessionContext {
  reviewId: string;
  versionId: string;
}

/** Find-or-create the session and load its current comments. */
export async function resolveSession(p: ResolveParams): Promise<ResolvedReview> {
  return post<ResolvedReview>("/session/resolve", p);
}

/** Persist the editor's full state (debounced by the caller). */
export async function saveSession(p: {
  reviewId: string;
  versionId: string;
  status: string;
  comments: ReviewComment[];
}): Promise<void> {
  await post("/session/save", p);
}

async function post<T>(route: string, body: unknown): Promise<T> {
  if (!WORKER_URL) throw new Error("WORKER_URL not configured");
  const r = await fetch(`${WORKER_URL}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data && (data as any).error) || `HTTP ${r.status}`);
  return data as T;
}
