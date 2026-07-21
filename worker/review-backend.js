// Apollo Review — backend Worker (Cloudflare).
//
// WHY: the review app is a static web page (GitHub Pages). Now that a review is
// a LIVE document instead of a self-contained `?z=` link, it needs a place to
// read & write review state. This Worker is that backend. State is ONE JSON
// blob per logical output lineage, keyed `review:<reviewId>` (for legacy data
// reviewId remains attachmentId). It lives primarily in D1 (binding DB, table
// `reviews`, one row per doc — same bytes, same key) with the original KV
// namespace (binding REVIEWS) as read-fallback for not-yet-migrated docs,
// write mirror during the transition and cold backup afterwards. The KV free
// tier's 100k reads/day ceiling is what forced the move; D1's free tier reads
// are 50× larger. No ClickUp token, no secrets.
//
// One review == one KV entry. V1/V2/V3 media attachments live in `versions`
// inside that entry. The single REVIEW link resolves to it for BOTH "revisar"
// and "ver": the URL never changes, only the blob does.
//
// Concluding a review just flips its status in KV. Notifying the creator (and
// the badge on the REVIEW icon) is the Apollo side's job — see CONTRACT.md.
//
// Routes (all POST, JSON in/out):
//   /session/resolve   load-or-create the review for an attachment
//   /session/save      persist status + comments + annotations (autosave)
//   /session/conclude  persist explicit completion intent
//   /session/version   append/replace media under the same review identity
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
        case "/session/save":     return await saveSession(payload, env);
        case "/session/conclude": return await concludeSession(payload, env);
        case "/session/version":  return await registerVersion(payload, env);
        case "/session/reconcile":return await reconcileSessions(payload, env);
        case "/session/meta":     return await sessionMetaCached(payload, env);
        default:                 return json({ error: `unknown route ${path}` }, 404);
      }
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502);
    }
  },
};

// ── /session/meta cache ─────────────────────────────────────────────────────
// Polling is the KV-read firehose: every Apollo instance probes each
// reviewId#versionId on its own schedule and the daily `KV get()` quota was
// exhausted by exactly those duplicated reads. Meta responses are cached in
// the Cache API for a short window under a deterministic internal GET key
// (POST bodies are never cached automatically), and every write route deletes
// the review's keys so a save/conclusion is observable immediately.
// 20s: o cliente agora sonda a cada 45s — um TTL de 60s no edge devolvia
// resposta velha em polls alternados e atrasava o consumo do VER REVIEW.
const META_CACHE_TTL_SECONDS = 20;

function metaCache() {
  return globalThis.caches?.default ?? null;
}

function metaCacheRequest(attachmentId, versionId) {
  const url = new URL("https://apollo-review-meta-cache.internal/session/meta");
  url.searchParams.set("att", String(attachmentId));
  url.searchParams.set("v", String(versionId || "").trim().toLowerCase());
  return new Request(url.toString(), { method: "GET" });
}

async function sessionMetaCached(p, env) {
  const cache = metaCache();
  const key = p && p.attachmentId ? metaCacheRequest(p.attachmentId, p.versionId) : null;
  if (cache && key) {
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, hit);
  }
  const response = await sessionMeta(p, env);
  if (cache && key && response.status === 200) {
    const copy = response.clone();
    const cached = new Response(copy.body, copy);
    cached.headers.set("Cache-Control", `max-age=${META_CACHE_TTL_SECONDS}`);
    await cache.put(key, cached);
  }
  return response;
}

// Drops every cached meta answer that could describe `review` — the stable
// review id, each registered version, and each physical attachment alias —
// so the next poll after a write reads the fresh document.
async function invalidateMetaCache(review, extraIds = []) {
  const cache = metaCache();
  if (!cache) return;
  const ids = new Set(extraIds.filter(Boolean));
  if (review && review.reviewId) ids.add(review.reviewId);
  if (review && review.attachmentId) ids.add(review.attachmentId);
  const versions = Array.isArray(review?.versions) ? review.versions : [];
  for (const version of versions) {
    if (version.attachmentId) ids.add(version.attachmentId);
  }
  const deletions = [];
  for (const id of ids) {
    deletions.push(cache.delete(metaCacheRequest(id, "")));
    for (const version of versions) {
      deletions.push(cache.delete(metaCacheRequest(id, version.versionId)));
    }
  }
  await Promise.all(deletions);
}

// ── Storage adapter: D1 primary, KV fallback/mirror ─────────────────────────
// Legacy sessions use attachmentId; versioned sessions use the stable lineage
// reviewId. Both are opaque strings and therefore share the same key format.
const keyFor = (reviewId) => `review:${reviewId}`;

// D1 has generous but real per-value limits; any pathological oversized doc
// simply stays in KV (per-doc fallback) instead of failing. Measured corpus:
// largest live doc is ~9 KB, so this guard should never fire in practice.
const D1_DOC_MAX_CHARS = 900_000;

async function d1LoadDoc(env, kvKey) {
  const row = await env.DB
    .prepare("SELECT doc FROM reviews WHERE kv_key = ?1")
    .bind(kvKey)
    .first();
  return row ? row.doc : null;
}

async function d1StoreDoc(env, kvKey, docText, updatedAt, source, ifAbsentOnly) {
  const conflict = ifAbsentOnly
    ? "ON CONFLICT(kv_key) DO NOTHING"
    : "ON CONFLICT(kv_key) DO UPDATE SET doc = excluded.doc, "
      + "updated_at = excluded.updated_at, source = excluded.source, "
      + "written_at = excluded.written_at";
  await env.DB
    .prepare("INSERT INTO reviews (kv_key, doc, updated_at, source, written_at) "
      + `VALUES (?1, ?2, ?3, ?4, ?5) ${conflict}`)
    .bind(kvKey, docText, updatedAt ?? null, source, new Date().toISOString())
    .run();
}

// D1 first; on a miss the doc is read from KV and lazily planted into D1
// byte-identical (first writer wins — a racing request is harmless). A KV
// read failure still propagates as a real error: storage trouble must never
// be interpreted as "the review does not exist".
async function loadReview(env, attachmentId) {
  const kvKey = keyFor(attachmentId);
  if (!env.DB) return env.REVIEWS.get(kvKey, "json");

  let docText = null;
  try {
    docText = await d1LoadDoc(env, kvKey);
  } catch {
    // D1 unavailable → degrade to the historical pure-KV path.
    return env.REVIEWS.get(kvKey, "json");
  }
  if (docText != null) {
    try {
      return JSON.parse(docText);
    } catch {
      // Corrupted row: fall through to KV, which remains authoritative for it.
    }
  }

  const rawFromKV = await env.REVIEWS.get(kvKey);
  if (rawFromKV == null) return null;
  const parsed = JSON.parse(rawFromKV);
  if (rawFromKV.length <= D1_DOC_MAX_CHARS) {
    try {
      await d1StoreDoc(env, kvKey, rawFromKV,
        typeof parsed?.updatedAt === "string" ? parsed.updatedAt : null,
        "lazy", true);
    } catch {
      // Lazy migration is best-effort; the read itself already succeeded.
    }
  }
  return parsed;
}

async function storeReview(env, review, { touch = true, key = review.reviewId } = {}) {
  if (touch) review.updatedAt = new Date().toISOString();
  const kvKey = keyFor(key);
  const docText = JSON.stringify(review);

  if (env.DB && docText.length <= D1_DOC_MAX_CHARS) {
    // D1 is the source of truth: if this write fails the error propagates
    // (502) and nothing is half-written — the client sees the real failure.
    await d1StoreDoc(env, kvKey, docText,
      typeof review.updatedAt === "string" ? review.updatedAt : null,
      "write", false);
    // The KV mirror only exists so a rollback to the pre-D1 Worker loses
    // nothing. Its failure must never veto a write D1 already confirmed.
    try {
      await env.REVIEWS.put(kvKey, docText);
    } catch {
      // best-effort mirror
    }
    return review;
  }

  await env.REVIEWS.put(kvKey, docText);
  if (env.DB) {
    // The doc outgrew the D1 size guard: drop any stale row so reads fall
    // back to the KV copy that just received the authoritative bytes.
    try {
      await env.DB.prepare("DELETE FROM reviews WHERE kv_key = ?1")
        .bind(kvKey).run();
    } catch {
      // best-effort: a stale row only survives until the doc shrinks again
    }
  }
  return review;
}

// Autosave payloads can be emitted for lifecycle-only UI changes (for
// example selecting the already-active version while the editor mounts).
// Object key order is not meaningful JSON, so compare a recursively sorted
// representation before deciding that review content really changed.
function stableJSON(value) {
  if (Array.isArray(value)) return value.map(stableJSON);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableJSON(value[key])]),
    );
  }
  return value;
}

function sameJSON(a, b) {
  return JSON.stringify(stableJSON(a)) === JSON.stringify(stableJSON(b));
}

function mediaVersionFrom(review, fallbackId = "v1") {
  return {
    versionId: review.versionId || fallbackId,
    attachmentId: review.attachmentId || review.reviewId,
    mediaUrl: review.mediaUrl || "",
    mediaTitle: review.mediaTitle || "Arquivo",
    mediaKind: review.mediaKind || "video",
    ext: review.ext || "",
    createdAt: review.createdAt || review.updatedAt || new Date().toISOString(),
  };
}

function ensureVersions(review) {
  if (!Array.isArray(review.versions) || review.versions.length === 0) {
    review.versions = [mediaVersionFrom(review)];
  }
  if (!review.currentVersionId) {
    review.currentVersionId = review.versionId || review.versions[review.versions.length - 1]?.versionId || "v1";
  }
  return review;
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

// Sessions created before version-local state existed stored status/comments
// only at the document root. Migrate lazily and non-destructively: every
// already-known version receives an independent snapshot of that legacy state.
// From this point on a save for V4 can never mutate V3.
function ensureVersionStates(review) {
  ensureVersions(review);
  if (!review.versionStates || typeof review.versionStates !== "object"
      || Array.isArray(review.versionStates)) {
    review.versionStates = {};
  }
  const legacy = {
    status: review.status || "in_review",
    concludedAt: review.concludedAt ?? null,
    comments: cloneJSON(review.comments || []),
    updatedAt: review.updatedAt || review.createdAt || new Date().toISOString(),
  };
  for (const version of review.versions) {
    if (!review.versionStates[version.versionId]) {
      review.versionStates[version.versionId] = cloneJSON(legacy);
    }
  }
  return review;
}

function stateFor(review, versionId) {
  ensureVersionStates(review);
  const id = versionId || review.currentVersionId || review.versionId || "v1";
  if (!review.versionStates[id]) {
    const source = review.versionStates[review.currentVersionId]
      || Object.values(review.versionStates)[0]
      || { status: "in_review", concludedAt: null, comments: [] };
    review.versionStates[id] = cloneJSON(source);
  }
  return review.versionStates[id];
}

function hasRegisteredVersion(review, versionId) {
  ensureVersions(review);
  return review.versions.some((version) => version.versionId === versionId);
}

// Keep the historical root fields as a projection of the current version so
// old Apollo/web clients and /session/meta remain fully compatible.
function projectCurrentState(review) {
  const state = stateFor(review, review.currentVersionId);
  review.status = state.status || "in_review";
  review.concludedAt = state.concludedAt ?? null;
  review.comments = cloneJSON(state.comments || []);
  return review;
}

function resolvedReview(review) {
  ensureVersions(review);
  ensureVersionStates(review);
  const current = review.versions.find((version) => version.versionId === review.currentVersionId)
    || review.versions[review.versions.length - 1]
    || mediaVersionFrom(review);
  review.currentVersionId = current.versionId;
  review.versionId = current.versionId;
  review.attachmentId = current.attachmentId;
  review.mediaUrl = current.mediaUrl;
  review.mediaTitle = current.mediaTitle;
  review.mediaKind = current.mediaKind;
  review.ext = current.ext || "";
  projectCurrentState(review);
  return {
    reviewId: review.reviewId,
    versionId: current.versionId,
    currentVersionId: current.versionId,
    mediaUrl: current.mediaUrl,
    mediaTitle: current.mediaTitle,
    mediaKind: current.mediaKind,
    ext: current.ext || "",
    versions: review.versions,
    versionStates: review.versionStates,
    status: review.status,
    concludedAt: review.concludedAt ?? null,
    clickupCommentId: review.clickupCommentId ?? null,
    comments: review.comments || [],
  };
}

function laterTimestamp(a, b) {
  return (a || "") >= (b || "") ? a : b;
}

function mergeVersionedReviews(preferredInput, otherInput, canonicalReviewId) {
  const preferred = cloneJSON(preferredInput);
  const other = cloneJSON(otherInput);
  ensureVersionStates(preferred);
  ensureVersionStates(other);

  const merged = cloneJSON(preferred);
  merged.reviewId = canonicalReviewId;

  const versions = new Map();
  for (const version of other.versions) versions.set(version.versionId, cloneJSON(version));
  for (const version of preferred.versions) versions.set(version.versionId, cloneJSON(version));
  merged.versions = Array.from(versions.values()).sort((lhs, rhs) => {
    const left = Number(String(lhs.versionId).replace(/\D/g, ""));
    const right = Number(String(rhs.versionId).replace(/\D/g, ""));
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
    return String(lhs.createdAt || "").localeCompare(String(rhs.createdAt || ""));
  });

  merged.versionStates = {};
  for (const version of merged.versions) {
    const preferredState = preferred.versionStates[version.versionId];
    const otherState = other.versionStates[version.versionId];
    if (preferredState && otherState) {
      merged.versionStates[version.versionId] = cloneJSON(
        (preferredState.updatedAt || "") >= (otherState.updatedAt || "")
          ? preferredState : otherState,
      );
    } else {
      merged.versionStates[version.versionId] = cloneJSON(
        preferredState || otherState || { status: "in_review", concludedAt: null, comments: [] },
      );
    }
  }

  const preferredCurrent = preferred.currentVersionId;
  const otherCurrent = other.currentVersionId;
  merged.currentVersionId = merged.versions.some((version) => version.versionId === preferredCurrent)
    ? preferredCurrent
    : (merged.versions.some((version) => version.versionId === otherCurrent)
      ? otherCurrent
      : merged.versions[merged.versions.length - 1]?.versionId || "v1");
  merged.clickupCommentId = preferred.clickupCommentId ?? other.clickupCommentId ?? null;
  merged.createdAt = preferred.createdAt || other.createdAt || new Date().toISOString();
  merged.updatedAt = laterTimestamp(preferred.updatedAt, other.updatedAt) || merged.createdAt;
  resolvedReview(merged);
  return merged;
}

// Canonical and historical URL-hash keys may coexist for an old review. The
// native app asks the Worker to reconcile the complete document server-side so
// opening a link can never flatten V3/V4 into one root comment array. The
// operation preserves updatedAt: identity repair is not reviewer activity.
async function reconcileSessions(p, env) {
  const canonical = p.canonicalAttachmentId;
  const legacy = p.legacyAttachmentId;
  if (!canonical || !legacy) return json({ error: "missing aliases" }, 400);

  const canonicalReview = await loadReview(env, canonical);
  const legacyReview = await loadReview(env, legacy);
  if (!canonicalReview && !legacyReview) return json({ exists: false }, 404);

  let merged;
  if (canonicalReview && legacyReview) {
    const canonicalIsNewer = (canonicalReview.updatedAt || "") >= (legacyReview.updatedAt || "");
    merged = mergeVersionedReviews(
      canonicalIsNewer ? canonicalReview : legacyReview,
      canonicalIsNewer ? legacyReview : canonicalReview,
      canonical,
    );
  } else {
    merged = cloneJSON(canonicalReview || legacyReview);
    merged.reviewId = canonical;
    resolvedReview(merged);
  }

  await storeReview(env, merged, { touch: false, key: canonical });
  await storeReview(env, merged, { touch: false, key: legacy });
  await invalidateMetaCache(merged, [canonical, legacy]);
  return json({ exists: true, ...resolvedReview(cloneJSON(merged)) });
}

// ── Lineage redirect ─────────────────────────────────────────────────────────
// ClickUp comments and old links may carry a PHYSICAL attachment id (or a
// URL-hash) of a V2/V3/V4 file whose review actually lives under the
// lineage's stable key. Creating a fresh session for those ids splits the
// review — approvals landing in an invisible orphan (20/jul, TESTE 04).
// When the requested key has NO document of its own, find the review that
// already owns this attachment/media and serve THAT. Clients follow the
// returned `reviewId`, so every surface converges on the stable session.
// D1-only (KV cannot be scanned); with no DB binding behaviour is unchanged.

async function findLineageOwner(env, attachmentId, mediaUrl) {
  if (!env.DB) return null;
  // instr() em vez de LIKE: o D1 limita padrões LIKE a ~50 caracteres
  // ("LIKE or GLOB pattern too complex") e ids/URLs estouram isso.
  // JSON.stringify reproduz exatamente o escaping usado no documento.
  const needles = [];
  if (attachmentId) needles.push(`"attachmentId":${JSON.stringify(String(attachmentId))}`);
  if (mediaUrl) needles.push(`"mediaUrl":${JSON.stringify(String(mediaUrl))}`);
  for (const needle of needles) {
    try {
      const row = await env.DB
        .prepare("SELECT doc FROM reviews WHERE instr(doc, ?1) > 0 LIMIT 1")
        .bind(needle)
        .first();
      if (!row) continue;
      const review = JSON.parse(row.doc);
      if (review && review.reviewId) return review;
    } catch {
      // Redirect is best-effort; a lookup failure falls back to the
      // historical behaviour (create/absent).
    }
  }
  return null;
}

// ── /session/meta ───────────────────────────────────────────────────────────
// Cheap poll for the badge: returns only whether a review exists and when it
// last changed — no comments/markup payload. Apollo compares updatedAt to its
// locally-stored "last seen" to decide the dot on the REVIEW button.
async function sessionMeta(p, env) {
  if (!p.attachmentId) return json({ error: "missing attachmentId" }, 400);
  let review = await loadReview(env, p.attachmentId);
  if (!review) {
    review = await findLineageOwner(env, p.attachmentId, p.mediaUrl);
  }
  if (!review) {
    return json({
      exists: false,
      reviewId: null,
      updatedAt: null,
      status: null,
      concludedAt: null,
      commentCount: 0,
      currentVersionId: null,
      evaluatedVersionId: null,
      mediaTitle: null,
    });
  }

  ensureVersions(review);
  const requestedVersionId = typeof p.versionId === "string"
    ? p.versionId.trim().toLowerCase()
    : "";
  const current = review.versions.find((version) => version.versionId === review.currentVersionId)
    || review.versions[review.versions.length - 1]
    || null;

  // Version-sensitive readers must never receive the root/current projection
  // while asking about another physical video. That was the source of phantom
  // VER REVIEW capsules: V1 comments were returned while Apollo was probing V2.
  if (requestedVersionId) {
    const requested = review.versions.find((version) =>
      String(version.versionId || "").trim().toLowerCase() === requestedVersionId
    );
    if (!requested) {
      return json({
        exists: false,
        reviewId: review.reviewId ?? p.attachmentId,
        updatedAt: null,
        status: null,
        concludedAt: null,
        commentCount: 0,
        currentVersionId: current?.versionId ?? null,
        evaluatedVersionId: requestedVersionId,
        mediaTitle: null,
      });
    }

    let state = review.versionStates && typeof review.versionStates === "object"
      ? review.versionStates[requested.versionId]
      : null;
    // A pre-versionStates document only proves the state of its projected
    // current video. For any sibling, returning "no exact state" is safer than
    // cloning activity across versions.
    if (!state && requested.versionId === current?.versionId) {
      state = {
        status: review.status || "in_review",
        concludedAt: review.concludedAt ?? null,
        comments: cloneJSON(review.comments || []),
        updatedAt: review.updatedAt || review.createdAt || null,
      };
    }
    if (!state) {
      return json({
        exists: false,
        reviewId: review.reviewId ?? p.attachmentId,
        updatedAt: null,
        status: null,
        concludedAt: null,
        commentCount: 0,
        currentVersionId: current?.versionId ?? null,
        evaluatedVersionId: requested.versionId,
        mediaTitle: requested.mediaTitle ?? null,
      });
    }
    return json({
      exists: true,
      reviewId: review.reviewId ?? p.attachmentId,
      updatedAt: state.updatedAt ?? null,
      status: state.status ?? null,
      concludedAt: state.concludedAt ?? null,
      commentCount: (state.comments || []).length,
      currentVersionId: current?.versionId ?? null,
      evaluatedVersionId: requested.versionId,
      mediaTitle: requested.mediaTitle ?? null,
    });
  }

  // Legacy callers intentionally receive the current projection, but it is
  // explicitly marked as non-version-evaluated so native clients cannot
  // relabel it as V2/V3 themselves.
  projectCurrentState(review);
  return json({
    exists: true,
    reviewId: review.reviewId ?? p.attachmentId,
    updatedAt: review.updatedAt ?? null,
    status: review.status ?? null,
    concludedAt: review.concludedAt ?? null,
    commentCount: (review.comments || []).length,
    currentVersionId: current?.versionId ?? null,
    evaluatedVersionId: null,
    mediaTitle: current?.mediaTitle ?? null,
  });
}

// ── /session/resolve ────────────────────────────────────────────────────────
// Load-or-create the review for an attachment, return its live state.
async function resolveSession(p, env) {
  const attachmentId = p.attachmentId;
  if (!attachmentId) return json({ error: "missing attachmentId" }, 400);

  let review = await loadReview(env, attachmentId);
  if (!review) {
    // A stale physical/hash link must open the lineage's stable review, not
    // mint an orphan session. The client adopts the returned `reviewId`.
    const owner = await findLineageOwner(env, attachmentId, p.mediaUrl);
    if (owner) return json(resolvedReview(owner));
  }
  if (!review) {
    const now = new Date().toISOString();
    review = {
      // reviewId === attachmentId: one review per attachment, stable key.
      reviewId: attachmentId,
      versionId: "v1",
      currentVersionId: "v1",
      taskId: p.taskId || "",
      listId: p.listId ?? null,
      attachmentId,
      mediaUrl: p.mediaUrl || "",
      mediaTitle: p.mediaTitle || "",
      mediaKind: p.mediaKind || "video",
      ext: p.ext || "",
      uploaderId: p.uploaderId ?? null,
      createdById: p.createdById ?? p.actorId ?? null,
      status: "in_review",
      concludedAt: null,
      clickupCommentId: null,
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
    review.versions = [mediaVersionFrom(review)];
    await storeReview(env, review);
    // A cached `exists:false` answer must not outlive the session creation.
    await invalidateMetaCache(review, [attachmentId]);
  }

  return json(resolvedReview(review));
}

// ── /session/version ───────────────────────────────────────────────────────
// Adds a replacement file to the SAME logical review. The review id remains
// stable; only the active media version advances. Existing comments, checks
// and annotations remain available so the reviewer can compare revisions.
async function registerVersion(p, env) {
  const reviewId = p.reviewId;
  if (!reviewId) return json({ error: "missing reviewId" }, 400);
  if (!p.mediaUrl) return json({ error: "missing mediaUrl" }, 400);

  let review = await loadReview(env, reviewId);
  const reviewAlreadyExisted = !!review;
  if (!review) {
    const now = new Date().toISOString();
    review = {
      reviewId,
      versionId: p.versionId || "v1",
      currentVersionId: p.versionId || "v1",
      taskId: p.taskId || "",
      listId: p.listId ?? null,
      attachmentId: p.attachmentId || reviewId,
      mediaUrl: p.mediaUrl,
      mediaTitle: p.mediaTitle || "Arquivo",
      mediaKind: p.mediaKind || "video",
      ext: p.ext || "",
      uploaderId: p.uploaderId ?? null,
      createdById: p.createdById ?? null,
      status: "in_review",
      concludedAt: null,
      clickupCommentId: null,
      comments: [],
      createdAt: now,
      updatedAt: now,
      versions: [],
    };
  }

  ensureVersions(review);
  ensureVersionStates(review);
  const versionId = p.versionId || `v${review.versions.length + 1}`;
  const version = {
    versionId,
    attachmentId: p.attachmentId || reviewId,
    mediaUrl: p.mediaUrl,
    mediaTitle: p.mediaTitle || "Arquivo",
    mediaKind: p.mediaKind || "video",
    ext: p.ext || "",
    createdAt: new Date().toISOString(),
  };
  const existingIndex = review.versions.findIndex((v) =>
    v.versionId === versionId ||
    (version.attachmentId && v.attachmentId === version.attachmentId)
  );
  const existingVersion = existingIndex >= 0 ? review.versions[existingIndex] : null;
  const sameVersion = existingVersion
    && existingVersion.versionId === version.versionId
    && existingVersion.attachmentId === version.attachmentId
    && existingVersion.mediaUrl === version.mediaUrl
    && existingVersion.mediaTitle === version.mediaTitle
    && existingVersion.mediaKind === version.mediaKind
    && (existingVersion.ext || "") === (version.ext || "");
  const alreadyCurrent = review.currentVersionId === versionId
    && review.attachmentId === version.attachmentId
    && review.mediaUrl === version.mediaUrl;

  // Retrying the exact same registration is transport idempotency, not a new
  // review version. In particular it must never reopen an approved conclusion.
  if (reviewAlreadyExisted && sameVersion && alreadyCurrent) {
    return json({ ok: true, unchanged: true, reviewId, versionId,
                  versions: review.versions });
  }

  const previousCurrentVersionId = review.currentVersionId;
  if (existingIndex >= 0) review.versions[existingIndex] = version;
  else {
    review.versions.push(version);
    // A replacement starts with the previous version's discussion snapshot,
    // including each comment's resolved state and annotations. It is a deep
    // copy: future edits are local to the new video's version.
    const inherited = cloneJSON(stateFor(review, previousCurrentVersionId));
    inherited.status = "in_review";
    inherited.concludedAt = null;
    inherited.updatedAt = new Date().toISOString();
    review.versionStates[versionId] = inherited;
  }

  review.versionId = versionId;
  review.currentVersionId = versionId;
  review.attachmentId = version.attachmentId;
  review.mediaUrl = version.mediaUrl;
  review.mediaTitle = version.mediaTitle;
  review.mediaKind = version.mediaKind;
  review.ext = version.ext;
  const currentState = stateFor(review, versionId);
  currentState.status = "in_review";
  currentState.concludedAt = null;
  currentState.updatedAt = new Date().toISOString();
  projectCurrentState(review);
  await storeReview(env, review, { key: reviewId });
  await invalidateMetaCache(review, [reviewId]);
  return json({ ok: true, reviewId, versionId, versions: review.versions });
}

// ── /session/save ───────────────────────────────────────────────────────────
// Persist the editor's full state (debounced by the caller). The whole review
// is one blob, so this is a simple read-merge-write. A REAL content edit
// reopens a previously concluded review; an identical lifecycle autosave does
// not. This distinction prevents merely opening/closing the web or native
// editor from resurrecting VER REVIEW after approval + explicit conclusion.
async function saveSession(p, env) {
  const reviewId = p.reviewId;
  if (!reviewId) return json({ error: "missing reviewId" }, 400);

  const review = await loadReview(env, reviewId);
  // A save can never be the first contact with a review: every legitimate
  // client resolves the session on open. Fabricating a document here created
  // invisible orphans (no taskId, no media) when a buggy client saved through
  // a payload-derived key — 2026-07-20's phantom `A review não foi salva`.
  if (!review) return json({ error: "unknown review", reviewId }, 404);

  ensureVersionStates(review);
  const versionId = p.versionId || review.currentVersionId || review.versionId || "v1";
  // Never manufacture a state for a media version that does not exist in the
  // review's version catalog. Doing so creates an invisible orphan: the save
  // appears successful, but the selector cannot reach it and resolve() keeps
  // returning the previous registered media.
  if (!hasRegisteredVersion(review, versionId)) {
    return json({ error: "unknown versionId", versionId }, 409);
  }
  const versionState = stateFor(review, versionId);

  const statusChanged = typeof p.status === "string" && p.status !== versionState.status;
  const commentsChanged = Array.isArray(p.comments)
    && !sameJSON(p.comments, versionState.comments || []);
  const reviewContentChanged = statusChanged || commentsChanged;

  if (typeof p.status === "string") versionState.status = p.status;
  if (Array.isArray(p.comments)) versionState.comments = cloneJSON(p.comments);
  if (reviewContentChanged) {
    versionState.concludedAt = null;
    versionState.updatedAt = new Date().toISOString();
  }
  review.versionStates[versionId] = versionState;
  projectCurrentState(review);

  // The single ClickUp conclusion comment's id — merged without touching
  // comments (Apollo sends it alone after posting/replacing the comment).
  const clickupCommentChanged = p.clickupCommentId !== undefined
    && p.clickupCommentId !== review.clickupCommentId;
  if (p.clickupCommentId !== undefined) {
    review.clickupCommentId = p.clickupCommentId;
  }

  if (!reviewContentChanged && !clickupCommentChanged) {
    return json({ ok: true, unchanged: true });
  }

  // ClickUp bookkeeping is not reviewer activity and must not create another
  // badge/notification revision. Persist it while retaining updatedAt.
  await storeReview(env, review, { touch: reviewContentChanged, key: reviewId });
  await invalidateMetaCache(review, [reviewId]);
  return json({ ok: true });
}

// ── /session/conclude ──────────────────────────────────────────────────────
// Approval and conclusion are deliberately independent. Apollo only consumes
// VER REVIEW when this endpoint was called AND the saved status is approved.
async function concludeSession(p, env) {
  const reviewId = p.reviewId;
  if (!reviewId) return json({ error: "missing reviewId" }, 400);

  const review = await loadReview(env, reviewId);
  // A conclusion can never be the first contact with a review either — see
  // saveSession. The 2026-07-20 orphan (`taskId: null`, approved+concluded)
  // was manufactured exactly here.
  if (!review) return json({ error: "unknown review", reviewId }, 404);

  ensureVersionStates(review);
  const versionId = p.versionId || review.currentVersionId || review.versionId || "v1";
  if (!hasRegisteredVersion(review, versionId)) {
    return json({ error: "unknown versionId", versionId }, 409);
  }
  const versionState = stateFor(review, versionId);
  if (p.status) versionState.status = p.status;
  if (Array.isArray(p.comments)) versionState.comments = cloneJSON(p.comments);
  versionState.concludedAt = new Date().toISOString();
  versionState.updatedAt = versionState.concludedAt;
  review.versionStates[versionId] = versionState;
  projectCurrentState(review);

  await storeReview(env, review, { key: reviewId });
  await invalidateMetaCache(review, [reviewId]);
  return json({ ok: true, concludedAt: versionState.concludedAt });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
