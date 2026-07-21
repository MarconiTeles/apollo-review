import test from "node:test";
import assert from "node:assert/strict";
import worker from "./review-backend.js";

class MemoryKV {
  constructor(seed = {}) { this.values = new Map(Object.entries(seed)); }
  async get(key, type) {
    const value = this.values.get(key);
    if (value == null) return null;
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key, value) { this.values.set(key, value); }
}

class CountingKV extends MemoryKV {
  constructor(seed = {}) { super(seed); this.reads = 0; }
  async get(key, type) { this.reads += 1; return super.get(key, type); }
}

/// Simula a cota diária de leitura do KV esgotada (o incidente real).
class QuotaExhaustedKV {
  async get() { throw new Error("KV get() limit exceeded for the day."); }
  async put() { throw new Error("KV put() must not be reached in this test"); }
}

/// KV cujo espelho de escrita falha (leitura funciona).
class PutFailingKV extends MemoryKV {
  async put() { throw new Error("KV write quota exceeded"); }
}

/// Fake do D1 restrito aos statements EXATOS que o adapter emite — manter o
/// SQL do Worker trivial é decisão de projeto para este fake ser fiel.
class FakeD1 {
  constructor() { this.rows = new Map(); }
  prepare(sql) {
    const rows = this.rows;
    const trimmed = sql.replace(/\s+/g, " ").trim();
    return {
      bind(...args) {
        return {
          async first() {
            if (trimmed === "SELECT doc FROM reviews WHERE kv_key = ?1") {
              const row = rows.get(args[0]);
              return row ? { doc: row.doc } : null;
            }
            if (trimmed === "SELECT doc FROM reviews WHERE instr(doc, ?1) > 0 LIMIT 1") {
              const needle = String(args[0]);
              for (const row of rows.values()) {
                if (row.doc.includes(needle)) return { doc: row.doc };
              }
              return null;
            }
            throw new Error(`FakeD1: SELECT inesperado: ${trimmed}`);
          },
          async run() {
            if (trimmed === "DELETE FROM reviews WHERE kv_key = ?1") {
              rows.delete(args[0]);
              return { success: true };
            }
            if (!trimmed.startsWith("INSERT INTO reviews")) {
              throw new Error(`FakeD1: INSERT inesperado: ${trimmed}`);
            }
            const ifAbsentOnly = trimmed.includes("ON CONFLICT(kv_key) DO NOTHING");
            const upsert = trimmed.includes("ON CONFLICT(kv_key) DO UPDATE");
            if (!ifAbsentOnly && !upsert) {
              throw new Error(`FakeD1: cláusula de conflito ausente: ${trimmed}`);
            }
            const [kvKey, doc, updatedAt, source, writtenAt] = args;
            if (rows.has(kvKey) && ifAbsentOnly) return { success: true };
            rows.set(kvKey, {
              doc, updated_at: updatedAt, source, written_at: writtenAt,
            });
            return { success: true };
          },
        };
      },
    };
  }
}

async function post(env, route, body) {
  const response = await worker.fetch(new Request(`https://review.test${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), env);
  const json = await response.json();
  assert.equal(response.status, 200, JSON.stringify(json));
  return json;
}

async function postWithStatus(env, route, body) {
  const response = await worker.fetch(new Request(`https://review.test${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), env);
  return { status: response.status, json: await response.json() };
}

function cloneForTest(value) {
  return JSON.parse(JSON.stringify(value));
}

// ── Contrato: a MESMA suíte roda no modo KV puro (sem binding DB, comporta-
// mento histórico) e no modo D1+KV (D1 primário frio + KV semeado, o que
// exercita a migração lazy dentro de cada fluxo). Nenhuma asserção muda.
const MODES = [
  { mode: "kv", makeEnv: (seed = {}) => ({ REVIEWS: new MemoryKV(seed) }) },
  { mode: "d1", makeEnv: (seed = {}) => ({ REVIEWS: new MemoryKV(seed), DB: new FakeD1() }) },
];

for (const { mode, makeEnv } of MODES) {

test(`[${mode}] legacy review remains V1 with the same key, link and comments`, async () => {
  const legacy = {
    reviewId: "legacy-attachment",
    versionId: "v1",
    attachmentId: "legacy-attachment",
    mediaUrl: "https://files.test/v1.mov",
    mediaTitle: "Original.mov",
    mediaKind: "video",
    status: "in_review",
    comments: [{ id: "comment-1", body: "corrigir", resolved: true }],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
  const resolved = await post(
    makeEnv({ "review:legacy-attachment": JSON.stringify(legacy) }),
    "/session/resolve",
    { attachmentId: "legacy-attachment", mediaUrl: "https://wrong-fallback.test/file.mov" },
  );

  assert.equal(resolved.reviewId, "legacy-attachment");
  assert.equal(resolved.mediaUrl, legacy.mediaUrl);
  assert.equal(resolved.versions.length, 1);
  assert.equal(resolved.versions[0].attachmentId, "legacy-attachment");
  assert.deepEqual(resolved.comments, legacy.comments);
});

test(`[${mode}] replacement becomes V2 inside the same review and preserves discussion`, async () => {
  const env = makeEnv();
  await post(env, "/session/version", {
    reviewId: "stable-review",
    versionId: "v1",
    attachmentId: "attachment-v1",
    mediaUrl: "https://files.test/v1.mov",
    mediaTitle: "Video V1.mov",
    mediaKind: "video",
  });
  await post(env, "/session/save", {
    reviewId: "stable-review",
    versionId: "v1",
    status: "changes_requested",
    comments: [{ id: "comment-v1", body: "trocar cena", resolved: true }],
  });
  await post(env, "/session/conclude", {
    reviewId: "stable-review",
    status: "approved",
  });

  await post(env, "/session/version", {
    reviewId: "stable-review",
    versionId: "v2",
    attachmentId: "attachment-v2",
    mediaUrl: "https://files.test/v2.mov",
    mediaTitle: "Video V2.mov",
    mediaKind: "video",
  });
  const resolved = await post(env, "/session/resolve", {
    attachmentId: "stable-review",
  });

  assert.equal(resolved.reviewId, "stable-review");
  assert.equal(resolved.currentVersionId, "v2");
  assert.equal(resolved.mediaUrl, "https://files.test/v2.mov");
  assert.deepEqual(resolved.versions.map((v) => v.versionId), ["v1", "v2"]);
  assert.deepEqual(resolved.comments, [{ id: "comment-v1", body: "trocar cena", resolved: true }]);
  assert.equal(resolved.status, "in_review");
  assert.equal(resolved.concludedAt, null);
});

test(`[${mode}] replacement copies the prior snapshot once then isolates both versions`, async () => {
  const env = makeEnv();
  await post(env, "/session/version", {
    reviewId: "stable-review",
    versionId: "v3",
    attachmentId: "attachment-v3",
    mediaUrl: "https://files.test/v3.mov",
    mediaTitle: "Video V3.mov",
    mediaKind: "video",
  });
  await post(env, "/session/save", {
    reviewId: "stable-review",
    versionId: "v3",
    status: "changes_requested",
    comments: [{ id: "shared", body: "ajuste original", resolved: true }],
  });
  await post(env, "/session/version", {
    reviewId: "stable-review",
    versionId: "v4",
    attachmentId: "attachment-v4",
    mediaUrl: "https://files.test/v4.mov",
    mediaTitle: "Video V4.mov",
    mediaKind: "video",
  });

  let resolved = await post(env, "/session/resolve", {
    attachmentId: "stable-review",
  });
  assert.deepEqual(resolved.versionStates.v4.comments,
    [{ id: "shared", body: "ajuste original", resolved: true }]);
  assert.equal(resolved.versionStates.v4.status, "in_review");

  await post(env, "/session/save", {
    reviewId: "stable-review",
    versionId: "v4",
    status: "in_review",
    comments: [
      { id: "shared", body: "ajuste original", resolved: false },
      { id: "new-v4", body: "somente na V4", resolved: false },
    ],
  });
  resolved = await post(env, "/session/resolve", {
    attachmentId: "stable-review",
  });

  assert.deepEqual(resolved.versionStates.v3.comments,
    [{ id: "shared", body: "ajuste original", resolved: true }]);
  assert.deepEqual(resolved.versionStates.v4.comments, [
    { id: "shared", body: "ajuste original", resolved: false },
    { id: "new-v4", body: "somente na V4", resolved: false },
  ]);
  assert.deepEqual(resolved.comments, resolved.versionStates.v4.comments);
});

test(`[${mode}] save and conclude never create a review out of thin air`, async () => {
  const env = makeEnv();
  const save = await postWithStatus(env, "/session/save", {
    reviewId: "orphan-review",
    versionId: "v3",
    status: "approved",
    comments: [{ id: "c1", body: "orfao", resolved: true }],
  });
  assert.equal(save.status, 404);
  assert.equal(save.json.error, "unknown review");

  const conclude = await postWithStatus(env, "/session/conclude", {
    reviewId: "orphan-review",
    versionId: "v3",
    status: "approved",
    comments: [],
  });
  assert.equal(conclude.status, 404,
    "uma conclusão nunca é o primeiro contato com uma review");

  const meta = await post(env, "/session/meta", { attachmentId: "orphan-review" });
  assert.equal(meta.exists, false, "nenhum documento órfão pode nascer disso");
});

test(`[${mode}] save and conclude reject version states with no registered media`, async () => {
  const env = makeEnv();
  await post(env, "/session/version", {
    reviewId: "stable-review",
    versionId: "v3",
    attachmentId: "attachment-v3",
    mediaUrl: "https://files.test/v3.mov",
    mediaTitle: "Video V3.mov",
    mediaKind: "video",
  });

  const save = await postWithStatus(env, "/session/save", {
    reviewId: "stable-review",
    versionId: "v4",
    status: "in_review",
    comments: [{ id: "orphan", body: "must not disappear" }],
  });
  assert.equal(save.status, 409);
  assert.equal(save.json.error, "unknown versionId");

  const conclude = await postWithStatus(env, "/session/conclude", {
    reviewId: "stable-review",
    versionId: "v4",
    status: "approved",
    comments: [],
  });
  assert.equal(conclude.status, 409);

  const resolved = await post(env, "/session/resolve", {
    attachmentId: "stable-review",
  });
  assert.deepEqual(resolved.versions.map((version) => version.versionId), ["v3"]);
  assert.equal(resolved.versionStates.v4, undefined);
});

test(`[${mode}] legacy multi-version blob migrates to independent snapshots`, async () => {
  const legacy = {
    reviewId: "legacy-versioned",
    versionId: "v2",
    currentVersionId: "v2",
    attachmentId: "attachment-v2",
    mediaUrl: "https://files.test/v2.mov",
    mediaTitle: "Video V2.mov",
    mediaKind: "video",
    status: "approved",
    concludedAt: "2026-07-18T00:00:00.000Z",
    comments: [{ id: "legacy-comment", body: "legado", resolved: true }],
    versions: [
      { versionId: "v1", attachmentId: "attachment-v1", mediaUrl: "https://files.test/v1.mov", mediaTitle: "V1.mov", mediaKind: "video" },
      { versionId: "v2", attachmentId: "attachment-v2", mediaUrl: "https://files.test/v2.mov", mediaTitle: "V2.mov", mediaKind: "video" },
    ],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
  const resolved = await post(
    makeEnv({ "review:legacy-versioned": JSON.stringify(legacy) }),
    "/session/resolve",
    { attachmentId: "legacy-versioned" },
  );

  assert.deepEqual(resolved.versionStates.v1.comments, legacy.comments);
  assert.deepEqual(resolved.versionStates.v2.comments, legacy.comments);
  assert.notStrictEqual(resolved.versionStates.v1, resolved.versionStates.v2);
});

test(`[${mode}] re-registering the same attachment/version is idempotent`, async () => {
  const env = makeEnv();
  const body = {
    reviewId: "stable-review",
    versionId: "v2",
    attachmentId: "attachment-v2",
    mediaUrl: "https://files.test/v2.mov",
    mediaTitle: "Video V2.mov",
    mediaKind: "video",
  };
  await post(env, "/session/version", body);
  await post(env, "/session/version", body);
  const resolved = await post(env, "/session/resolve", { attachmentId: "stable-review" });
  assert.equal(resolved.versions.length, 1);
  assert.equal(resolved.versions[0].versionId, "v2");
});

test(`[${mode}] identical autosave does not reopen an approved concluded review`, async () => {
  const env = makeEnv();
  const comments = [
    { id: "comment-1", body: "corrigir", resolved: true, annotation: { y: 2, x: 1 } },
    { id: "comment-2", body: "feito", resolved: true },
  ];
  await post(env, "/session/version", {
    reviewId: "stable-review",
    versionId: "v1",
    attachmentId: "attachment-v1",
    mediaUrl: "https://files.test/v1.mov",
    mediaTitle: "Video V1.mov",
    mediaKind: "video",
  });
  await post(env, "/session/conclude", {
    reviewId: "stable-review",
    versionId: "v1",
    status: "approved",
    comments,
  });
  const before = await post(env, "/session/meta", { attachmentId: "stable-review" });

  // Same semantic JSON with object keys reordered, as can happen after a
  // native/web decode-encode cycle.
  const result = await post(env, "/session/save", {
    reviewId: "stable-review",
    versionId: "v1",
    status: "approved",
    comments: [
      { annotation: { x: 1, y: 2 }, resolved: true, body: "corrigir", id: "comment-1" },
      { resolved: true, id: "comment-2", body: "feito" },
    ],
  });
  const after = await post(env, "/session/meta", { attachmentId: "stable-review" });

  assert.equal(result.unchanged, true);
  assert.ok(before.concludedAt);
  assert.equal(after.concludedAt, before.concludedAt);
  assert.equal(after.updatedAt, before.updatedAt);
});

test(`[${mode}] a real edit after conclusion reopens the review`, async () => {
  const env = makeEnv();
  await post(env, "/session/version", {
    reviewId: "stable-review",
    versionId: "v1",
    attachmentId: "attachment-v1",
    mediaUrl: "https://files.test/v1.mov",
  });
  await post(env, "/session/conclude", {
    reviewId: "stable-review",
    versionId: "v1",
    status: "approved",
    comments: [{ id: "comment-1", body: "feito", resolved: true }],
  });

  await post(env, "/session/save", {
    reviewId: "stable-review",
    versionId: "v1",
    status: "approved",
    comments: [
      { id: "comment-1", body: "feito", resolved: true },
      { id: "comment-2", body: "novo ajuste", resolved: false },
    ],
  });
  const meta = await post(env, "/session/meta", { attachmentId: "stable-review" });

  assert.equal(meta.concludedAt, null);
  assert.equal(meta.commentCount, 2);
});

test(`[${mode}] idempotent version retry preserves an approved conclusion`, async () => {
  const env = makeEnv();
  const version = {
    reviewId: "stable-review",
    versionId: "v1",
    attachmentId: "attachment-v1",
    mediaUrl: "https://files.test/v1.mov",
    mediaTitle: "Video V1.mov",
    mediaKind: "video",
  };
  await post(env, "/session/version", version);
  await post(env, "/session/conclude", {
    reviewId: "stable-review",
    status: "approved",
    comments: [],
  });

  const retry = await post(env, "/session/version", version);
  const meta = await post(env, "/session/meta", { attachmentId: "stable-review" });

  assert.equal(retry.unchanged, true);
  assert.ok(meta.concludedAt);
  assert.equal(meta.status, "approved");
});

test(`[${mode}] reconcile copies a legacy versioned review without changing activity time`, async () => {
  const legacy = {
    reviewId: "legacy-hash",
    versionId: "v2",
    currentVersionId: "v2",
    attachmentId: "attachment-v2",
    mediaUrl: "https://files.test/v2.mov",
    mediaTitle: "Video V2.mov",
    mediaKind: "video",
    status: "in_review",
    concludedAt: null,
    comments: [{ id: "v2-only", body: "ajuste V2", resolved: false }],
    versions: [
      { versionId: "v1", attachmentId: "attachment-v1", mediaUrl: "https://files.test/v1.mov", mediaTitle: "V1.mov", mediaKind: "video" },
      { versionId: "v2", attachmentId: "attachment-v2", mediaUrl: "https://files.test/v2.mov", mediaTitle: "V2.mov", mediaKind: "video" },
    ],
    versionStates: {
      v1: { status: "approved", concludedAt: "2026-07-10T12:00:00.000Z", comments: [{ id: "v1-only", body: "feito", resolved: true }], updatedAt: "2026-07-10T12:00:00.000Z" },
      v2: { status: "in_review", concludedAt: null, comments: [{ id: "v2-only", body: "ajuste V2", resolved: false }], updatedAt: "2026-07-11T12:00:00.000Z" },
    },
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-11T12:00:00.000Z",
  };
  const env = makeEnv({ "review:legacy-hash": JSON.stringify(legacy) });
  const kv = env.REVIEWS;

  const reconciled = await post(env, "/session/reconcile", {
    canonicalAttachmentId: "canonical-review",
    legacyAttachmentId: "legacy-hash",
  });
  // O espelho KV precisa refletir o pós-reconcile nos DOIS aliases em ambos
  // os modos (é ele que garante rollback sem perda).
  const canonical = await kv.get("review:canonical-review", "json");
  const mirroredLegacy = await kv.get("review:legacy-hash", "json");

  assert.equal(reconciled.reviewId, "canonical-review");
  assert.equal(canonical.updatedAt, legacy.updatedAt);
  assert.deepEqual(canonical.versionStates.v1.comments, legacy.versionStates.v1.comments);
  assert.deepEqual(canonical.versionStates.v2.comments, legacy.versionStates.v2.comments);
  assert.deepEqual(mirroredLegacy.versionStates, canonical.versionStates);
});

test(`[${mode}] reconcile chooses each version state independently and never mixes comments`, async () => {
  const canonical = {
    reviewId: "canonical-review",
    currentVersionId: "v4",
    versions: [
      { versionId: "v3", attachmentId: "attachment-v3", mediaUrl: "https://files.test/v3.mov", mediaTitle: "V3.mov", mediaKind: "video" },
      { versionId: "v4", attachmentId: "attachment-v4", mediaUrl: "https://files.test/v4.mov", mediaTitle: "V4.mov", mediaKind: "video" },
    ],
    versionStates: {
      v3: { status: "approved", concludedAt: "2026-07-12T12:00:00.000Z", comments: [{ id: "v3", body: "somente V3", resolved: true }], updatedAt: "2026-07-12T12:00:00.000Z" },
      v4: { status: "in_review", concludedAt: null, comments: [{ id: "v4-old", body: "V4 antigo", resolved: false }], updatedAt: "2026-07-12T13:00:00.000Z" },
    },
    status: "in_review",
    concludedAt: null,
    comments: [{ id: "v4-old", body: "V4 antigo", resolved: false }],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-12T13:00:00.000Z",
  };
  const legacy = cloneForTest(canonical);
  legacy.reviewId = "legacy-hash";
  legacy.versionStates.v3 = {
    status: "in_review",
    concludedAt: null,
    comments: [{ id: "stale-v3", body: "nao deve vencer", resolved: false }],
    updatedAt: "2026-07-11T12:00:00.000Z",
  };
  legacy.versionStates.v4 = {
    status: "changes_requested",
    concludedAt: null,
    comments: [{ id: "v4-new", body: "somente V4 novo", resolved: false }],
    updatedAt: "2026-07-13T12:00:00.000Z",
  };
  legacy.comments = legacy.versionStates.v4.comments;
  legacy.updatedAt = "2026-07-13T12:00:00.000Z";
  const env = makeEnv({
    "review:canonical-review": JSON.stringify(canonical),
    "review:legacy-hash": JSON.stringify(legacy),
  });

  const reconciled = await post(env, "/session/reconcile", {
    canonicalAttachmentId: "canonical-review",
    legacyAttachmentId: "legacy-hash",
  });

  assert.deepEqual(reconciled.versionStates.v3.comments,
    [{ id: "v3", body: "somente V3", resolved: true }]);
  assert.deepEqual(reconciled.versionStates.v4.comments,
    [{ id: "v4-new", body: "somente V4 novo", resolved: false }]);
  assert.equal(reconciled.versionStates.v3.status, "approved");
  assert.equal(reconciled.versionStates.v4.status, "changes_requested");
});

test(`[${mode}] root meta never declares itself version-evaluated`, async () => {
  const env = makeEnv();
  await post(env, "/session/version", {
    reviewId: "meta-root",
    versionId: "v1",
    attachmentId: "attachment-v1",
    mediaUrl: "https://files.test/v1.mov",
  });
  await post(env, "/session/save", {
    reviewId: "meta-root",
    versionId: "v1",
    status: "changes_requested",
    comments: [{ id: "c1", body: "ajuste", resolved: false }],
  });

  const meta = await post(env, "/session/meta", { attachmentId: "meta-root" });
  assert.equal(meta.exists, true);
  assert.equal(meta.evaluatedVersionId, null,
    "a projeção da raiz nunca pode fingir versão avaliada");
});

test(`[${mode}] exact meta identifies the requested version and keeps empty V2 empty`, async () => {
  const env = makeEnv();
  await post(env, "/session/version", {
    reviewId: "meta-exact",
    versionId: "v1",
    attachmentId: "attachment-v1",
    mediaUrl: "https://files.test/v1.mov",
  });
  await post(env, "/session/save", {
    reviewId: "meta-exact",
    versionId: "v1",
    status: "changes_requested",
    comments: [{ id: "c1", body: "so v1", resolved: false }],
  });
  await post(env, "/session/version", {
    reviewId: "meta-exact",
    versionId: "v2",
    attachmentId: "attachment-v2",
    mediaUrl: "https://files.test/v2.mov",
  });
  // Zera a discussão herdada da V2 para reproduzir uma V2 realmente vazia.
  await post(env, "/session/save", {
    reviewId: "meta-exact",
    versionId: "v2",
    status: "in_review",
    comments: [],
  });

  const v1 = await post(env, "/session/meta", {
    attachmentId: "meta-exact", versionId: "v1",
  });
  assert.equal(v1.evaluatedVersionId, "v1");
  assert.equal(v1.commentCount, 1);
  assert.equal(v1.status, "changes_requested");

  const v2 = await post(env, "/session/meta", {
    attachmentId: "meta-exact", versionId: "v2",
  });
  assert.equal(v2.evaluatedVersionId, "v2");
  assert.equal(v2.commentCount, 0,
    "a leitura exata da V2 não pode copiar atividade da V1");
  assert.equal(v2.status, "in_review");
});

}

// ── Storage D1: migração lazy, imunidade à cota do KV, espelho, tamanho ─────

test("first read lazily migrates a KV doc to D1; the second read never touches KV", async () => {
  const legacy = {
    reviewId: "lazy-review",
    versionId: "v1",
    attachmentId: "lazy-review",
    mediaUrl: "https://files.test/lazy.mov",
    mediaTitle: "Lazy.mov",
    mediaKind: "video",
    status: "in_review",
    comments: [{ id: "c1", body: "oi", resolved: false }],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
  const kv = new CountingKV({ "review:lazy-review": JSON.stringify(legacy) });
  const d1 = new FakeD1();
  const env = { REVIEWS: kv, DB: d1 };

  const first = await post(env, "/session/meta", { attachmentId: "lazy-review" });
  assert.equal(first.exists, true);
  assert.equal(kv.reads, 1);
  const row = d1.rows.get("review:lazy-review");
  assert.ok(row, "a primeira leitura planta a linha no D1");
  assert.equal(row.doc, JSON.stringify(legacy), "migração byte-idêntica");
  assert.equal(row.source, "lazy");
  assert.equal(row.updated_at, legacy.updatedAt);

  const second = await post(env, "/session/meta", { attachmentId: "lazy-review" });
  assert.equal(second.exists, true);
  assert.equal(kv.reads, 1, "doc migrado nunca mais lê o KV");
});

test("an exhausted KV quota no longer blocks a migrated review (read, save, conclude)", async () => {
  // Aquece o D1 com um fluxo normal…
  const warm = { REVIEWS: new MemoryKV(), DB: new FakeD1() };
  await post(warm, "/session/version", {
    reviewId: "immune-review",
    versionId: "v1",
    attachmentId: "attachment-v1",
    mediaUrl: "https://files.test/immune.mov",
    mediaTitle: "Immune.mov",
    mediaKind: "video",
  });
  await post(warm, "/session/save", {
    reviewId: "immune-review",
    versionId: "v1",
    status: "changes_requested",
    comments: [{ id: "c1", body: "ajuste", resolved: false }],
  });

  // …e então o KV "estoura a cota" (o incidente real de 20/jul).
  const broken = { REVIEWS: new QuotaExhaustedKV(), DB: warm.DB };

  const meta = await post(broken, "/session/meta", { attachmentId: "immune-review" });
  assert.equal(meta.exists, true);
  assert.equal(meta.commentCount, 1);

  const save = await post(broken, "/session/save", {
    reviewId: "immune-review",
    versionId: "v1",
    status: "approved",
    comments: [{ id: "c1", body: "ajuste", resolved: true }],
  });
  assert.equal(save.ok, true, "salvar não depende mais do KV");

  const conclude = await post(broken, "/session/conclude", {
    reviewId: "immune-review",
    versionId: "v1",
    status: "approved",
    comments: [{ id: "c1", body: "ajuste", resolved: true }],
  });
  assert.equal(conclude.ok, true, "concluir não depende mais do KV");
  assert.ok(conclude.concludedAt);
});

test("KV failure with a cold D1 stays a loud error — state is never fabricated", async () => {
  const env = { REVIEWS: new QuotaExhaustedKV(), DB: new FakeD1() };
  const meta = await postWithStatus(env, "/session/meta", {
    attachmentId: "never-migrated",
  });
  assert.equal(meta.status, 502);
  assert.match(meta.json.error, /limit exceeded/);
});

test("a failing KV write mirror never vetoes a write D1 already confirmed", async () => {
  const env = { REVIEWS: new PutFailingKV(), DB: new FakeD1() };
  const resolved = await post(env, "/session/resolve", {
    attachmentId: "mirror-review",
    taskId: "task-1",
    mediaUrl: "https://files.test/mirror.mov",
    mediaTitle: "Mirror.mov",
    mediaKind: "video",
  });
  assert.equal(resolved.reviewId, "mirror-review");

  const save = await post(env, "/session/save", {
    reviewId: "mirror-review",
    versionId: "v1",
    status: "changes_requested",
    comments: [{ id: "c1", body: "ok", resolved: false }],
  });
  assert.equal(save.ok, true);

  const meta = await post(env, "/session/meta", { attachmentId: "mirror-review" });
  assert.equal(meta.commentCount, 1, "o D1 é a fonte da verdade");
});

test("an oversized doc leaves D1 and stays served by KV without any error", async () => {
  const kv = new MemoryKV();
  const d1 = new FakeD1();
  const env = { REVIEWS: kv, DB: d1 };
  const huge = "x".repeat(950_000);

  await post(env, "/session/version", {
    reviewId: "huge-review",
    versionId: "v1",
    attachmentId: "attachment-v1",
    mediaUrl: "https://files.test/huge.mov",
  });
  assert.ok(d1.rows.has("review:huge-review"), "doc pequeno vive no D1");

  const save = await post(env, "/session/save", {
    reviewId: "huge-review",
    versionId: "v1",
    status: "in_review",
    comments: [{ id: "c1", body: huge, resolved: false }],
  });
  assert.equal(save.ok, true);
  assert.equal(d1.rows.has("review:huge-review"), false,
    "a linha antiga do D1 é derrubada para não vencer a leitura com doc velho");
  assert.ok(kv.values.has("review:huge-review"));

  const meta = await post(env, "/session/meta", { attachmentId: "huge-review" });
  assert.equal(meta.commentCount, 1, "continua servido pelo KV");
  assert.equal(d1.rows.has("review:huge-review"), false,
    "a leitura também respeita o teto (sem lazy)");
});

// ── Redirecionamento de linhagem (links físicos/hash antigos) ───────────────

async function seedLineage(env) {
  await post(env, "/session/version", {
    reviewId: "stable-lineage",
    versionId: "v1",
    attachmentId: "phys-v1",
    mediaUrl: "https://files.test/percent%20name%C2%B7v1.mov",
    mediaTitle: "V1.mov",
  });
  await post(env, "/session/version", {
    reviewId: "stable-lineage",
    versionId: "v2",
    attachmentId: "phys-v2",
    mediaUrl: "https://files.test/percent%20name%C2%B7v2.mov",
    mediaTitle: "V2.mov",
  });
  await post(env, "/session/save", {
    reviewId: "stable-lineage",
    versionId: "v2",
    status: "changes_requested",
    comments: [{ id: "c1", body: "na v2", resolved: false }],
  });
}

test("resolving a physical version attachment id opens the stable lineage, never an orphan", async () => {
  const env = { REVIEWS: new MemoryKV(), DB: new FakeD1() };
  await seedLineage(env);

  const resolved = await post(env, "/session/resolve", {
    attachmentId: "phys-v2",
    taskId: "t1",
    mediaUrl: "https://files.test/percent%20name%C2%B7v2.mov",
    mediaTitle: "V2.mov",
    mediaKind: "video",
  });

  assert.equal(resolved.reviewId, "stable-lineage",
    "o cliente adota o reviewId estável devolvido");
  assert.deepEqual(resolved.versions.map((v) => v.versionId), ["v1", "v2"]);
  const meta = await post(env, "/session/meta", { attachmentId: "phys-v2" });
  assert.equal(meta.exists, true);
  assert.equal(meta.reviewId, "stable-lineage");
});

test("resolving an unknown hash with a known mediaUrl redirects to the lineage (match exato por instr)", async () => {
  const env = { REVIEWS: new MemoryKV(), DB: new FakeD1() };
  await seedLineage(env);
  // Doc "isca": URL parecida mas diferente não pode casar (match é substring
  // exata do JSON, sem curingas).
  await post(env, "/session/version", {
    reviewId: "decoy-review",
    versionId: "v1",
    attachmentId: "decoy-att",
    mediaUrl: "https://files.test/percentXnameYv2.mov",
  });

  const resolved = await post(env, "/session/resolve", {
    attachmentId: "hash-desconhecido-123",
    taskId: "t1",
    mediaUrl: "https://files.test/percent%20name%C2%B7v2.mov",
    mediaTitle: "V2.mov",
    mediaKind: "video",
  });

  assert.equal(resolved.reviewId, "stable-lineage");
});

test("a key with its own document is never redirected", async () => {
  const env = { REVIEWS: new MemoryKV(), DB: new FakeD1() };
  await seedLineage(env);
  await post(env, "/session/resolve", {
    attachmentId: "independent-review",
    taskId: "t2",
    mediaUrl: "https://files.test/other.mov",
    mediaTitle: "Other.mov",
    mediaKind: "video",
  });

  const again = await post(env, "/session/resolve", {
    attachmentId: "independent-review",
    taskId: "t2",
    mediaUrl: "https://files.test/other.mov",
    mediaTitle: "Other.mov",
    mediaKind: "video",
  });
  assert.equal(again.reviewId, "independent-review");
});

test("an unknown attachment with unknown media still creates a fresh session", async () => {
  const env = { REVIEWS: new MemoryKV(), DB: new FakeD1() };
  await seedLineage(env);
  const resolved = await post(env, "/session/resolve", {
    attachmentId: "brand-new-att",
    taskId: "t3",
    mediaUrl: "https://files.test/brand-new.mov",
    mediaTitle: "Novo.mov",
    mediaKind: "video",
  });
  assert.equal(resolved.reviewId, "brand-new-att");
});

// ── Cache do /session/meta ──────────────────────────────────────────────────

class FakeCache {
  constructor() { this.entries = new Map(); }
  async match(request) {
    const entry = this.entries.get(request.url);
    if (!entry) return undefined;
    return new Response(entry.body, { status: entry.status, headers: entry.headers });
  }
  async put(request, response) {
    this.entries.set(request.url, {
      body: await response.clone().text(),
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    });
  }
  async delete(request) { return this.entries.delete(request.url); }
}

async function withFakeCache(run) {
  const previous = globalThis.caches;
  globalThis.caches = { default: new FakeCache() };
  try {
    return await run(globalThis.caches.default);
  } finally {
    if (previous === undefined) delete globalThis.caches;
    else globalThis.caches = previous;
  }
}

test("a burst of identical meta polls performs one primary KV read inside the TTL", async () => {
  await withFakeCache(async () => {
    const kv = new CountingKV();
    const env = { REVIEWS: kv };
    await post(env, "/session/version", {
      reviewId: "burst-review",
      versionId: "v2",
      attachmentId: "attachment-v2",
      mediaUrl: "https://files.test/v2.mov",
    });

    const before = kv.reads;
    const answers = [];
    for (let index = 0; index < 8; index += 1) {
      answers.push(await post(env, "/session/meta", {
        attachmentId: "burst-review", versionId: "v2",
      }));
    }
    assert.equal(kv.reads - before, 1,
      "8 polls idênticos dentro do TTL = 1 leitura primária de KV");
    for (const answer of answers) {
      assert.equal(answer.evaluatedVersionId, "v2");
    }
  });
});

test("save and conclude invalidate the cached meta immediately", async () => {
  await withFakeCache(async () => {
    const env = { REVIEWS: new CountingKV() };
    await post(env, "/session/version", {
      reviewId: "invalidate-review",
      versionId: "v1",
      attachmentId: "attachment-v1",
      mediaUrl: "https://files.test/v1.mov",
    });

    const pristine = await post(env, "/session/meta", {
      attachmentId: "invalidate-review", versionId: "v1",
    });
    assert.equal(pristine.commentCount, 0);

    await post(env, "/session/save", {
      reviewId: "invalidate-review",
      versionId: "v1",
      status: "changes_requested",
      comments: [{ id: "c1", body: "novo", resolved: false }],
    });
    const afterSave = await post(env, "/session/meta", {
      attachmentId: "invalidate-review", versionId: "v1",
    });
    assert.equal(afterSave.commentCount, 1,
      "o save deve derrubar a resposta cacheada");

    await post(env, "/session/conclude", {
      reviewId: "invalidate-review",
      versionId: "v1",
      status: "approved",
      comments: [{ id: "c1", body: "novo", resolved: true }],
    });
    const afterConclude = await post(env, "/session/meta", {
      attachmentId: "invalidate-review", versionId: "v1",
    });
    assert.equal(afterConclude.status, "approved");
    assert.notEqual(afterConclude.concludedAt, null,
      "a conclusão deve ser observável no poll seguinte");
  });
});

test("an exhausted KV read quota fails loudly without corrupting state", async () => {
  const kv = new MemoryKV();
  const env = { REVIEWS: kv };
  await post(env, "/session/version", {
    reviewId: "quota-review",
    versionId: "v1",
    attachmentId: "attachment-v1",
    mediaUrl: "https://files.test/v1.mov",
  });
  const stored = kv.values.get("review:quota-review");

  const failing = {
    REVIEWS: {
      async get() { throw new Error("KV get() limit exceeded for the day."); },
      async put() { throw new Error("write must never happen after a failed read"); },
    },
  };
  const save = await postWithStatus(failing, "/session/save", {
    reviewId: "quota-review",
    versionId: "v1",
    status: "approved",
    comments: [],
  });
  assert.equal(save.status, 502, "cota esgotada é erro real, nunca sucesso");
  assert.match(save.json.error, /limit exceeded/);

  const conclude = await postWithStatus(failing, "/session/conclude", {
    reviewId: "quota-review",
    versionId: "v1",
    status: "approved",
    comments: [],
  });
  assert.equal(conclude.status, 502);
  assert.equal(kv.values.get("review:quota-review"), stored,
    "o documento persistido permanece intacto");
});
