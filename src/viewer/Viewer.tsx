import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Annotation, ReviewComment } from "../contract/model";
import { drawAnnotations, fitRect } from "./draw";
import { anchorLabel, mediaKindFor, statusInfo, type ReviewPayload } from "./payload";

const POINT_TOLERANCE_MS = 350;

export default function Viewer({ payload }: { payload: ReviewPayload }) {
  const kind = mediaKindFor(payload.ext);
  const timed = kind === "video" || kind === "audio";

  const [currentMs, setCurrentMs] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Top-level comments, sorted by time for timed media, plus their replies.
  const { ordered, repliesOf } = useMemo(() => {
    const replies = new Map<string, ReviewComment[]>();
    const tops: ReviewComment[] = [];
    for (const c of payload.comments) {
      if (c.parentId) {
        const arr = replies.get(c.parentId) ?? [];
        arr.push(c);
        replies.set(c.parentId, arr);
      } else tops.push(c);
    }
    if (timed) {
      tops.sort((a, b) => anchorMs(a) - anchorMs(b));
    }
    return { ordered: tops, repliesOf: (id: string) => replies.get(id) ?? [] };
  }, [payload.comments, timed]);

  // Which annotations are visible right now.
  const visibleAnnotations = useMemo<Annotation[]>(() => {
    if (kind === "image") return payload.comments.flatMap((c) => c.annotations);
    if (!timed) return [];
    const out: Annotation[] = [];
    for (const c of payload.comments) {
      if (c.anchor.kind !== "video") continue;
      const active =
        c.id === selectedId ||
        (c.anchor.endMs != null && c.anchor.endMs > c.anchor.timeMs
          ? currentMs >= c.anchor.timeMs && currentMs <= c.anchor.endMs
          : Math.abs(currentMs - c.anchor.timeMs) <= POINT_TOLERANCE_MS);
      if (active) out.push(...c.annotations);
    }
    return out;
  }, [payload.comments, kind, timed, currentMs, selectedId]);

  // ── Canvas overlay rendering ───────────────────────────────────────────
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const media: HTMLVideoElement | HTMLImageElement | null =
      kind === "image" ? imgRef.current : videoRef.current;
    if (!media) return;

    const boxW = media.clientWidth;
    const boxH = media.clientHeight;
    const iW = kind === "image"
      ? (media as HTMLImageElement).naturalWidth
      : (media as HTMLVideoElement).videoWidth;
    const iH = kind === "image"
      ? (media as HTMLImageElement).naturalHeight
      : (media as HTMLVideoElement).videoHeight;

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
    const rect = fitRect(boxW, boxH, iW, iH);
    drawAnnotations(ctx, visibleAnnotations, rect);
  }, [kind, visibleAnnotations]);

  // Redraw whenever the visible set changes.
  useLayoutEffect(() => {
    redraw();
  }, [redraw, currentMs]);

  // Keep a ref to the latest redraw so the ResizeObserver always calls fresh.
  const redrawRef = useRef(redraw);
  redrawRef.current = redraw;
  useEffect(() => {
    const media: Element | null = kind === "image" ? imgRef.current : videoRef.current;
    if (!media) return;
    const ro = new ResizeObserver(() => redrawRef.current());
    ro.observe(media);
    const onWin = () => redrawRef.current();
    window.addEventListener("resize", onWin);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWin);
    };
  }, [kind]);

  // ── Seeking ────────────────────────────────────────────────────────────
  const seekTo = useCallback(
    (c: ReviewComment) => {
      setSelectedId(c.id);
      if (c.anchor.kind === "video") {
        const el = videoRef.current ?? audioRef.current;
        if (el) {
          el.currentTime = c.anchor.timeMs / 1000;
          setCurrentMs(c.anchor.timeMs);
        }
      }
    },
    [],
  );

  const onTime = useCallback((e: React.SyntheticEvent<HTMLMediaElement>) => {
    setCurrentMs(Math.round(e.currentTarget.currentTime * 1000));
  }, []);

  const status = statusInfo(payload.status);
  const total = payload.comments.length;
  const resolved = payload.comments.filter((c) => c.resolved).length;

  return (
    <div className="viewer">
      <header className="vw-header">
        <div className="vw-title">
          <span className="vw-brand">Apollo Review</span>
          <h1>{payload.mediaTitle || "Review"}</h1>
        </div>
        <div className={`vw-status vw-status--${status.tone}`}>
          <span className="vw-dot" />
          {status.label}
        </div>
      </header>

      <div className="vw-body">
        <section className="vw-stage">
          {kind === "video" && (
            <div className="vw-media-wrap">
              <video
                ref={videoRef}
                className="vw-media"
                src={payload.mediaUrl}
                controls
                playsInline
                onTimeUpdate={onTime}
                onLoadedMetadata={redraw}
              />
              <canvas ref={canvasRef} className="vw-overlay" />
            </div>
          )}

          {kind === "image" && (
            <div className="vw-media-wrap">
              <img
                ref={imgRef}
                className="vw-media"
                src={payload.mediaUrl}
                alt={payload.mediaTitle}
                onLoad={redraw}
              />
              <canvas ref={canvasRef} className="vw-overlay" />
            </div>
          )}

          {kind === "audio" && (
            <div className="vw-audio">
              <div className="vw-audio-name">{payload.mediaTitle}</div>
              <audio
                ref={audioRef}
                src={payload.mediaUrl}
                controls
                onTimeUpdate={onTime}
              />
            </div>
          )}

          {kind === "document" && (
            <iframe className="vw-doc" src={payload.mediaUrl} title={payload.mediaTitle} />
          )}
        </section>

        <aside className="vw-rail">
          <div className="vw-rail-head">
            <strong>{total}</strong> comentário{total === 1 ? "" : "s"}
            {resolved > 0 && <span className="vw-resolved"> · {resolved} resolvido{resolved === 1 ? "" : "s"}</span>}
          </div>
          <div className="vw-rail-list">
            {ordered.length === 0 && <div className="vw-empty">Sem comentários neste review.</div>}
            {ordered.map((c) => (
              <CommentRow
                key={c.id}
                comment={c}
                replies={repliesOf(c.id)}
                selected={selectedId === c.id}
                timed={timed}
                onSelect={seekTo}
              />
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  replies,
  selected,
  timed,
  onSelect,
}: {
  comment: ReviewComment;
  replies: ReviewComment[];
  selected: boolean;
  timed: boolean;
  onSelect: (c: ReviewComment) => void;
}) {
  const label = anchorLabel(comment);
  const hasMarkup = comment.annotations.length > 0;
  return (
    <div className={`vw-comment${selected ? " is-selected" : ""}${comment.resolved ? " is-resolved" : ""}`}>
      <button className="vw-comment-main" onClick={() => onSelect(comment)}>
        <div className="vw-comment-meta">
          {timed && label !== "—" ? (
            <span className="vw-stamp">{label}</span>
          ) : label !== "—" ? (
            <span className="vw-stamp vw-stamp--page">{label}</span>
          ) : null}
          <span className="vw-author">{comment.authorName || "Reviewer"}</span>
          {hasMarkup && <span className="vw-markup" title="tem marcação">✎</span>}
          {comment.resolved && <span className="vw-check" title="resolvido">✓</span>}
        </div>
        <div className="vw-comment-body">{comment.body || <em>(marcação)</em>}</div>
      </button>
      {replies.length > 0 && (
        <div className="vw-replies">
          {replies.map((r) => (
            <div className="vw-reply" key={r.id}>
              <span className="vw-author">{r.authorName || "Reviewer"}</span>
              <span className="vw-comment-body">{r.body}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function anchorMs(c: ReviewComment): number {
  return c.anchor.kind === "video" ? c.anchor.timeMs : Number.MAX_SAFE_INTEGER;
}
