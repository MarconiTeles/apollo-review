import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Annotation, AnnotationGeom, ReviewComment } from "../contract/model";
import { drawAnnotations, fitRect, type Rect } from "./draw";
import {
  anchorLabel,
  encodeInlinePayload,
  mediaKindFor,
  type ReviewPayload,
} from "./payload";

type Tool = "select" | "rect" | "ellipse" | "arrow" | "line" | "freehand" | "text";
const TOOLS: { id: Tool; label: string; glyph: string }[] = [
  { id: "select", label: "Selecionar", glyph: "↖" },
  { id: "rect", label: "Retângulo", glyph: "▭" },
  { id: "ellipse", label: "Elipse", glyph: "◯" },
  { id: "arrow", label: "Seta", glyph: "↗" },
  { id: "line", label: "Linha", glyph: "／" },
  { id: "freehand", label: "Livre", glyph: "✎" },
  { id: "text", label: "Texto", glyph: "T" },
];
const COLORS = ["#C7321B", "#1E6Fd9", "#3F7D4E", "#E0A100", "#14130F", "#FFFFFF"];
const STATUSES: { id: string; label: string }[] = [
  { id: "in_review", label: "Em revisão" },
  { id: "changes_requested", label: "Pede alterações" },
  { id: "approved", label: "Aprovado" },
];

interface Draft {
  tool: Tool;
  color: string;
  start: { x: number; y: number };
  cur: { x: number; y: number };
  points: { x: number; y: number }[];
}

// Serverless proxy that posts the review comment to ClickUp (see
// worker/clickup-proxy.js). Empty until deployed → "Concluir" falls back to a
// copy/paste. Set this to the deployed Worker URL to post directly to ClickUp.
const WORKER_URL = "https://apollo-review-proxy.marconimpn.workers.dev";

export default function Editor({ payload }: { payload: ReviewPayload }) {
  const kind = mediaKindFor(payload.ext);
  const timed = kind === "video" || kind === "audio";

  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(COLORS[0]);
  const [status, setStatus] = useState(payload.status || "in_review");
  const [currentMs, setCurrentMs] = useState(0);
  const [comments, setComments] = useState<ReviewComment[]>(payload.comments ?? []);
  const [pending, setPending] = useState<Annotation[]>([]);
  const [body, setBody] = useState("");
  const [done, setDone] = useState<string | null>(null); // paste fallback text ("" when posted)
  const [postedOk, setPostedOk] = useState(false);        // true when the proxy posted to ClickUp

  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draftRef = useRef<Draft | null>(null);

  const contentRect = useCallback((): { rect: Rect; box: [number, number] } | null => {
    const media: HTMLVideoElement | HTMLImageElement | null =
      kind === "image" ? imgRef.current : videoRef.current;
    const canvas = canvasRef.current;
    if (!media || !canvas) return null;
    const boxW = media.clientWidth, boxH = media.clientHeight;
    const iW = kind === "image"
      ? (media as HTMLImageElement).naturalWidth
      : (media as HTMLVideoElement).videoWidth;
    const iH = kind === "image"
      ? (media as HTMLImageElement).naturalHeight
      : (media as HTMLVideoElement).videoHeight;
    return { rect: fitRect(boxW, boxH, iW, iH), box: [boxW, boxH] };
  }, [kind]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const info = contentRect();
    if (!canvas || !info) return;
    const { rect, box } = info;
    const [boxW, boxH] = box;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(boxW * dpr) || canvas.height !== Math.round(boxH * dpr)) {
      canvas.width = Math.round(boxW * dpr);
      canvas.height = Math.round(boxH * dpr);
    }
    canvas.style.width = `${boxW}px`;
    canvas.style.height = `${boxH}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, boxW, boxH);
    drawAnnotations(ctx, pending, rect);
    if (draftRef.current) drawAnnotations(ctx, [draftToAnnotation(draftRef.current)], rect);
  }, [contentRect, pending]);

  useLayoutEffect(() => { redraw(); }, [redraw]);
  const redrawRef = useRef(redraw);
  redrawRef.current = redraw;
  useEffect(() => {
    const media: Element | null = kind === "image" ? imgRef.current : videoRef.current;
    if (!media) return;
    const ro = new ResizeObserver(() => redrawRef.current());
    ro.observe(media);
    const onWin = () => redrawRef.current();
    window.addEventListener("resize", onWin);
    return () => { ro.disconnect(); window.removeEventListener("resize", onWin); };
  }, [kind]);

  // ── Pointer → normalized coords within the content rect ────────────────
  const toNorm = (e: React.PointerEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    const info = contentRect();
    if (!canvas || !info) return null;
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const { rect } = info;
    const x = (px - rect.x) / rect.w, y = (py - rect.y) / rect.h;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (tool === "select") return;
    const p = toNorm(e);
    if (!p) return;
    if (tool === "text") {
      const t = window.prompt("Texto da marcação:");
      if (t && t.trim()) {
        setPending((prev) => [...prev, mkAnnotation({ shape: "text", x: p.x, y: p.y, text: t.trim() }, color)]);
      }
      return;
    }
    (e.target as Element).setPointerCapture(e.pointerId);
    draftRef.current = { tool, color, start: p, cur: p, points: [p] };
    redraw();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!draftRef.current) return;
    const p = toNorm(e);
    if (!p) return;
    draftRef.current.cur = p;
    if (draftRef.current.tool === "freehand") draftRef.current.points.push(p);
    redraw();
  };
  const onPointerUp = () => {
    const d = draftRef.current;
    draftRef.current = null;
    if (!d) return;
    const ann = draftToAnnotation(d);
    // Ignore zero-size accidental clicks for shapes.
    if (d.tool !== "freehand") {
      const dx = Math.abs(d.cur.x - d.start.x), dy = Math.abs(d.cur.y - d.start.y);
      if (dx < 0.01 && dy < 0.01) { redraw(); return; }
    } else if (d.points.length < 2) { redraw(); return; }
    setPending((prev) => [...prev, ann]);
  };

  // ── Comment creation ───────────────────────────────────────────────────
  const addComment = () => {
    if (!body.trim() && pending.length === 0) return;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const anns = pending.map((a) => ({ ...a, commentId: id }));
    const c: ReviewComment = {
      id, reviewId: payload.taskId || "web", versionId: "v1",
      authorClickupId: payload.uploaderId ?? 0, authorName: "Revisor",
      body: body.trim(),
      anchor: timed ? { kind: "video", timeMs: currentMs } : { kind: "image" },
      parentId: null, resolved: false, annotations: anns,
      createdAt: now, updatedAt: now,
    };
    setComments((prev) => [...prev, c]);
    setPending([]);
    setBody("");
  };

  const seek = (c: ReviewComment) => {
    if (c.anchor.kind === "video" && videoRef.current) {
      videoRef.current.currentTime = c.anchor.timeMs / 1000;
      setCurrentMs(c.anchor.timeMs);
    }
  };

  // ── Finish → POST directly to ClickUp via the serverless proxy ─────────
  const finish = async () => {
    const out: ReviewPayload = { ...payload, status, comments, summaryText: summarize(comments, status, payload.mediaTitle) };
    const z = await encodeInlinePayload(out);
    const base = window.location.origin + window.location.pathname.replace(/index\.html$/, "");
    const viewerLink = `${base}?z=${z}`;
    // Rich comment: an optional real @mention (type:"tag" + user.id — the form
    // that actually notifies + renders the chip; a plain "@name" pings nobody),
    // the analysis, then a clean "VER REVIEW" hyperlink.
    const segments: Array<Record<string, unknown>> = [];
    if (out.uploaderId) {
      const name = out.uploaderName ? `@${out.uploaderName}` : "@";
      segments.push({ text: name, type: "tag", user: { id: out.uploaderId } });
      segments.push({ text: "\n" });
    }
    segments.push({ text: `${out.summaryText}\n\n▶ ` });
    segments.push({ text: "VER REVIEW", attributes: { link: viewerLink } });
    const pasteText = `${out.summaryText}\n\n▶ VER REVIEW: ${viewerLink}`;

    // PRIMARY: post straight to ClickUp through the proxy (no Apollo needed).
    if (WORKER_URL && out.taskId) {
      try {
        const r = await fetch(WORKER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: out.taskId, segments, assignee: out.uploaderId ?? undefined }),
        });
        const data = await r.json();
        if (r.ok && data.ok) { setPostedOk(true); setDone(""); return; }
      } catch {
        /* fall through to paste */
      }
    }
    // FALLBACK (proxy not configured yet): a paste-able comment.
    setPostedOk(false);
    setDone(pasteText);
    try { await navigator.clipboard.writeText(pasteText); } catch { /* manual copy */ }
  };

  const ordered = useMemo(() => {
    const arr = [...comments];
    if (timed) arr.sort((a, b) => anchorMs(a) - anchorMs(b));
    return arr;
  }, [comments, timed]);

  return (
    <div className="viewer ed">
      <header className="vw-header">
        <div className="vw-title">
          <span className="vw-brand">Apollo Review · editar</span>
          <h1>{payload.mediaTitle || "Review"}</h1>
        </div>
        <div className="ed-statuswrap">
          <select className="ed-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <button className="ed-finish" onClick={finish}>Concluir review</button>
        </div>
      </header>

      <div className="ed-toolbar">
        {TOOLS.map((t) => (
          <button key={t.id} className={`ed-tool${tool === t.id ? " on" : ""}`}
                  title={t.label} onClick={() => setTool(t.id)}>
            <span className="ed-glyph">{t.glyph}</span>
          </button>
        ))}
        <div className="ed-sep" />
        {COLORS.map((c) => (
          <button key={c} className={`ed-color${color === c ? " on" : ""}`}
                  style={{ background: c }} title={c} onClick={() => setColor(c)} />
        ))}
      </div>

      <div className="vw-body">
        <section className="vw-stage">
          {kind === "video" && (
            <div className="vw-media-wrap">
              <video ref={videoRef} className="vw-media" src={payload.mediaUrl} controls playsInline
                     onTimeUpdate={(e) => setCurrentMs(Math.round(e.currentTarget.currentTime * 1000))}
                     onLoadedMetadata={redraw} />
              <canvas ref={canvasRef} className="vw-overlay ed-canvas"
                      style={{ pointerEvents: tool === "select" ? "none" : "auto", cursor: "crosshair" }}
                      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
            </div>
          )}
          {kind === "image" && (
            <div className="vw-media-wrap">
              <img ref={imgRef} className="vw-media" src={payload.mediaUrl} alt={payload.mediaTitle} onLoad={redraw} />
              <canvas ref={canvasRef} className="vw-overlay ed-canvas"
                      style={{ pointerEvents: tool === "select" ? "none" : "auto", cursor: "crosshair" }}
                      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
            </div>
          )}
          {kind !== "video" && kind !== "image" && (
            <div className="vw-audio"><div className="vw-audio-name">{payload.mediaTitle}</div>
              <p className="vw-muted">Marcação visual disponível só para vídeo e imagem.</p></div>
          )}
        </section>

        <aside className="vw-rail">
          <div className="ed-composer">
            <div className="ed-composer-meta">
              {timed && <span className="vw-stamp">{fmt(currentMs)}</span>}
              {pending.length > 0 && <span className="ed-pending">✎ {pending.length} marcação(ões)</span>}
              {pending.length > 0 && <button className="ed-clear" onClick={() => setPending([])}>limpar</button>}
            </div>
            <textarea className="ed-text" placeholder="Escreva o comentário…" value={body}
                      onChange={(e) => setBody(e.target.value)} rows={2} />
            <button className="ed-add" onClick={addComment}
                    disabled={!body.trim() && pending.length === 0}>Adicionar comentário</button>
          </div>
          <div className="vw-rail-head"><strong>{comments.length}</strong> comentário{comments.length === 1 ? "" : "s"}</div>
          <div className="vw-rail-list">
            {ordered.length === 0 && <div className="vw-empty">Marque o vídeo e adicione comentários.</div>}
            {ordered.map((c) => (
              <div className="vw-comment" key={c.id}>
                <button className="vw-comment-main" onClick={() => seek(c)}>
                  <div className="vw-comment-meta">
                    {timed && c.anchor.kind === "video" && <span className="vw-stamp">{anchorLabel(c)}</span>}
                    <span className="vw-author">{c.authorName}</span>
                    {c.annotations.length > 0 && <span className="vw-markup">✎</span>}
                  </div>
                  <div className="vw-comment-body">{c.body || <em>(marcação)</em>}</div>
                </button>
              </div>
            ))}
          </div>
        </aside>
      </div>

      {done !== null && (
        <div className="ed-modal" onClick={() => setDone(null)}>
          <div className="ed-modal-card" onClick={(e) => e.stopPropagation()}>
            <span className="vw-brand">Review concluído</span>
            {postedOk ? (
              <p className="vw-muted">✓ Comentário postado no ClickUp.</p>
            ) : (
              <>
                <p className="vw-muted">Copie e cole como comentário na tarefa do ClickUp:</p>
                <textarea className="ed-done" readOnly value={done} rows={6} onFocus={(e) => e.currentTarget.select()} />
              </>
            )}
            <div className="ed-modal-actions">
              {!postedOk && (
                <button className="ed-add" onClick={() => navigator.clipboard.writeText(done)}>Copiar de novo</button>
              )}
              <button className="ed-clear" onClick={() => setDone(null)}>Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────
function mkAnnotation(geom: AnnotationGeom, color: string): Annotation {
  return { id: crypto.randomUUID(), commentId: "", color, strokeWidth: 0.004, geom };
}

function draftToAnnotation(d: Draft): Annotation {
  const { start: s, cur: c } = d;
  let geom: AnnotationGeom;
  switch (d.tool) {
    case "rect":
    case "ellipse":
      geom = { shape: d.tool, x: Math.min(s.x, c.x), y: Math.min(s.y, c.y),
               w: Math.abs(c.x - s.x), h: Math.abs(c.y - s.y) };
      break;
    case "arrow":
    case "line":
      geom = { shape: d.tool, x1: s.x, y1: s.y, x2: c.x, y2: c.y };
      break;
    case "freehand":
      geom = { shape: "freehand", points: d.points };
      break;
    default:
      geom = { shape: "rect", x: s.x, y: s.y, w: 0, h: 0 };
  }
  return mkAnnotation(geom, d.color);
}

function anchorMs(c: ReviewComment): number {
  return c.anchor.kind === "video" ? c.anchor.timeMs : Number.MAX_SAFE_INTEGER;
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function summarize(comments: ReviewComment[], status: string, title: string): string {
  const total = comments.length;
  const resolved = comments.filter((c) => c.resolved).length;
  const label = status === "approved" ? "Aprovado"
    : status === "changes_requested" ? "Pede alterações" : "Em revisão";
  const lines: string[] = [];
  if (title) lines.push(title); // filename first, before anything else
  lines.push(`📝 Review (${label}) — ${total} comentário(s), ${resolved} resolvido(s):`);
  for (const c of comments) {
    const mark = c.annotations.length ? " ✎" : "";
    lines.push(`• [${anchorLabel(c)}]${mark} ${c.body || "(marcação)"}`);
  }
  return lines.join("\n");
}
