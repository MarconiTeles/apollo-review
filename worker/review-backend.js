// Apollo Review — backend Worker (Cloudflare).
//
// WHY: the review app is a static web page (GitHub Pages). Now that a review is
// a LIVE document instead of a self-contained `?z=` link, it needs a place to
// read & write review state. This Worker is that backend. State lives in
// Cloudflare KV (binding REVIEWS): ONE JSON blob per ClickUp attachment, keyed
// `review:<attachmentId>`. No external database, no ClickUp token, no secrets.
//
// One review == one KV entry, keyed by the attachment. The single REVIEW link
// resolves to that entry for BOTH "revisar" and "ver": the URL never changes,
// only the blob does. The attachment id IS the review id.
//
// Concluding a review just flips its status in KV. Notifying the creator (and
// the badge on the REVIEW icon) is the Apollo side's job — see CONTRACT.md.
//
// Routes (all POST, JSON in/out):
//   /session/resolve   load-or-create the review for an attachment
//   /session/save      persist status + comments + annotations (autosave)
//
// ── Deploy ──────────────────────────────────────────────────────────────────
//   cd apollo-review/worker && npx wrangler deploy     # KV binding only

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }

    if (!env.REVIEWS) return json({ error: "KV binding REVIEWS not configured" }, 500);

    try {
      switch (path) {
        case "/session/resolve": return await resolveSession(payload, env);
        case "/session/save":    return await saveSession(payload, env);
        default:                 return json({ error: `unknown route ${path}` }, 404);
      }
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502);
    }
  },
};

// ── KV helpers ──────────────────────────────────────────────────────────────
// The attachment id is the review's stable key AND its review id.
const keyFor = (attachmentId) => `review:${attachmentId}`;

async function loadReview(env, attachmentId) {
  return env.REVIEWS.get(keyFor(attachmentId), "json");
}
async function storeReview(env, review) {
  review.updatedAt = new Date().toISOString();
  await env.REVIEWS.put(keyFor(review.reviewId), JSON.stringify(review));
  return review;
}

// ── /session/resolve ────────────────────────────────────────────────────────
// Load-or-create the review for an attachment, return its live state.
async function resolveSession(p, env) {
  const attachmentId = p.attachmentId;
  if (!attachmentId) return json({ error: "missing attachmentId" }, 400);

  let review = await loadReview(env, attachmentId);
  if (!review) {
    const now = new Date().toISOString();
    review = {
      // reviewId === attachmentId: one review per attachment, stable key.
      reviewId: attachmentId,
      versionId: "v1",
      taskId: p.taskId || "",
      listId: p.listId ?? null,
      attachmentId,
      mediaUrl: p.mediaUrl || "",
      mediaTitle: p.mediaTitle || "",
      mediaKind: p.mediaKind || "video",
      uploaderId: p.uploaderId ?? null,
      createdById: p.createdById ?? p.actorId ?? null,
      status: "in_review",
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
    await storeReview(env, review);
  }

  return json({
    reviewId: review.reviewId,
    versionId: review.versionId || "v1",
    status: review.status,
    comments: review.comments || [],
  });
}

// ── /session/save ─────────────────────────────────────────────────────────��─
// Persist the editor's full state (debounced by the caller). The whole review
// is one blob, so this is a simple read-merge-write. Concluding is just a save
// with status flipped — there's no separate endpoint.
async function saveSession(p, env) {
  const reviewId = p.reviewId;
  if (!reviewId) return json({ error: "missing reviewId" }, 400);

  const review = (await loadReview(env, reviewId)) || {
    reviewId,
    versionId: p.versionId || "v1",
    attachmentId: reviewId,
    status: "in_review",
    comments: [],
    createdAt: new Date().toISOString(),
  };

  if (p.status) review.status = p.status;
  if (Array.isArray(p.comments)) review.comments = p.comments;

  await storeReview(env, review);
  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
