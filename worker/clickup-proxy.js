// Apollo Review — ClickUp comment proxy (Cloudflare Worker).
//
// WHY: a static web page (GitHub Pages) can't post to ClickUp — the API needs a
// token, and putting a token in the page would expose it to everyone. This tiny
// Worker holds the token as a SECRET (never shipped to the browser) and posts
// the review comment on the web reviewer's behalf. So the web "Concluir review"
// posts to ClickUp directly, with NO dependency on the Apollo app.
//
// ── Deploy (one time) ─────────────────────────────────────────────────────
//   1. Create a free Cloudflare account.
//   2. cd apollo-review/worker
//   3. npx wrangler login
//   4. npx wrangler secret put CLICKUP_TOKEN     # paste your pk_… token
//   5. npx wrangler deploy
//   6. Copy the printed URL (https://apollo-review-proxy.<you>.workers.dev) and
//      set WORKER_URL in src/viewer/Editor.tsx (or tell Claude to).
//
// The token lives only as a Cloudflare secret. The browser only ever talks to
// this Worker, never to ClickUp directly.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    if (!env.CLICKUP_TOKEN) return json({ error: "CLICKUP_TOKEN not configured" }, 500);

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    const { taskId, segments, assignee } = payload;
    if (!taskId || !Array.isArray(segments) || segments.length === 0) {
      return json({ error: "missing taskId/segments" }, 400);
    }

    const body = { comment: segments, notify_all: false };
    if (assignee) body.assignee = assignee;

    const r = await fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}/comment`, {
      method: "POST",
      headers: { Authorization: env.CLICKUP_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    return json({ ok: r.ok, id: data.id ?? null, status: r.status }, r.ok ? 200 : 502);
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
