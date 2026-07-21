import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Annotation, AnnotationGeom, ReviewComment, TextBoxGeom } from "../contract/model";
import { annotationBBox, drawAnnotations, fitRect, translateAnnotation, type Rect } from "./draw";
import {
  anchorLabel,
  encodeInlinePayload,
  mediaKindFor,
  type ReviewPayload,
} from "./payload";
import {
  concludeSession,
  saveSession,
  WORKER_URL,
  type ReviewVersionState,
  type SessionContext,
} from "../contract/session";

// ── Tools / palette / status ────────────────────────────────────────────
//
// `select` is the cursor — the default and the state we revert to after
// any annotation is placed, so clicks on existing markup select instead
// of accidentally drawing on top of them.

type Tool = "select" | "rect" | "ellipse" | "arrow" | "line" | "freehand" | "text";
const TOOLS: { id: Tool; label: string; glyph?: string; icon?: "pointer" }[] = [
  { id: "select", label: "Selecionar", icon: "pointer" },
  { id: "rect", label: "Retângulo", glyph: "▭" },
  { id: "ellipse", label: "Elipse", glyph: "◯" },
  { id: "arrow", label: "Seta", glyph: "↗" },
  { id: "line", label: "Linha", glyph: "／" },
  { id: "freehand", label: "Livre", glyph: "✎" },
  { id: "text", label: "Texto", glyph: "T" },
];
const COLORS = ["#7C5CFF", "#9B7FFF", "#6FB585", "#D4B860", "#E8E8EA", "#0A0A0B"];

// Stroke-width presets (× the displayed stage width).
const STROKES = [
  { id: "thin",   label: "Fino",   value: 0.0025, dot: 4 },
  { id: "medium", label: "Médio",  value: 0.0050, dot: 7 },
  { id: "thick",  label: "Grosso", value: 0.0090, dot: 10 },
] as const;
type StrokeChoice = typeof STROKES[number]["id"];

const STATUSES: { id: string; label: string }[] = [
  { id: "in_review", label: "Em revisão" },
  { id: "changes_requested", label: "Pede alterações" },
  { id: "approved", label: "Aprovado" },
];

// Aspect-ratio guides (matches PlayerModel.AspectGuide in Swift).
type Guide = "off" | "r9_16" | "r1_1" | "r4_5" | "r16_9" | "r2_39";
const GUIDES: { id: Guide; label: string; ratio: number | null }[] = [
  { id: "off",   label: "Sem guias", ratio: null      },
  { id: "r9_16", label: "9:16",      ratio: 9 / 16    },
  { id: "r1_1",  label: "1:1",       ratio: 1         },
  { id: "r4_5",  label: "4:5",       ratio: 4 / 5     },
  { id: "r16_9", label: "16:9",      ratio: 16 / 9    },
  { id: "r2_39", label: "2.39:1",    ratio: 2.39      },
];

// Zoom ladder mirrors PlayerModel.setZoom (1.25× steps, clamped to 8).
const ZOOM_STEP = 1.25;
const ZOOM_MAX  = 8;
const ZOOM_MIN  = 1;

// Speech-bubble surface + accent, aligned with Galileo Studio Dark.
const BUBBLE_PAPER  = "#1C1C1D";
const BUBBLE_ACCENT = "#7C5CFF";

interface Draft {
  tool: Tool;
  color: string;
  strokeValue: number;
  start: { x: number; y: number };
  cur: { x: number; y: number };
  points: { x: number; y: number }[];
}

const HISTORY_LIMIT = 80;

function reviewStateFingerprint(status: string, comments: ReviewComment[]): string {
  return JSON.stringify({ status, comments });
}

interface ReviewEditSnapshot {
  status: string;
  comments: ReviewComment[];
  pending: Annotation[];
  pendingFrameMs: number | null;
  selectedId: string | null;
  selectedCommentId: string | null;
}

// WORKER_URL (the serverless backend) is defined in ../contract/session.
// Empty → no server: "Concluir" falls back to a copy/paste link.

export default function Editor({
  payload,
  readOnly = false,
  session,
}: {
  payload: ReviewPayload;
  /** When true: no markup toolbar, no composer, no canvas gestures,
   *  no textBox / shape edit chrome. Used by the legacy "Ver review"
   *  path (`?z=`) so reviewers can re-read a posted review without
   *  drifting into edits. */
  readOnly?: boolean;
  /** Present → the review is a LIVE server-backed document (the single
   *  link): every change autosaves and "Concluir" edits the one ClickUp
   *  comment in place. Absent → legacy self-contained behaviour. */
  session?: SessionContext;
}) {
  const initialVersionId =
    session?.versionId || payload.versionId || session?.versions?.[session.versions.length - 1]?.versionId || "v1";
  const [selectedVersionId, setSelectedVersionId] = useState(initialVersionId);
  const [versionStates, setVersionStates] = useState<Record<string, ReviewVersionState>>(() =>
    initialVersionStates(session, payload, initialVersionId),
  );
  const activeVersion = session?.versions?.find((v) => v.versionId === selectedVersionId)
    || session?.versions?.[session.versions.length - 1];
  const activeMediaUrl = activeVersion?.mediaUrl || payload.mediaUrl;
  const activeMediaTitle = activeVersion?.mediaTitle || payload.mediaTitle;
  const activeExt = activeVersion?.ext || payload.ext;
  const kind = activeVersion?.mediaKind || mediaKindFor(activeExt);
  const timed = kind === "video" || kind === "audio";

  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(COLORS[0]);
  const [strokeId, setStrokeId] = useState<StrokeChoice>("medium");
  const strokeValue = STROKES.find((s) => s.id === strokeId)!.value;

  const [status, setStatus] = useState(
    versionStates[initialVersionId]?.status || payload.status || "in_review",
  );
  const [currentMs, setCurrentMs] = useState(0);
  const [comments, setComments] = useState<ReviewComment[]>(() =>
    cloneComments(versionStates[initialVersionId]?.comments ?? payload.comments ?? []),
  );
  const [deletingCommentIds, setDeletingCommentIds] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<Annotation[]>([]);
  const [body, setBody] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  /// ── Server-backed autosave (the single live link) ──────────────────────
  /// When `session` is present, every change to the comments or status is
  /// debounced and persisted to KV via the Worker, so "revisar" and "ver"
  /// share one always-current link. Navigation and lifecycle changes (open,
  /// close, selecting the already-active version, remount) are NOT edits and
  /// must never write. We therefore compare the current editor payload with
  /// the last payload actually loaded/saved instead of relying on effect-call
  /// order.
  const [saveState, setSaveState] =
    useState<"idle" | "saving" | "saved" | "error">("idle");
  const lastPersistedReviewFingerprints = useRef<Record<string, string>>(
    Object.fromEntries(
      Object.entries(versionStates).map(([versionId, state]) => [
        versionId,
        reviewStateFingerprint(state.status, state.comments),
      ]),
    ),
  );
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep an in-memory snapshot for every media version. Switching the video
  // must never keep the previous version's comments/status mounted.
  useEffect(() => {
    setVersionStates((current) => ({
      ...current,
      [selectedVersionId]: {
        ...current[selectedVersionId],
        status,
        comments: cloneComments(comments),
      },
    }));
  }, [comments, selectedVersionId, status]);

  useEffect(() => {
    if (!session || !WORKER_URL) return;
    const fingerprint = reviewStateFingerprint(status, comments);
    if (fingerprint === lastPersistedReviewFingerprints.current[selectedVersionId]) return;
    setSaveState("saving");
    const t = setTimeout(() => {
      saveTimerRef.current = null;
      saveSession({
        reviewId: session.reviewId,
        versionId: selectedVersionId,
        status,
        comments,
      })
        .then(() => {
          lastPersistedReviewFingerprints.current[selectedVersionId] = fingerprint;
          setSaveState("saved");
        })
        .catch(() => setSaveState("error"));
    }, 800);
    saveTimerRef.current = t;
    return () => {
      clearTimeout(t);
      if (saveTimerRef.current === t) saveTimerRef.current = null;
    };
  }, [comments, status, session, selectedVersionId]);

  /// Reviewer identity — captured client-side in the name dialog and
  /// persisted in localStorage. The web
  /// posts via the worker using the workspace owner's pk_ token,
  /// so ClickUp's byline is always the owner — the reviewer's
  /// name has to ride INSIDE the comment body so attribution is
  /// preserved at all. Each ReviewComment also carries the name
  /// so `summarize()` can prefix the posted summary with
  /// "Review por X".
  const REVIEWER_KEY = "apollo_review_reviewer_name";
  const [reviewerName, setReviewerName] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return (window.localStorage.getItem(REVIEWER_KEY) || "").trim();
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (reviewerName.trim()) {
      window.localStorage.setItem(REVIEWER_KEY, reviewerName.trim());
    }
  }, [reviewerName]);
  const reviewerReady = reviewerName.trim().length > 0;
  const reviewerId    = 0;   // unknown — comments ride the workspace owner's token

  const requestReviewerName = useCallback(() => {
    setNameDraft(reviewerName.trim());
    setNameDialogOpen(true);
  }, [reviewerName]);

  useEffect(() => {
    if (!nameDialogOpen) return;
    const t = window.setTimeout(() => nameInputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [nameDialogOpen]);

  const confirmReviewerName = useCallback(() => {
    const next = nameDraft.trim();
    if (!next) return;
    setReviewerName(next);
    window.localStorage.setItem(REVIEWER_KEY, next);
    setNameDialogOpen(false);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [nameDraft]);

  /// Currently-selected annotation (shape OR textBox), or null. Drives the
  /// dashed selection outline + the Delete key target.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /// Currently-selected COMMENT in the rail (separate from the shape
  /// selection above). Drives the accent wash on the comment row,
  /// matching Swift's `review.selectedCommentId`.
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);

  /// Pixel offset applied to the markup toolbar so the user can drag it
  /// out of the way of the artwork they're reviewing.
  const [toolbarOffset, setToolbarOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  /// While the media (video) is still buffering / not ready, show an
  /// Apollo Review splash over the stage instead of a blank canvas.
  const [mediaLoading, setMediaLoading] = useState<boolean>(kind === "video");
  const [splashElapsed, setSplashElapsed] = useState<boolean>(kind !== "video");
  const [splashVisible, setSplashVisible] = useState<boolean>(kind === "video");
  const [splashLeaving, setSplashLeaving] = useState(false);

  /// Pending shapes (mid-draw, not yet committed) belong to a single
  /// frame. Without this filter they'd float through every other frame
  /// of the video.
  const [pendingFrameMs, setPendingFrameMs] = useState<number | null>(null);

  const [undoStack, setUndoStack] = useState<ReviewEditSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<ReviewEditSnapshot[]>([]);

  const selectVersion = useCallback(async (nextVersionId: string) => {
    if (nextVersionId === selectedVersionId) return;

    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    // Flush the version being left before replacing the mounted editor state.
    // Without this, the debounce cleanup can discard a real edit on switch.
    if (session && WORKER_URL) {
      const fingerprint = reviewStateFingerprint(status, comments);
      if (fingerprint !== lastPersistedReviewFingerprints.current[selectedVersionId]) {
        setSaveState("saving");
        try {
          await saveSession({
            reviewId: session.reviewId,
            versionId: selectedVersionId,
            status,
            comments,
          });
          lastPersistedReviewFingerprints.current[selectedVersionId] = fingerprint;
          setSaveState("saved");
        } catch {
          setSaveState("error");
          return;
        }
      }
    }

    const target = versionStates[nextVersionId]
      ?? session?.versionStates?.[nextVersionId]
      ?? { status: "in_review", comments: [] };
    lastPersistedReviewFingerprints.current[nextVersionId] ??=
      reviewStateFingerprint(target.status, target.comments);
    setSelectedVersionId(nextVersionId);
    setStatus(target.status);
    setComments(cloneComments(target.comments));
    setSelectedId(null);
    setSelectedCommentId(null);
    setPending([]);
    setPendingFrameMs(null);
    setUndoStack([]);
    setRedoStack([]);
  }, [comments, selectedVersionId, session, status, versionStates]);

  const currentSnapshot = useCallback((): ReviewEditSnapshot => ({
    status,
    comments: cloneComments(comments),
    pending: cloneAnnotations(pending),
    pendingFrameMs,
    selectedId,
    selectedCommentId,
  }), [comments, pending, pendingFrameMs, selectedCommentId, selectedId, status]);

  const restoreSnapshot = useCallback((snapshot: ReviewEditSnapshot) => {
    setDeletingCommentIds(new Set());
    setStatus(snapshot.status);
    setComments(cloneComments(snapshot.comments));
    setPending(cloneAnnotations(snapshot.pending));
    setPendingFrameMs(snapshot.pendingFrameMs);
    setSelectedId(snapshot.selectedId);
    setSelectedCommentId(snapshot.selectedCommentId);
  }, []);

  const pushUndoSnapshot = useCallback(() => {
    const snapshot = currentSnapshot();
    setUndoStack((prev) => [...prev.slice(-(HISTORY_LIMIT - 1)), snapshot]);
    setRedoStack([]);
  }, [currentSnapshot]);

  const undoEdit = useCallback(() => {
    const snapshot = undoStack[undoStack.length - 1];
    if (!snapshot) return;
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev.slice(-(HISTORY_LIMIT - 1)), currentSnapshot()]);
    restoreSnapshot(snapshot);
  }, [currentSnapshot, restoreSnapshot, undoStack]);

  const redoEdit = useCallback(() => {
    const snapshot = redoStack[redoStack.length - 1];
    if (!snapshot) return;
    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((prev) => [...prev.slice(-(HISTORY_LIMIT - 1)), currentSnapshot()]);
    restoreSnapshot(snapshot);
  }, [currentSnapshot, redoStack, restoreSnapshot]);

  /// Tick / untick a comment's checkbox. The executor resolves each feedback
  /// item in the same live link; attribution rides the reviewer name. The
  /// autosave effect above pushes the change to the server.
  const toggleResolved = useCallback(
    (id: string) => {
      if (!comments.some((c) => c.id === id)) return;
      pushUndoSnapshot();
      setComments((prev) =>
        prev.map((c) => {
          if (c.id !== id) return c;
          const next = !c.resolved;
          return {
            ...c,
            resolved: next,
            resolvedByName: next ? reviewerName.trim() || null : null,
            resolvedAt: next ? new Date().toISOString() : null,
          };
        }),
      );
    },
    [comments, pushUndoSnapshot, reviewerName],
  );

  // ── Transport / range / zoom / guides (parity with the Swift app) ──────
  const [durationMs, setDurationMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  /// JKL shuttle speed. 0 → paused / playing forward at 1×. Negative →
  /// reverse. Magnitudes follow Frame.io's 2×·4×·8× ladder; the
  /// readout chip uses `|displayRate|` and a leading minus for reverse.
  const [displayRate, setDisplayRate] = useState(0);
  /// Mark In / Out for range comments. R cycles through.
  const [inMs, setInMs] = useState<number | null>(null);
  const [outMs, setOutMs] = useState<number | null>(null);
  /// Zoom + pan over the stage rect — matches PlayerModel.zoomScale /
  /// zoomPan in Swift.
  const [zoomScale, setZoomScale] = useState(1);
  const [zoomPan, setZoomPan] = useState({ x: 0, y: 0 });
  /// Aspect guide overlay. `off` hides; the named ratios show a centred
  /// rect with the matching W:H crop region.
  const [guide, setGuide] = useState<Guide>("off");
  /// Help-sheet visibility.
  const [showShortcuts, setShowShortcuts] = useState(false);
  /// Frames-per-second once the video metadata reveals it. Without
  /// reliable fps detection in HTML5 we default to 30 (the same fallback
  /// the Swift filter uses).
  const [fps] = useState<number>(30);
  /// Loop toggle (⌃L) — when on, end-of-playback jumps back to
  /// `inMs ?? 0` and resumes, matching Swift PlayerModel.isLooping.
  const [isLooping, setIsLooping] = useState(false);
  /// Floating markup toolbar visibility. Defaults closed — the
  /// composer's inline ✎ button (and the P shortcut) toggles it.
  const [markupOpen, setMarkupOpen] = useState(false);
  /// Mute state, mirrored to `videoRef.current.muted`.
  const [isMuted, setIsMuted] = useState(false);
  /// Forward playback speed (matches PlayerModel.speed). The shuttle
  /// (JKL) lives on `displayRate`; this one is the user-chosen
  /// "normal" rate the play button resumes to.
  const [speed, setSpeed] = useState(1);

  const videoRef    = useRef<HTMLVideoElement>(null);
  const reverseTimer = useRef<number | null>(null);
  const imgRef      = useRef<HTMLImageElement>(null);
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const stageRef    = useRef<HTMLDivElement>(null);
  const stageBoxRef = useRef<HTMLDivElement>(null);   // outer zoom container
  const draftRef    = useRef<Draft | null>(null);
  const toolbarRef  = useRef<HTMLDivElement>(null);   // for raw-DOM drag
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [stageBoxSize, setStageBoxSize] = useState({ w: 0, h: 0 });
  const [detectedMediaSize, setDetectedMediaSize] = useState<{ w: number; h: number } | null>(null);

  const clearReverse = useCallback(() => {
    if (reverseTimer.current !== null) {
      window.clearInterval(reverseTimer.current);
      reverseTimer.current = null;
    }
  }, []);

  useEffect(() => {
    if (kind !== "video") {
      setMediaLoading(false);
      setSplashElapsed(true);
      setSplashVisible(false);
      setSplashLeaving(false);
      return;
    }
    setMediaLoading(true);
    setSplashElapsed(false);
    setSplashVisible(true);
    setSplashLeaving(false);
    const t = window.setTimeout(() => setSplashElapsed(true), 2000);
    return () => window.clearTimeout(t);
  }, [kind, activeMediaUrl]);

  const shouldKeepSplash = kind === "video" && (!splashElapsed || mediaLoading);

  useEffect(() => {
    if (kind !== "video") return;
    if (shouldKeepSplash) {
      setSplashVisible(true);
      setSplashLeaving(false);
      return;
    }
    if (!splashVisible || splashLeaving) return;
    setSplashLeaving(true);
    const t = window.setTimeout(() => setSplashVisible(false), 520);
    return () => window.clearTimeout(t);
  }, [kind, shouldKeepSplash, splashLeaving, splashVisible]);

  const payloadMediaSize = useMemo(() => {
    const w = positiveSize(payload.mediaWidth ?? payload.width);
    const h = positiveSize(payload.mediaHeight ?? payload.height);
    return w && h ? { w, h } : null;
  }, [payload.height, payload.mediaHeight, payload.mediaWidth, payload.width]);

  const effectiveMediaSize = payloadMediaSize ?? detectedMediaSize;

  const mediaBoxStyle = useMemo(() => {
    if (!effectiveMediaSize || stageBoxSize.w <= 0 || stageBoxSize.h <= 0) return undefined;
    const r = fitRect(stageBoxSize.w, stageBoxSize.h, effectiveMediaSize.w, effectiveMediaSize.h);
    return { width: `${r.w}px`, height: `${r.h}px` };
  }, [effectiveMediaSize, stageBoxSize]);

  const rememberMediaSize = useCallback((media: HTMLVideoElement | HTMLImageElement | null) => {
    if (!media || payloadMediaSize) return;
    const w = kind === "image"
      ? (media as HTMLImageElement).naturalWidth
      : (media as HTMLVideoElement).videoWidth;
    const h = kind === "image"
      ? (media as HTMLImageElement).naturalHeight
      : (media as HTMLVideoElement).videoHeight;
    if (w > 0 && h > 0) setDetectedMediaSize({ w, h });
  }, [kind, payloadMediaSize]);

  // ── Content rect: where the media actually paints inside its box ───────
  const contentRect = useCallback((): { rect: Rect; box: [number, number] } | null => {
    const media: HTMLVideoElement | HTMLImageElement | null =
      kind === "image" ? imgRef.current : videoRef.current;
    const canvas = canvasRef.current;
    if (!media || !canvas) return null;
    const boxW = media.clientWidth, boxH = media.clientHeight;
    const intrinsic = payloadMediaSize ?? detectedMediaSize;
    const iW = intrinsic?.w ?? (kind === "image"
      ? (media as HTMLImageElement).naturalWidth
      : (media as HTMLVideoElement).videoWidth);
    const iH = intrinsic?.h ?? (kind === "image"
      ? (media as HTMLImageElement).naturalHeight
      : (media as HTMLVideoElement).videoHeight);
    return { rect: fitRect(boxW, boxH, iW, iH), box: [boxW, boxH] };
  }, [detectedMediaSize, kind, payloadMediaSize]);

  const [stageRect, setStageRect] = useState<Rect | null>(null);

  // ── Canvas paint (shapes only — textBoxes render as HTML overlays) ─────
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const info = contentRect();
    if (!canvas || !info) return;
    const { rect, box } = info;
    const [boxW, boxH] = box;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(boxW * dpr) || canvas.height !== Math.round(boxH * dpr)) {
      canvas.width  = Math.round(boxW * dpr);
      canvas.height = Math.round(boxH * dpr);
    }
    canvas.style.width  = `${boxW}px`;
    canvas.style.height = `${boxH}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, boxW, boxH);

    // 1) Committed shape annotations FOR THIS FRAME ONLY. The previous
    //    version painted every comment's annotations regardless of
    //    anchor.timeMs — that's why ellipses / arrows / freehand
    //    strokes from other frames bled onto the current frame. Now
    //    we filter exactly like the textBox layer does.
    const committedShapes = comments.flatMap((c) => {
      if (!c.annotations.length) return [];
      if (c.anchor.kind === "video") {
        if (!timed) return [];
        return commentIsActiveAtMs(c, currentMs) ? c.annotations : [];
      }
      // image / general / document — no time axis, always painted.
      return c.annotations;
    }).filter(notTextBox);
    drawAnnotations(ctx, committedShapes, rect);

    // 2) Pending shapes filtered to the frame they were started on.
    const pendingOnFrame = (timed && pendingFrameMs !== null
        ? (Math.abs(currentMs - pendingFrameMs) <= 50 ? pending : [])
        : pending);
    drawAnnotations(ctx, pendingOnFrame.filter(notTextBox), rect);

    // 3) Live draft.
    if (draftRef.current) {
      drawAnnotations(ctx, [draftToAnnotation(draftRef.current)], rect);
    }

    // 4) Dashed selection outline.
    if (selectedId) {
      const sel = findAnnotation(selectedId, pending, comments);
      if (sel) {
        const bb = annotationBBox(sel);
        const pad = 4;
        const rx = rect.x + bb.x * rect.w - pad;
        const ry = rect.y + bb.y * rect.h - pad;
        const rw = bb.w * rect.w + pad * 2;
        const rh = bb.h * rect.h + pad * 2;
        ctx.save();
        ctx.strokeStyle = BUBBLE_ACCENT;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.restore();
      }
    }

    // Keep the stageRect in sync so HTML overlays line up.
    setStageRect(rect);
  }, [contentRect, comments, pending, pendingFrameMs, currentMs, timed, selectedId]);

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

  useLayoutEffect(() => {
    const el = stageBoxRef.current;
    if (!el) return;
    const update = () => setStageBoxSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Pointer → normalised coords within the content rect ────────────────
  const toNorm = (e: React.PointerEvent | PointerEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    const info = contentRect();
    if (!canvas || !info) return null;
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const { rect } = info;
    const x = (px - rect.x) / rect.w, y = (py - rect.y) / rect.h;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };

  // ── Drawing handlers (shape tools + textBox spawn) ─────────────────────
  // All write-side handlers early-return in read-only — the canvas
  // stays interactive only for the underlying media's native controls.
  const onPointerDown = (e: React.PointerEvent) => {
    if (readOnly) return;
    if (tool === "select") {
      // Click on bare canvas (no annotation hit) — deselect.
      setSelectedId(null);
      return;
    }
    const p = toNorm(e);
    if (!p) return;
    if (tool === "text") {
      spawnTextBox(p);
      setTool("select");
      return;
    }
    (e.target as Element).setPointerCapture(e.pointerId);
    draftRef.current = { tool, color, strokeValue, start: p, cur: p, points: [p] };
    redraw();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (readOnly || !draftRef.current) return;
    const p = toNorm(e);
    if (!p) return;
    draftRef.current.cur = p;
    if (draftRef.current.tool === "freehand") draftRef.current.points.push(p);
    redraw();
  };
  const onPointerUp = () => {
    if (readOnly) return;
    const d = draftRef.current;
    draftRef.current = null;
    if (!d) return;
    if (d.tool !== "freehand") {
      const dx = Math.abs(d.cur.x - d.start.x), dy = Math.abs(d.cur.y - d.start.y);
      if (dx < 0.01 && dy < 0.01) { redraw(); return; }
    } else if (d.points.length < 2) { redraw(); return; }
    // AUTO-COMMIT: every drawn shape becomes its own body-less
    // comment immediately, just like a textBox. No staging area,
    // no Aplicar button — the act of drawing IS the commit.
    const ann = draftToAnnotation(d);
    const commentId = crypto.randomUUID();
    ann.commentId = commentId;
    const now = new Date().toISOString();
    pushUndoSnapshot();
    const c: ReviewComment = {
      id: commentId,
      reviewId: session?.reviewId ?? payload.taskId ?? "web",
      versionId: selectedVersionId,
      // No ClickUp id for the reviewer (they aren't necessarily in
      // the workspace); the BODY carries the human-readable name.
      authorClickupId: reviewerId,
      authorName: reviewerName || "Revisor",
      body: "",
      anchor: buildAnchor(),
      parentId: null,
      resolved: false,
      annotations: [ann],
      createdAt: now,
      updatedAt: now,
    };
    setComments((prev) => [...prev, c]);
    setSelectedId(ann.id);
    setTool("select");       // auto-revert after each placement
    clearRange();            // anchor consumed any active In/Out
  };

  /// Read the video element's actual currentTime (rather than the
  /// React `currentMs` state which is updated via `onTimeUpdate` and
  /// can lag the real frame by a tick). Guarantees that a freshly
  /// placed annotation is anchored to the EXACT frame the user clicked.
  const liveTimeMs = useCallback((): number => {
    const t = videoRef.current?.currentTime;
    if (typeof t === "number" && isFinite(t)) return Math.round(t * 1000);
    return currentMs;
  }, [currentMs]);

  // ── Spawn a fresh speech-bubble at the click point ─────────────────────
  const spawnTextBox = (p: { x: number; y: number }) => {
    const dw = 0.40, dh = 0.18;
    const nx = clamp(p.x - dw / 2, 0, Math.max(0, 1 - dw));
    const ny = clamp(p.y - dh - 0.04, 0, Math.max(0, 1 - dh));
    const id = crypto.randomUUID();
    const commentId = crypto.randomUUID();
    const now = new Date().toISOString();
    const geom: TextBoxGeom = {
      shape: "textBox",
      x: nx, y: ny, w: dw, h: dh,
      text: "",
      tailX: clamp(p.x, 0, 1),
      tailY: clamp(p.y, 0, 1),
    };
    const ann: Annotation = {
      id, commentId,
      color: BUBBLE_ACCENT,
      strokeWidth: strokeValue,
      geom,
    };
    const c: ReviewComment = {
      id: commentId,
      reviewId: session?.reviewId ?? payload.taskId ?? "web",
      versionId: selectedVersionId,
      authorClickupId: reviewerId,
      authorName: reviewerName || "Revisor",
      body: "",
      anchor: timed ? { kind: "video", timeMs: liveTimeMs() } : { kind: "image" },
      parentId: null,
      resolved: false,
      annotations: [ann],
      createdAt: now,
      updatedAt: now,
    };
    pushUndoSnapshot();
    setComments((prev) => [...prev, c]);
    setSelectedId(id);
  };

  // ── Mutators used by the interactive layers ────────────────────────────
  const updateAnnotation = useCallback((id: string, fn: (a: Annotation) => Annotation) => {
    setPending((prev) => {
      const i = prev.findIndex((a) => a.id === id);
      if (i < 0) return prev;
      const next = prev.slice();
      next[i] = fn(prev[i]);
      return next;
    });
    setComments((prev) => prev.map((c) => {
      const i = c.annotations.findIndex((a) => a.id === id);
      if (i < 0) return c;
      const anns = c.annotations.slice();
      anns[i] = fn(c.annotations[i]);
      // Mirror textBox text into the comment body so the rail / the
      // ClickUp comment carry the same content.
      let body = c.body;
      if (anns[i].geom.shape === "textBox") {
        body = (anns[i].geom as TextBoxGeom).text;
      }
      return { ...c, annotations: anns, body };
    }));
  }, []);

  const deleteAnnotation = useCallback((id: string) => {
    const exists = pending.some((a) => a.id === id) ||
      comments.some((c) => c.annotations.some((a) => a.id === id));
    if (!exists) return;
    pushUndoSnapshot();
    setPending((prev) => prev.filter((a) => a.id !== id));
    setComments((prev) => prev.flatMap((c) => {
      const i = c.annotations.findIndex((a) => a.id === id);
      if (i < 0) return [c];
      const wasTextBox = c.annotations[i].geom.shape === "textBox";
      const anns = c.annotations.filter((a) => a.id !== id);
      // A textBox owns its parent comment outright (it was created with
      // the comment). Other shape annotations only drop the comment if
      // it ends up empty (no annotations + no body).
      if (wasTextBox) return [];
      if (anns.length === 0 && !c.body.trim()) return [];
      return [{ ...c, annotations: anns }];
    }));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, [comments, pending, pushUndoSnapshot]);

  const deleteComment = useCallback((id: string) => {
    const removedComments = comments.filter((c) => c.id === id || c.parentId === id);
    const removedCommentIds = new Set(removedComments.map((c) => c.id));
    const removedAnnotationIds = new Set(removedComments.flatMap((c) => c.annotations.map((a) => a.id)));
    if (removedComments.length === 0 || removedComments.some((c) => deletingCommentIds.has(c.id))) return;

    pushUndoSnapshot();
    setDeletingCommentIds((prev) => {
      const next = new Set(prev);
      removedCommentIds.forEach((commentId) => next.add(commentId));
      return next;
    });
    window.setTimeout(() => {
      setComments((prev) => prev.filter((c) => !removedCommentIds.has(c.id) && c.parentId !== id));
      setDeletingCommentIds((prev) => {
        const next = new Set(prev);
        removedCommentIds.forEach((commentId) => next.delete(commentId));
        return next;
      });
      setSelectedCommentId((cur) => (cur && removedCommentIds.has(cur) ? null : cur));
      setSelectedId((cur) => (cur && removedAnnotationIds.has(cur) ? null : cur));
    }, 360);
  }, [comments, deletingCommentIds, pushUndoSnapshot]);

  /// Picks the right anchor for a freshly-finalised comment:
  ///  • Static media → `image` anchor (no time axis).
  ///  • In + Out both set → range comment.
  ///  • Otherwise → single-point video anchor at the pending-shape
  ///    frame, falling back to the live playhead.
  const buildAnchor = useCallback((): ReviewComment["anchor"] => {
    if (!timed) return { kind: "image" };
    if (inMs !== null && outMs !== null && outMs > inMs) {
      return { kind: "video", timeMs: inMs, endMs: outMs };
    }
    return { kind: "video", timeMs: pendingFrameMs ?? liveTimeMs() };
  }, [timed, inMs, outMs, pendingFrameMs, liveTimeMs]);

  const clearRange = () => {
    if (inMs !== null) setInMs(null);
    if (outMs !== null) setOutMs(null);
  };

  // ── Comment composer (non-textBox flow, kept for timed media rail) ─────
  const addComment = () => {
    if (!reviewerReady) {
      requestReviewerName();
      return;
    }
    if (!body.trim() && pending.length === 0) return;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const anns = pending.map((a) => ({ ...a, commentId: id }));
    const c: ReviewComment = {
      id,
      reviewId: session?.reviewId ?? payload.taskId ?? "web",
      versionId: selectedVersionId,
      authorClickupId: reviewerId, authorName: reviewerName || "Revisor",
      body: body.trim(), anchor: buildAnchor(),
      parentId: null, resolved: false, annotations: anns,
      createdAt: now, updatedAt: now,
    };
    pushUndoSnapshot();
    setComments((prev) => [...prev, c]);
    setPending([]);
    setPendingFrameMs(null);
    setBody("");
    clearRange();
  };

  const seek = (c: ReviewComment) => {
    setSelectedCommentId(c.id);              // highlight the row
    if (c.anchor.kind === "video" && videoRef.current) {
      if (reverseTimer.current !== null) {
        clearReverse();
        setDisplayRate(0);
      }
      videoRef.current.currentTime = c.anchor.timeMs / 1000;
      setCurrentMs(c.anchor.timeMs);
    }
  };

  // ── Transport helpers (Frame.io / Swift PlayerModel parity) ────────────
  const togglePlay = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    if (displayRate < 0 || reverseTimer.current !== null) {
      clearReverse();
      v.pause();
      setDisplayRate(0);
      return;
    }
    if (v.paused) {
      v.playbackRate = speed;
      void v.play();
      setDisplayRate(speed);
    } else {
      v.pause();
      setDisplayRate(0);
    }
  }, [clearReverse, displayRate, speed]);
  const pause = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    clearReverse();
    v.pause(); setDisplayRate(0);
  }, [clearReverse]);
  const seekToMs = useCallback((ms: number) => {
    const v = videoRef.current; if (!v) return;
    if (reverseTimer.current !== null) {
      clearReverse();
      setDisplayRate(0);
    }
    const clamped = Math.max(0, durationMs > 0 ? Math.min(ms, durationMs) : ms);
    v.currentTime = clamped / 1000;
    setCurrentMs(clamped);
  }, [clearReverse, durationMs]);
  /// Frame-accurate step (negative = back). Pauses first so the seek lands
  /// exactly on the target frame. Defaults to 30 fps when the source
  /// doesn't expose `videoFrameRate` — same fallback as Swift.
  const stepFrame = useCallback((count: number) => {
    const v = videoRef.current; if (!v) return;
    clearReverse();
    v.pause(); setDisplayRate(0);
    const step = 1000 / (fps > 0 ? fps : 30);
    seekToMs(Math.round(v.currentTime * 1000) + Math.round(step * count));
  }, [clearReverse, fps, seekToMs]);
  /// JKL shuttle: cycles 2× → 4× → 8× (or +1 with shift). Negative magnitudes
  /// play in reverse via repeated stepFrame(-1) at the desired interval,
  /// since HTML5 video doesn't natively support reverse playbackRate.
  const shuttle = useCallback((reverse: boolean, incremental: boolean) => {
    const v = videoRef.current; if (!v) return;
    clearReverse();
    const cur = displayRate;
    const sign = reverse ? -1 : 1;
    let next: number;
    if ((reverse && cur >= 0) || (!reverse && cur <= 0)) {
      next = sign * (incremental ? 1 : 2);
    } else {
      const mag = Math.abs(cur);
      next = sign * (incremental ? Math.min(8, mag + 1) : Math.min(8, mag * 2));
    }
    if (next > 0) { v.playbackRate = next; v.play(); }
    else if (next < 0) {
      // Reverse playback emulated via tight interval-driven seeks.
      v.pause();
      const stepMs = Math.round((1000 / (fps > 0 ? fps : 30)) * Math.abs(next));
      reverseTimer.current = window.setInterval(() => {
        const v2 = videoRef.current; if (!v2) return;
        const nt = Math.max(0, v2.currentTime - stepMs / 1000);
        v2.currentTime = nt;
        setCurrentMs(Math.round(nt * 1000));
        if (nt <= 0) {
          clearReverse();
          setDisplayRate(0);
        }
      }, stepMs);
    } else {
      v.pause();
    }
    setDisplayRate(next);
  }, [clearReverse, displayRate, fps]);
  // Stop the reverse-shuttle timer on unmount.
  useEffect(() => () => clearReverse(), [clearReverse]);

  // ── Zoom helpers ───────────────────────────────────────────────────────
  const setZoom = useCallback((s: number) => {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s));
    setZoomScale(clamped);
    if (clamped === 1) setZoomPan({ x: 0, y: 0 });
  }, []);
  const zoomIn  = useCallback(() => setZoom(zoomScale * ZOOM_STEP), [setZoom, zoomScale]);
  const zoomOut = useCallback(() => setZoom(zoomScale / ZOOM_STEP), [setZoom, zoomScale]);
  const zoomFit = useCallback(() => { setZoomScale(1); setZoomPan({ x: 0, y: 0 }); }, []);
  const zoom100 = useCallback(() => {
    // 100% pixel-for-pixel. Without intrinsic-vs-rendered ratio info to
    // compute the exact scale, double-fit as a usable approximation.
    setZoom(2);
  }, [setZoom]);
  const zoomFill = useCallback(() => {
    // Fill: crop the shorter axis. Approximate via the stage / content
    // ratio; falls back to 1.5× when intrinsic size is unknown.
    const wrap = stageBoxRef.current; if (!wrap) return setZoom(1.5);
    const media = videoRef.current ?? imgRef.current;
    if (!media) return setZoom(1.5);
    const iW = (media as HTMLVideoElement).videoWidth ?? (media as HTMLImageElement).naturalWidth;
    const iH = (media as HTMLVideoElement).videoHeight ?? (media as HTMLImageElement).naturalHeight;
    if (!iW || !iH) return setZoom(1.5);
    const rect = fitRect(wrap.clientWidth, wrap.clientHeight, iW, iH);
    setZoom(Math.max(wrap.clientWidth / rect.w, wrap.clientHeight / rect.h));
  }, [setZoom]);

  // ── Aspect-guide cycler ────────────────────────────────────────────────
  const cycleGuide = useCallback(() => {
    const i = GUIDES.findIndex((g) => g.id === guide);
    setGuide(GUIDES[(i + 1) % GUIDES.length].id);
  }, [guide]);

  // ── Mark In / Out ──────────────────────────────────────────────────────
  const markIn = useCallback(() => {
    setInMs(currentMs);
    if (outMs !== null && outMs < currentMs) setOutMs(null);
  }, [currentMs, outMs]);
  const markOut = useCallback(() => {
    setOutMs(currentMs);
    if (inMs !== null && inMs > currentMs) setInMs(null);
  }, [currentMs, inMs]);
  const goToIn  = useCallback(() => { if (inMs !== null)  seekToMs(inMs);  }, [inMs, seekToMs]);
  const goToOut = useCallback(() => { if (outMs !== null) seekToMs(outMs); }, [outMs, seekToMs]);
  const markRange = useCallback(() => {
    if (inMs === null) setInMs(currentMs);
    else if (outMs === null) setOutMs(currentMs);
  }, [currentMs, inMs, outMs]);

  // ── Mute toggle ────────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    v.muted = !v.muted;
    setIsMuted(v.muted);
  }, []);

  // ── Speed control (sets playbackRate when playing forward at 1×) ──────
  const applySpeed = useCallback((v: number) => {
    setSpeed(v);
    const vid = videoRef.current; if (!vid) return;
    if (vid.playbackRate > 0) vid.playbackRate = v;
  }, []);

  const toggleApproval = useCallback(() => {
    pushUndoSnapshot();
    setStatus((current) => current === "approved" ? "in_review" : "approved");
  }, [pushUndoSnapshot]);

  // ── Loop toggle (⌃L) ───────────────────────────────────────────────────
  const toggleLoop = useCallback(() => { setIsLooping((v) => !v); }, []);

  // ── Fullscreen toggle ──────────────────────────────────────────────────
  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current ?? document.documentElement;
    if (!document.fullscreenElement) el.requestFullscreen?.();
    else document.exitFullscreen?.();
  }, []);

  // ── Focus the composer (C key) ─────────────────────────────────────────
  const focusComposer = useCallback(() => {
    pause();
    if (!reviewerReady) {
      requestReviewerName();
      return;
    }
    composerRef.current?.focus();
  }, [pause, requestReviewerName, reviewerReady]);

  // ── Keyboard shortcuts (Frame.io V4 subset, matches Swift) ─────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't hijack keys inside a text field — typing in a textBox or in
      // the rail composer should edit characters, not trigger shortcuts.
      const t = e.target as HTMLElement | null;
      const inText = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

      // `?` (shift+/) always toggles the help sheet — even from inside a
      // text field — matching Swift's bus.toggleShortcuts.
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        setShowShortcuts((v) => !v);
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        if (showShortcuts) { setShowShortcuts(false); e.preventDefault(); return; }
        if (selectedId)    { setSelectedId(null);     e.preventDefault(); return; }
        return;
      }

      // ⌘ / Ctrl combos: undo / redo + zoom; never hijack ⌘ inside a text field.
      if (e.metaKey || e.ctrlKey) {
        if (inText && (e.key === "z" || e.key === "Z")) return;
        if (e.key === "z" || e.key === "Z") {
          e.preventDefault();
          if (e.shiftKey) redoEdit();
          else undoEdit();
          return;
        }
        if (e.key === "0")            { zoom100(); e.preventDefault(); return; }
        if (e.key === "=" || e.key === "+") { zoomIn();  e.preventDefault(); return; }
        if (e.key === "-")            { zoomOut(); e.preventDefault(); return; }
        return;
      }

      // Delete / Backspace removes the selected annotation.
      if (!inText && (e.key === "Delete" || e.key === "Backspace")) {
        if (selectedId) {
          deleteAnnotation(selectedId);
          e.preventDefault();
          return;
        }
      }

      // Don't hijack the rest while typing.
      if (inText) return;

      // Transport / markup keys.
      switch (e.key) {
        case " ":  togglePlay(); e.preventDefault(); return;
        case "k": case "K": togglePlay(); e.preventDefault(); return;
        case "j": case "J": shuttle(true,  e.shiftKey); e.preventDefault(); return;
        case "l": case "L":
          if (e.ctrlKey) { toggleLoop(); }
          else           { shuttle(false, e.shiftKey); }
          e.preventDefault(); return;
        case "ArrowLeft":   stepFrame(e.shiftKey ? -10 : -1); e.preventDefault(); return;
        case "ArrowRight":  stepFrame(e.shiftKey ?  10 :  1); e.preventDefault(); return;
        case ",":           stepFrame(-1); e.preventDefault(); return;
        case ".":           stepFrame( 1); e.preventDefault(); return;
        case "f": case "F": toggleFullscreen(); e.preventDefault(); return;
        case "g": case "G": cycleGuide(); e.preventDefault(); return;
        case "p": case "P":
          // Toggle the floating markup toolbar (closest analogue to
          // Swift `anno.toggle()`). Closing the toolbar reverts to
          // the cursor so the canvas isn't left in a draw-on-click
          // state.
          setMarkupOpen((open) => {
            const next = !open;
            if (!next) setTool("select");
            return next;
          });
          e.preventDefault(); return;
        case "m": case "M": toggleMute(); e.preventDefault(); return;
        case "t": case "T": zoomFit(); e.preventDefault(); return;
        case "y": case "Y": zoomFill(); e.preventDefault(); return;
        case "=": case "+": zoomIn();  e.preventDefault(); return;
        case "-": case "_": zoomOut(); e.preventDefault(); return;
        case "c": case "C": focusComposer(); e.preventDefault(); return;
        case "i": case "I":
          if (e.shiftKey) goToIn(); else markIn();
          e.preventDefault(); return;
        case "o": case "O":
          if (e.shiftKey) goToOut(); else markOut();
          e.preventDefault(); return;
        case "r": case "R": markRange(); e.preventDefault(); return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    selectedId, deleteAnnotation,
    showShortcuts, togglePlay, shuttle, stepFrame, toggleFullscreen,
    cycleGuide, toggleMute, toggleLoop, zoomFit, zoomFill, zoomIn, zoomOut, zoom100,
    focusComposer, goToIn, goToOut, markIn, markOut, markRange, redoEdit, undoEdit,
  ]);

  // ── Toolbar grip drag ──────────────────────────────────────────────────
  // We bypass React state during the drag and write the transform
  // directly on the DOM element via `toolbarRef`. Without this, each
  // pointermove would call `setToolbarOffset`, triggering a full Editor
  // re-render → the toolbar visibly "resisted" the cursor. The final
  // position is committed to React state on pointerup.
  //
  // VERTICAL-ONLY LOCK: the user wanted the bar to slide up/down only;
  // we deliberately ignore the horizontal cursor delta so the bar stays
  // anchored to the stage's centre column.
  const onGripDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const baseY = toolbarOffset.y;
    let lastY = baseY;
    const move = (ev: PointerEvent) => {
      lastY = baseY + (ev.clientY - startY);
      if (toolbarRef.current) {
        // Keep the bar centered horizontally; only the Y offset slides
        // with the cursor. `-50%` cancels the bar's own width so its
        // midpoint stays glued to the stage's centre column.
        toolbarRef.current.style.transform = `translate(-50%, ${lastY}px)`;
      }
    };
    const up = () => {
      setToolbarOffset({ x: 0, y: lastY });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ── Finish → persist + surface the review in ClickUp ───────────────────
  const finish = async () => {
    const out: ReviewPayload = {
      ...payload, status, comments,
      summaryText: summarize(comments, status, activeMediaTitle, reviewerName),
    };

    // ── Server-backed (the single live link) ──
    // The markup is already autosaved. The link reviewers/uploader hold IS
    // this page, so concluding mints NOTHING new — it just flushes the latest
    // state (status flipped) and shows that same link. Notifying the creator
    // is the Apollo side's job (see CONTRACT.md), not ClickUp from here.
    if (session && WORKER_URL) {
      // A pending autosave would run after /session/conclude and reopen the
      // review. Cancel it so conclusion remains the last server write.
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      try {
        await concludeSession({
          reviewId: session.reviewId,
          versionId: selectedVersionId,
          status,
          comments,
        });
        lastPersistedReviewFingerprints.current[selectedVersionId] =
          reviewStateFingerprint(status, comments);
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
      // Single live link: nothing to copy — this very page IS the link (the
      // REVIEW button in the task already points here). Just confirm.
      setDone("");
      return;
    }

    // ── Legacy self-contained (no backend) → mint a `?z=` link as before ──
    const z = await encodeInlinePayload(out);
    const base = window.location.origin + window.location.pathname.replace(/index\.html$/, "");
    const viewerLink = `${base}?z=${z}`;
    setDone(viewerLink);
    try { await navigator.clipboard.writeText(viewerLink); } catch { /* manual copy */ }
  };

  const ordered = useMemo(() => {
    const arr = [...comments];
    if (timed) arr.sort((a, b) => anchorMs(a) - anchorMs(b));
    return arr;
  }, [comments, timed]);

  const activeTimedCommentId = useMemo(() => {
    if (!timed) return null;
    return ordered.find((c) => commentIsActiveAtMs(c, currentMs))?.id ?? null;
  }, [currentMs, ordered, timed]);

  useEffect(() => {
    if (!timed) return;
    setSelectedCommentId(activeTimedCommentId);
  }, [activeTimedCommentId, timed]);

  // ── Interactive overlay data ───────────────────────────────────────────
  // Only show annotations anchored to the current frame (video) or
  // the current asset (image / document). Without this filter, every
  // bubble + shape from every other frame of the video would bleed
  // onto the screen at all times.
  const visibleCommentAnns = useMemo<Annotation[]>(() => {
    const out: Annotation[] = [];
    for (const c of comments) {
      if (!c.annotations.length) continue;
      if (c.anchor.kind === "video") {
        // ±~one frame (~50 ms) tolerance; same idea as the Swift
        // `annotationsToShow` heuristic. Without fps metadata in the
        // web payload, 50 ms is a sane default for typical 24–30 fps.
        if (commentIsActiveAtMs(c, currentMs)) out.push(...c.annotations);
      } else if (c.anchor.kind === "image" || c.anchor.kind === "general") {
        out.push(...c.annotations);
      } else if (c.anchor.kind === "document") {
        // The web doesn't have a doc viewer yet; show them anyway
        // so they don't disappear in the meantime.
        out.push(...c.annotations);
      }
    }
    return out;
  }, [comments, currentMs]);

  /// Pending shapes filtered to the frame they were started on (for
  /// timed media) — without this they'd float over every frame after
  /// the user moves the playhead.
  const visiblePending = useMemo<Annotation[]>(() => {
    if (!timed || pendingFrameMs === null) return pending;
    return Math.abs(currentMs - pendingFrameMs) <= 50 ? pending : [];
  }, [pending, pendingFrameMs, currentMs, timed]);

  // Non-textBox shapes — drives the hit-area layer.
  const interactiveShapes = useMemo<Annotation[]>(() => {
    return [...visibleCommentAnns, ...visiblePending].filter(notTextBox);
  }, [visibleCommentAnns, visiblePending]);

  // textBoxes visible at the current frame — drives the EditableTextBox
  // overlay layer.
  const textBoxes = useMemo<Annotation[]>(() => {
    return visibleCommentAnns.filter((a) => a.geom.shape === "textBox");
  }, [visibleCommentAnns]);

  return (
    <div className="viewer ed">
      <header className="vw-header">
        <div className="vw-title">
          <div className="vw-brandrow">
            <span className="vw-brand">
              <svg className="vw-brand-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M12 3.5 13.8 9l5.7 1.8-5.7 1.9L12 18.5l-1.8-5.8-5.7-1.9L10.2 9 12 3.5Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinejoin="round"
                />
                <path
                  d="M19 3.8v3.4M17.3 5.5h3.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
              Review
            </span>
          </div>
          {/* Seletor de versão ANTES do título (20/jul): a versão é o
              contexto que qualifica o nome do arquivo. */}
          {(session?.versions?.length ?? 0) > 1 && (
            <div className="vw-version-picker" aria-label="Versão exibida">
              {session!.versions!.map((version) => (
                <button
                  key={version.versionId}
                  type="button"
                  className={version.versionId === selectedVersionId ? "is-active" : ""}
                  onClick={() => void selectVersion(version.versionId)}
                  title={version.mediaTitle}
                >
                  {version.versionId.toUpperCase()}
                </button>
              ))}
            </div>
          )}
          <h1>{activeMediaTitle || "Review"}</h1>
          {activeMediaUrl && (
            <a
              className="vw-dl"
              href={activeMediaUrl}
              download={activeMediaTitle || ""}
              target="_blank"
              rel="noopener noreferrer"
              title="Baixar arquivo"
              aria-label="Baixar arquivo"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Baixar
            </a>
          )}
        </div>
        <div className="ed-statuswrap">
          {readOnly ? (
            // Read-only: just show the current status as a chip
            // (parity with the Swift "Somente leitura" badge).
            <span className="vw-stamp">
              {STATUSES.find((s) => s.id === status)?.label ?? status}
            </span>
          ) : (
            <>
              <button
                type="button"
                className={`ed-approval-toggle${status === "approved" ? " on" : ""}`}
                role="switch"
                aria-checked={status === "approved"}
                onClick={toggleApproval}
                title={status === "approved" ? "Marcar como em revisão" : "Marcar como aprovado"}
              >
                <span className="ed-approval-track" aria-hidden="true">
                  <span className="ed-approval-thumb" />
                </span>
                <span className="ed-approval-label">
                  {status === "approved" ? "Aprovado" : "Em revisão"}
                </span>
              </button>
              <button className="ed-finish" onClick={finish}>Concluir review</button>
            </>
          )}
        </div>
      </header>

      <div className="vw-body">
        <section className="vw-stage" ref={stageRef}>
          <div className="vw-stage-canvas" ref={stageBoxRef}>
            {/* Markup toolbar — floats over the stage. Opened by the
                inline ✎ in the composer (or the P key); hidden in
                read-only ("Ver review"). */}
            {!readOnly && markupOpen && (
              <div
                ref={toolbarRef}
                className="ed-toolbar ed-toolbar-floating"
                style={{ transform: `translate(-50%, ${toolbarOffset.y}px)` }}
              >
                <button
                  className="ed-grip"
                  title="Arraste para mover a barra"
                  onPointerDown={onGripDown}
                >≡</button>
                <div className="ed-sep" />
                {TOOLS.map((t) => (
                  <button key={t.id} className={`ed-tool${tool === t.id ? " on" : ""}`}
                          title={t.label} onClick={() => setTool(t.id)}>
                    {t.icon === "pointer" ? <ToolPointerIcon /> : <span className="ed-glyph">{t.glyph}</span>}
                  </button>
                ))}
                <div className="ed-sep" />
                {COLORS.map((c) => (
                  <button key={c} className={`ed-color${color === c ? " on" : ""}`}
                          style={{ background: c }} title={c} onClick={() => setColor(c)} />
                ))}
                <div className="ed-sep" />
                {STROKES.map((s) => (
                  <button
                    key={s.id}
                    className={`ed-stroke${strokeId === s.id ? " on" : ""}`}
                    title={`Traço ${s.label}`}
                    onClick={() => setStrokeId(s.id)}
                  >
                    <span className="ed-stroke-dot" style={{ width: s.dot, height: s.dot }} />
                  </button>
                ))}
              </div>
            )}

            <div
              className="vw-zoom-wrap"
              style={{
                transform: `translate(${zoomPan.x}px, ${zoomPan.y}px) scale(${zoomScale})`,
                transformOrigin: "center center",
              }}
              onWheel={(e) => {
                // Pinch / two-finger-zoom only when ctrl/meta is held — leaves the
                // browser's natural wheel-scroll free for the page itself.
                if (!(e.ctrlKey || e.metaKey)) return;
                e.preventDefault();
                setZoom(zoomScale * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
              }}
            >
              {kind === "video" && (
                <div className="vw-media-wrap" style={mediaBoxStyle}>
                  <video key={selectedVersionId} ref={videoRef} className="vw-media" src={activeMediaUrl} playsInline
                         onTimeUpdate={(e) => setCurrentMs(Math.round(e.currentTarget.currentTime * 1000))}
                         onLoadedMetadata={(e) => {
                           rememberMediaSize(e.currentTarget);
                           setDurationMs(Math.round(e.currentTarget.duration * 1000) || 0);
                           redraw();
                         }}
                         onLoadedData={() => setMediaLoading(false)}
                         onWaiting={() => setMediaLoading(true)}
                         onCanPlay={() => setMediaLoading(false)}
                         onPlay={() => setIsPlaying(true)}
                         onPause={() => setIsPlaying(false)}
                         onEnded={(e) => {
                           if (!isLooping) return;
                           const v = e.currentTarget;
                           v.currentTime = (inMs ?? 0) / 1000;
                           void v.play();
                         }}
                         onError={() => setMediaLoading(false)} />
                  <canvas ref={canvasRef} className="vw-overlay ed-canvas"
                          style={{ pointerEvents: readOnly ? "none" : "auto",
                                   cursor: tool === "select" ? "default" : "crosshair" }}
                          onPointerDown={onPointerDown}
                          onPointerMove={onPointerMove}
                          onPointerUp={onPointerUp} />
                  <AspectGuideOverlay guide={guide} rect={stageRect} />
                  {stageRect && (
                    <>
                      <ShapeHitLayer
                        annotations={interactiveShapes}
                        rect={stageRect}
                        tool={tool}
                        selectedId={selectedId}
                        readOnly={readOnly}
                        onSelect={setSelectedId}
                        onEditStart={pushUndoSnapshot}
                        onMove={(id, dx, dy) => updateAnnotation(id, (a) => translateAnnotation(a, dx, dy))}
                        onResize={(id, h, dx, dy) => updateAnnotation(id, (a) => resizeAnnotation(a, h, dx, dy))}
                      />
                      <TextBoxLayer
                        annotations={textBoxes}
                        rect={stageRect}
                        selectedId={selectedId}
                        tool={tool}
                        readOnly={readOnly}
                        onSelect={setSelectedId}
                        onEditStart={pushUndoSnapshot}
                        onUpdate={(id, geom) =>
                          updateAnnotation(id, (a) => ({ ...a, geom }))
                        }
                        onDelete={deleteAnnotation}
                      />
                    </>
                  )}
                </div>
              )}
              {kind === "image" && (
                <div className="vw-media-wrap" style={mediaBoxStyle}>
                  <img
                    key={selectedVersionId}
                    ref={imgRef}
                    className="vw-media"
                    src={activeMediaUrl}
                    alt={activeMediaTitle}
                    onLoad={(e) => {
                      rememberMediaSize(e.currentTarget);
                      redraw();
                    }}
                  />
                  <canvas ref={canvasRef} className="vw-overlay ed-canvas"
                          style={{ pointerEvents: readOnly ? "none" : "auto",
                                   cursor: tool === "select" ? "default" : "crosshair" }}
                          onPointerDown={onPointerDown}
                          onPointerMove={onPointerMove}
                          onPointerUp={onPointerUp} />
                  <AspectGuideOverlay guide={guide} rect={stageRect} />
                  {stageRect && (
                    <>
                      <ShapeHitLayer
                        annotations={interactiveShapes}
                        rect={stageRect}
                        tool={tool}
                        selectedId={selectedId}
                        readOnly={readOnly}
                        onSelect={setSelectedId}
                        onEditStart={pushUndoSnapshot}
                        onMove={(id, dx, dy) => updateAnnotation(id, (a) => translateAnnotation(a, dx, dy))}
                        onResize={(id, h, dx, dy) => updateAnnotation(id, (a) => resizeAnnotation(a, h, dx, dy))}
                      />
                      <TextBoxLayer
                        annotations={textBoxes}
                        rect={stageRect}
                        selectedId={selectedId}
                        tool={tool}
                        readOnly={readOnly}
                        onSelect={setSelectedId}
                        onEditStart={pushUndoSnapshot}
                        onUpdate={(id, geom) =>
                          updateAnnotation(id, (a) => ({ ...a, geom }))
                        }
                        onDelete={deleteAnnotation}
                      />
                    </>
                  )}
                </div>
              )}
              {kind === "audio" && (
                <div className="vw-media-wrap vw-audio-wrap">
                  <video key={selectedVersionId} ref={videoRef} className="vw-media vw-audio-media" src={activeMediaUrl} playsInline
                         onTimeUpdate={(e) => setCurrentMs(Math.round(e.currentTarget.currentTime * 1000))}
                         onLoadedMetadata={(e) => {
                           setMediaLoading(false);
                           setDurationMs(Math.round(e.currentTarget.duration * 1000) || 0);
                         }}
                         onPlay={() => setIsPlaying(true)}
                         onPause={() => setIsPlaying(false)}
                         onEnded={(e) => {
                           if (!isLooping) return;
                           const v = e.currentTarget;
                           v.currentTime = (inMs ?? 0) / 1000;
                           void v.play();
                         }} />
                  <div className="vw-audio-card">
                    <div className="vw-audio-name">{activeMediaTitle}</div>
                    <p className="vw-muted">Áudio — sem canvas de marcação visual.</p>
                  </div>
                </div>
              )}
              {kind !== "video" && kind !== "image" && kind !== "audio" && (
                <div className="vw-audio"><div className="vw-audio-name">{activeMediaTitle}</div>
                  <p className="vw-muted">Formato não suportado nesta versão do review.</p></div>
              )}
            </div>
            {splashVisible && <MediaSplash leaving={splashLeaving} />}
          </div>

          {/* Custom transport bar — replaces the native HTML5 controls so
              we can paint the timeline with comment markers + in/out flags
              + range spans, exactly like the Swift TimelineBar. */}
          {timed && (
            <TransportBar
              currentMs={currentMs}
              durationMs={durationMs}
              isPlaying={isPlaying}
              isLooping={isLooping}
              isMuted={isMuted}
              speed={speed}
              fps={fps}
              inMs={inMs}
              outMs={outMs}
              comments={comments}
              guide={guide}
              zoomPct={Math.round(zoomScale * 100)}
              onTogglePlay={togglePlay}
              onStepFrame={stepFrame}
              onSeek={seekToMs}
              onToggleLoop={toggleLoop}
              onToggleMute={toggleMute}
              onZoomIn={zoomIn}
              onZoomOut={zoomOut}
              onSetSpeed={applySpeed}
              onSetGuide={setGuide}
              onResetZoom={zoomFit}
              onToggleFullscreen={toggleFullscreen}
              onShowHelp={() => setShowShortcuts(true)}
            />
          )}
        </section>

        {/* Timed-comments rail only for video / audio. Static art (image /
            document) comments live as on-canvas text bubbles. */}
        {timed && (
          <aside className="vw-rail">
            {/* Header — count chip + resolve progress + autosave state. */}
            <div className="vw-rail-head">
              <span className="vw-rail-count">
                <strong>{comments.length}</strong> comentário{comments.length === 1 ? "" : "s"}
              </span>
              {comments.length > 0 && (
                <span className="vw-rail-progress">
                  {comments.filter((c) => c.resolved).length}/{comments.length} resolvidos
                </span>
              )}
              {session && saveState !== "idle" && (
                <span className={`vw-save vw-save-${saveState}`}>
                  {saveState === "saving"
                    ? "salvando…"
                    : saveState === "saved"
                      ? "✓ salvo"
                      : "erro ao salvar"}
                </span>
              )}
            </div>
            {/* List fills the middle — scrolls when overflowing. */}
            <div className="vw-rail-list">
              {ordered.length === 0 && (
                <div className="vw-empty">
                  {readOnly
                    ? "Nenhum comentário neste review."
                    : <>Nenhum comentário ainda.<br />Tecle <kbd>C</kbd> para comentar, ou <kbd>P</kbd> para marcar.</>}
                </div>
              )}
              {ordered.map((c) => (
                <div
                  className={`vw-comment${selectedCommentId === c.id ? " is-selected" : ""}${c.resolved ? " is-resolved" : ""}${deletingCommentIds.has(c.id) ? " is-deleting" : ""}`}
                  key={c.id}
                >
                  {/* Resolve checkbox — the executor ticks each feedback item
                      done in this same live link. Read-only legacy links show
                      the state but can't change it. */}
                  <button
                    type="button"
                    className={`vw-check${c.resolved ? " on" : ""}`}
                    onClick={() => toggleResolved(c.id)}
                    disabled={readOnly}
                    aria-pressed={c.resolved}
                    title={
                      c.resolved
                        ? `Resolvido${c.resolvedByName ? ` por ${c.resolvedByName}` : ""} — clique para reabrir`
                        : "Marcar como resolvido"
                    }
                  >
                    {c.resolved ? "✓" : ""}
                  </button>
                  <button className="vw-comment-main" onClick={() => seek(c)}>
                    <div className="vw-comment-meta">
                      {c.anchor.kind === "video" && <span className="vw-stamp">{anchorLabel(c)}</span>}
                      <span className="vw-author">{c.authorName}</span>
                      {c.annotations.length > 0 && <span className="vw-markup">✎</span>}
                    </div>
                    <div className="vw-comment-body">{c.body || <em>(marcação)</em>}</div>
                  </button>
                  {!readOnly && (
                    <button
                      type="button"
                      className="vw-comment-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteComment(c.id);
                      }}
                      aria-label="Deletar comentário"
                      title="Deletar comentário"
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M5.2 4.2V3.3c0-.7.5-1.2 1.2-1.2h3.2c.7 0 1.2.5 1.2 1.2v.9" />
                        <path d="M3.4 4.2h9.2" />
                        <path d="M4.5 6.1 5 13c0 .6.5 1 1.1 1h3.8c.6 0 1.1-.4 1.1-1l.5-6.9" />
                        <path d="M7 7.1v4.5M9 7.1v4.5" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
            {/* Composer pinned to the bottom — matches Swift CommentRail.
                Buttons (markup-toolbar toggle + submit) live INSIDE
                the bordered rounded box, Apollo-style: the whole row
                reads as one input. Hidden in read-only. */}
            {!readOnly && (
              <div
                className="ed-composer"
                onPointerDown={(e) => {
                  if (reviewerReady) return;
                  e.preventDefault();
                  requestReviewerName();
                }}
              >
                <div className="ed-composer-row">
                  <textarea
                    ref={composerRef}
                    className="ed-text"
                    placeholder="Comentar…"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    readOnly={!reviewerReady}
                    onFocus={() => {
                      if (!reviewerReady) {
                        composerRef.current?.blur();
                        requestReviewerName();
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (reviewerReady) addComment();
                      }
                    }}
                    rows={2}
                  />
                  <div className="ed-composer-actions">
                    <button
                      type="button"
                      className={`ed-comp-action${markupOpen ? " on" : ""}`}
                      onClick={() => setMarkupOpen((v) => {
                        const next = !v;
                        if (!next) setTool("select");
                        return next;
                      })}
                      title={markupOpen ? "Fechar barra de marcação (P)" : "Abrir barra de marcação (P)"}
                      aria-label="Marcação"
                    >
                      <Icon name="markup-pen" />
                    </button>
                    <button
                      type="button"
                      className="ed-add ed-add-compact"
                      onClick={addComment}
                      disabled={reviewerReady && !body.trim() && pending.length === 0}
                      title="Adicionar comentário (Enter)"
                    >
                      Comentar
                    </button>
                  </div>
                </div>
              </div>
            )}
          </aside>
        )}
      </div>

      {/* JKL shuttle readout — only when shuttle is active. */}
      {Math.abs(displayRate) > 1 && (
        <div className="ed-shuttle">
          {displayRate < 0 ? "−" : ""}
          {Math.abs(displayRate).toFixed(0)}×
        </div>
      )}

      {/* Help sheet — full list of shortcuts. */}
      {showShortcuts && (
        <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />
      )}

      {nameDialogOpen && (
        <div className="ed-modal ed-name-modal">
          <form
            className="ed-modal-card ed-name-card"
            onSubmit={(e) => {
              e.preventDefault();
              confirmReviewerName();
            }}
          >
            <span className="vw-brand">Identificação</span>
            <p className="vw-muted">Informe seu nome para comentar neste review.</p>
            <input
              ref={nameInputRef}
              className="ed-name-input"
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="Seu nome"
              autoComplete="name"
              spellCheck={false}
            />
            <div className="ed-modal-actions">
              <button
                type="button"
                className="ed-clear"
                onClick={() => setNameDialogOpen(false)}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="ed-add ed-name-submit"
                disabled={!nameDraft.trim()}
              >
                Continuar
              </button>
            </div>
          </form>
        </div>
      )}

      {done !== null && (
        <div className="ed-modal ed-done-modal" onClick={() => setDone(null)}>
          <div className="ed-modal-card ed-done-card" onClick={(e) => e.stopPropagation()}>
            <div className="ed-done-mark" aria-hidden="true">
              <svg viewBox="0 0 48 48">
                <path d="M14 24.5 21.2 31.6 35 16.8" />
              </svg>
            </div>
            <span className="vw-brand">Review concluído</span>
            {session ? (
              // Single live link: it's the same URL, already in the task as the
              // REVIEW button — nothing to copy.
              <p className="vw-muted">Tudo salvo neste mesmo link. Quem abrir o REVIEW na task vê a versão atual.</p>
            ) : (
              <>
                <p className="vw-muted">Copie este link para compartilhar o review:</p>
                <textarea className="ed-done" readOnly value={done} rows={4} onFocus={(e) => e.currentTarget.select()} />
              </>
            )}
            <div className="ed-modal-actions">
              {!session && (
                <button className="ed-add" onClick={() => navigator.clipboard.writeText(done)}>Copiar link</button>
              )}
              <button className="ed-clear" onClick={() => setDone(null)}>Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MediaSplash({ leaving }: { leaving: boolean }) {
  return (
    <div
      className={`ed-loading ed-media-splash${leaving ? " is-leaving" : ""}`}
      aria-label="Carregando video"
      aria-live="polite"
    >
      <div className="ed-splash-mark" aria-hidden="true">
        <span className="ed-splash-orbit" />
        <svg className="ed-splash-star" viewBox="0 0 32 32">
          <path
            d="M16 4.5 18.8 13l8.7 3-8.7 3L16 27.5 13.2 19l-8.7-3 8.7-3L16 4.5Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path
            d="M25 4.8v4.4M22.8 7h4.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <div className="ed-splash-wordmark">
        <span>Apollo</span>
        <strong>Review</strong>
      </div>
      <div className="ed-splash-progress" aria-hidden="true">
        <span />
      </div>
    </div>
  );
}

// ── Aspect-ratio guides overlay ─────────────────────────────────────────
//
// Centred outline of the named ratio (9:16, 1:1, 4:5, 16:9, 2.39) inside
// the displayed media rect. Matches GuideOverlay in the Swift app — the
// rectangle is the WIDER axis pinned to the shorter side of the stage.

function AspectGuideOverlay({ guide, rect }: { guide: Guide; rect: Rect | null }) {
  const g = GUIDES.find((x) => x.id === guide);
  if (!g || g.ratio === null || !rect || rect.w <= 0 || rect.h <= 0) return null;

  const mediaAspect = rect.w / rect.h;
  const guideAspect = g.ratio;
  const guideW = guideAspect > mediaAspect ? rect.w : rect.h * guideAspect;
  const guideH = guideAspect > mediaAspect ? rect.w / guideAspect : rect.h;
  const left = rect.x + (rect.w - guideW) / 2;
  const top = rect.y + (rect.h - guideH) / 2;

  return (
    <div className="ed-guide-svg" aria-hidden="true">
      <div
        className="ed-guide-rect"
        style={{ left, top, width: guideW, height: guideH }}
      />
    </div>
  );
}
// ── Custom transport bar ────────────────────────────────────────────────
//
// Below the stage. Play/pause + timecode + scrubber with comment markers
// + range fill + in/out flags + secondary controls (guide / zoom / help).
// Matches Swift's TimelineBar + the transport row in ReviewWindow.

function TransportBar({
  currentMs, durationMs, isPlaying, isLooping, isMuted, speed, fps,
  inMs, outMs, comments,
  guide, zoomPct,
  onTogglePlay, onStepFrame, onSeek, onToggleLoop, onToggleMute,
  onZoomIn, onZoomOut, onSetSpeed, onSetGuide,
  onResetZoom, onToggleFullscreen, onShowHelp,
}: {
  currentMs: number;
  durationMs: number;
  isPlaying: boolean;
  isLooping: boolean;
  isMuted: boolean;
  speed: number;
  fps: number;
  inMs: number | null;
  outMs: number | null;
  comments: ReviewComment[];
  guide: Guide;
  zoomPct: number;
  onTogglePlay: () => void;
  onStepFrame: (count: number) => void;
  onSeek: (ms: number) => void;
  onToggleLoop: () => void;
  onToggleMute: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onSetSpeed: (s: number) => void;
  onSetGuide: (g: Guide) => void;
  onResetZoom: () => void;
  onToggleFullscreen: () => void;
  onShowHelp: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dur = Math.max(1, durationMs);
  const pct = (ms: number) => (100 * Math.min(1, Math.max(0, ms / dur))).toFixed(3) + "%";

  const onTrackPointer = (e: React.PointerEvent) => {
    const t = trackRef.current; if (!t) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const seek = (clientX: number) => {
      const r = t.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      onSeek(Math.round(frac * dur));
    };
    seek(e.clientX);
    const move = (ev: PointerEvent) => seek(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Frame-anchored & range comments for the marker layer.
  const timeMarkers = comments
    .filter((c) => c.anchor.kind === "video")
    .map((c) => c.anchor as { timeMs: number; endMs?: number; resolved?: boolean });

  // Speed list — same ladder as Swift PlayerModel.setSpeed.
  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

  return (
    <div className="ed-transport">
      {/* ── Row 1: timeline ───────────────────────────────────────────── */}
      <div className="ed-tp-track" ref={trackRef} onPointerDown={onTrackPointer}>
        <div className="ed-tp-rail" />
        <div className="ed-tp-played" style={{ width: pct(currentMs) }} />
        {inMs !== null && outMs !== null && outMs > inMs && (
          <div className="ed-tp-range"
               style={{ left: pct(inMs), width: pct(Math.max(0, outMs - inMs)) }} />
        )}
        {timeMarkers.filter((m) => typeof m.endMs === "number" && m.endMs! > m.timeMs).map((m, i) => (
          <div key={`r${i}`} className="ed-tp-rspan"
               style={{ left: pct(m.timeMs), width: pct(Math.max(0, m.endMs! - m.timeMs)) }} />
        ))}
        {inMs !== null && (
          <div className="ed-tp-flag" style={{ left: pct(inMs) }} title="Marcador In (I)" />
        )}
        {outMs !== null && (
          <div className="ed-tp-flag" style={{ left: pct(outMs) }} title="Marcador Out (O)" />
        )}
        {timeMarkers.map((m, i) => (
          <div key={`m${i}`} className="ed-tp-marker" style={{ left: pct(m.timeMs) }} />
        ))}
        <div className="ed-tp-head" style={{ left: pct(currentMs) }} />
      </div>

      {/* ── Row 2: controls ───────────────────────────────────────────── */}
      <div className="ed-tp-controls">
        {/* Left cluster: transport icons. */}
        <div className="ed-tp-group">
          <button className="ed-tp-ibtn" onClick={() => onStepFrame(-1)} title="Frame anterior (←)">
            <Icon name="step-back" />
          </button>
          <button className="ed-tp-ibtn" onClick={onTogglePlay} title="Play / Pause (Espaço)">
            <Icon name={isPlaying ? "pause" : "play"} />
          </button>
          <button className="ed-tp-ibtn" onClick={() => onStepFrame(1)} title="Próximo frame (→)">
            <Icon name="step-fwd" />
          </button>
          <button
            className={`ed-tp-ibtn${isLooping ? " on" : ""}`}
            onClick={onToggleLoop}
            title="Loop (⌃L)"
          ><Icon name="loop" /></button>
          <button
            className={`ed-tp-ibtn${isMuted ? " on" : ""}`}
            onClick={onToggleMute}
            title="Mudo (M)"
          ><Icon name={isMuted ? "muted" : "speaker"} /></button>
        </div>

        {/* Center: SMPTE timecode. */}
        <div className="ed-tp-tc">
          <span className="ed-tp-tc-cur">{fmtSMPTE(currentMs, fps)}</span>
          <span className="ed-tp-tc-sep">/</span>
          <span className="ed-tp-tc-dur">{fmtSMPTE(durationMs, fps)}</span>
        </div>

        {/* Right cluster: zoom + speed + guide + fullscreen. */}
        <div className="ed-tp-group">
          <button className="ed-tp-ibtn" onClick={onZoomOut} title="Zoom − (−)">
            <Icon name="zoom-out" />
          </button>
          <button className="ed-tp-pct" onClick={onResetZoom} title="Ajustar (T)">
            {zoomPct}%
          </button>
          <button className="ed-tp-ibtn" onClick={onZoomIn} title="Zoom + (+)">
            <Icon name="zoom-in" />
          </button>
          {/* Speed dropdown — styled as a chevron-button. Native <select>
              kept under the hood so the menu integrates with macOS / Win UA. */}
          <label className="ed-tp-menu">
            <span>{speed === 1 ? "1×" : `${speed}×`}</span>
            <Icon name="chevron-down" />
            <select value={speed} onChange={(e) => onSetSpeed(Number(e.target.value))}>
              {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
            </select>
          </label>
          {/* Aspect-guide dropdown. */}
          <label className="ed-tp-menu" title="Guia de aspecto (G)">
            <Icon name="aspect" />
            <Icon name="chevron-down" />
            <select value={guide} onChange={(e) => onSetGuide(e.target.value as Guide)}>
              {GUIDES.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
            </select>
          </label>
          <button className="ed-tp-ibtn" onClick={onToggleFullscreen} title="Tela cheia (F)">
            <Icon name="fullscreen" />
          </button>
          <button className="ed-tp-ibtn" onClick={onShowHelp} title="Atalhos (?)">
            <Icon name="help" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── SF-symbol-style transport icons ─────────────────────────────────────
//
// Inline SVG paths chosen to read like Apollo's SF-symbols set (filled
// triangles, single-bar step-frame, simple loop/aspect/speaker). Stroke
// inherits the button's `color`, so the on-state highlight just works.

function ToolPointerIcon() {
  return (
    <svg className="ed-tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5.2 3.6 18.7 13a.8.8 0 0 1-.46 1.46h-6.02l-3.1 5.56a.8.8 0 0 1-1.48-.38L4 4.35a.8.8 0 0 1 1.2-.75Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path
        d="M10.9 13.4 8.5 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

type IconName =
  | "play" | "pause"
  | "step-back" | "step-fwd"
  | "loop"
  | "speaker" | "muted"
  | "zoom-in" | "zoom-out"
  | "aspect" | "fullscreen" | "help"
  | "chevron-down"
  | "markup-pen";

function Icon({ name }: { name: IconName }) {
  const common = { width: 14, height: 14, viewBox: "0 0 16 16", fill: "currentColor",
                   stroke: "currentColor", strokeLinejoin: "round" as const,
                   strokeLinecap: "round" as const };
  switch (name) {
    case "play":
      return <svg {...common}><path d="M4 3 L13 8 L4 13 Z" strokeWidth="1.2"/></svg>;
    case "pause":
      return <svg {...common}><rect x="4" y="3" width="2.6" height="10"/><rect x="9.4" y="3" width="2.6" height="10"/></svg>;
    case "step-back":
      return <svg {...common}>
        <rect x="2.4" y="3" width="1.5" height="10"/>
        <path d="M14 3 L5.4 8 L14 13 Z" strokeWidth="1.2"/>
      </svg>;
    case "step-fwd":
      return <svg {...common}>
        <path d="M2 3 L10.6 8 L2 13 Z" strokeWidth="1.2"/>
        <rect x="12.1" y="3" width="1.5" height="10"/>
      </svg>;
    case "loop":
      return <svg {...common} fill="none" strokeWidth="1.4">
        <path d="M3.5 6.5 A4.5 4.5 0 0 1 12 6.5 L13.4 5.1 M13.4 5.1 L13.4 7.6 M13.4 5.1 L10.9 5.1"/>
        <path d="M12.5 9.5 A4.5 4.5 0 0 1 4 9.5 L2.6 10.9 M2.6 10.9 L2.6 8.4 M2.6 10.9 L5.1 10.9"/>
      </svg>;
    case "speaker":
      return <svg {...common} strokeWidth="1.3">
        <path d="M2 6 L2 10 L5 10 L9 13 L9 3 L5 6 Z"/>
        <path d="M11 5.5 Q13 8 11 10.5" fill="none"/>
        <path d="M12.6 4 Q15.2 8 12.6 12" fill="none"/>
      </svg>;
    case "muted":
      return <svg {...common} strokeWidth="1.3">
        <path d="M2 6 L2 10 L5 10 L9 13 L9 3 L5 6 Z"/>
        <path d="M11 5.5 L14 10.5 M14 5.5 L11 10.5" fill="none"/>
      </svg>;
    case "zoom-out":
      return <svg {...common} fill="none" strokeWidth="1.4">
        <circle cx="7" cy="7" r="4"/>
        <path d="M10 10 L14 14"/>
        <path d="M5 7 H9"/>
      </svg>;
    case "zoom-in":
      return <svg {...common} fill="none" strokeWidth="1.4">
        <circle cx="7" cy="7" r="4"/>
        <path d="M10 10 L14 14"/>
        <path d="M5 7 H9 M7 5 V9"/>
      </svg>;
    case "aspect":
      return <svg {...common} fill="none" strokeWidth="1.4">
        <rect x="2.5" y="4" width="11" height="8" rx="1"/>
      </svg>;
    case "fullscreen":
      return <svg {...common} fill="none" strokeWidth="1.4">
        <path d="M3 6 V3 H6 M10 3 H13 V6 M13 10 V13 H10 M6 13 H3 V10"/>
      </svg>;
    case "help":
      return <svg {...common} fill="none" strokeWidth="1.4">
        <circle cx="8" cy="8" r="5.5"/>
        <path d="M6.4 6.4 A1.6 1.6 0 0 1 8 5 A1.6 1.6 0 0 1 9.6 6.4 Q9.6 7.5 8 8.2 V9.4"/>
        <circle cx="8" cy="11.5" r="0.6" fill="currentColor"/>
      </svg>;
    case "chevron-down":
      return <svg {...common} width="9" height="9" fill="none" strokeWidth="1.5">
        <path d="M3 6 L8 11 L13 6"/>
      </svg>;
    case "markup-pen":
      // Clean pencil (Heroicons-style). Rendered larger than the
      // transport icons so it reads clearly inside the composer's
      // inline action slot.
      return <svg
        width="18" height="18" viewBox="0 0 20 20"
        fill="none" stroke="currentColor" strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round"
      >
        {/* Outer outline (head, body, tip, paper) */}
        <path d="M14.2 2.8 L17.2 5.8 L7.4 15.6 L3 17 L4.4 12.6 Z"/>
        {/* Ferrule — short cross-line where the metal band sits */}
        <path d="M12.2 4.8 L15.2 7.8"/>
        {/* Tip emphasis — a tiny diagonal stroke at the point */}
        <path d="M3 17 L5.4 14.6"/>
      </svg>;
  }
}

// ── SMPTE timecode ──────────────────────────────────────────────────────
//
// HH:MM:SS:FF when fps is known, MM:SS otherwise. Matches Swift's
// `TC.smpte` output so the two players read identically.
function fmtSMPTE(ms: number, fps: number): string {
  const total = Math.max(0, Math.round(ms));
  const hh = Math.floor(total / 3600000);
  const mm = Math.floor((total % 3600000) / 60000);
  const ss = Math.floor((total % 60000) / 1000);
  const ff = Math.floor(((total % 1000) / 1000) * fps);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (fps > 0) return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
  return `${pad(mm)}:${pad(ss)}`;
}

// ── Shortcuts overlay (help sheet) ──────────────────────────────────────

function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const groups = [
    {
      title: "Reprodução",
      rows: [
        ["Espaço / K",  "Play / pause"],
        ["J / L",       "Retroceder / avançar (2×·4×·8×)"],
        ["⇧J / ⇧L",     "Shuttle incremental"],
        ["← / →",       "1 frame"],
        ["⇧← / ⇧→",     "10 frames"],
        [",  /  .",     "1 frame"],
        ["M",           "Mudo"],
        ["F",           "Tela cheia"],
        ["G",           "Guias de aspecto"],
      ],
    },
    {
      title: "Comentário & marcação",
      rows: [
        ["C",           "Comentar no timecode atual"],
        ["P",           "Alternar cursor / desenho"],
        ["⌘Z",          "Desfazer markup"],
        ["I / O",       "Marcar in / out"],
        ["⇧I / ⇧O",     "Ir pro in / out"],
        ["R",           "Marcar range"],
        ["Delete",      "Apagar marcação selecionada"],
      ],
    },
    {
      title: "Zoom",
      rows: [
        ["+ / −",       "Mais / menos"],
        ["T",           "Ajustar"],
        ["Y",           "Preencher"],
        ["⌘0",          "Resetar"],
        ["⌘+scroll",    "Pinch"],
      ],
    },
    {
      title: "Geral",
      rows: [
        ["?",           "Mostrar / ocultar atalhos"],
        ["Esc",         "Fechar"],
      ],
    },
  ];
  return (
    <div className="ed-help-scrim" onClick={onClose}>
      <div className="ed-help-card" onClick={(e) => e.stopPropagation()}>
        <header className="ed-help-head">
          <span className="vw-brand">Atalhos</span>
          <em className="ed-help-sub">Frame.io</em>
        </header>
        <div className="ed-help-grid">
          {groups.map((g) => (
            <section key={g.title} className="ed-help-col">
              <h4>{g.title}</h4>
              {g.rows.map(([k, d]) => (
                <div key={k} className="ed-help-row">
                  <kbd>{k}</kbd>
                  <span>{d}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Per-shape hit area + drag layer ─────────────────────────────────────
//
// One transparent div per non-textBox annotation, sized to the shape's
// bounding box with a small inflation so thin lines stay easy to grab.
// Click selects, drag moves. Sits above the canvas (which renders the
// shapes themselves) and below the textBox layer (so text bubbles always
// win for hit-testing).

function ShapeHitLayer({
  annotations, rect, tool, selectedId, readOnly, onSelect, onEditStart, onMove, onResize,
}: {
  annotations: Annotation[];
  rect: Rect;
  tool: Tool;
  selectedId: string | null;
  readOnly?: boolean;
  onSelect: (id: string | null) => void;
  onEditStart: () => void;
  onMove: (id: string, dx: number, dy: number) => void;
  onResize: (id: string, handle: ShapeHandle, dx: number, dy: number) => void;
}) {
  // Only "active" in select mode — under a drawing tool, the canvas
  // below catches the pointer event for drawing. Read-only sessions
  // skip the hit layer entirely (no select / drag / resize).
  if (readOnly || tool !== "select") return null;

  const selected = annotations.find((a) => a.id === selectedId);

  return (
    <div className="ed-hitlayer">
      {/* Per-shape hit-rect for tap-to-select + drag-to-move. */}
      {annotations.map((a) => {
        const bb = annotationBBox(a);
        const left   = rect.x + bb.x * rect.w - 8;
        const top    = rect.y + bb.y * rect.h - 8;
        const width  = Math.max(28, bb.w * rect.w + 16);
        const height = Math.max(28, bb.h * rect.h + 16);
        return (
          <div
            key={a.id}
            className={`ed-hit${selectedId === a.id ? " on" : ""}`}
            style={{ left, top, width, height }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              (e.target as Element).setPointerCapture(e.pointerId);
              onSelect(a.id);
              const startX = e.clientX, startY = e.clientY;
              let lastDx = 0, lastDy = 0;
              let recorded = false;
              const move = (ev: PointerEvent) => {
                if (Math.hypot(ev.clientX - startX, ev.clientY - startY) <= 2) return;
                if (!recorded) {
                  onEditStart();
                  recorded = true;
                }
                const totalDx = (ev.clientX - startX) / rect.w;
                const totalDy = (ev.clientY - startY) / rect.h;
                const dx = totalDx - lastDx;
                const dy = totalDy - lastDy;
                lastDx = totalDx;
                lastDy = totalDy;
                onMove(a.id, dx, dy);
              };
              const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up);
            }}
          />
        );
      })}

      {/* Resize handles for the selected shape — small circles at each
          corner (rect/ellipse) or endpoint (line/arrow). Drag updates
          just that handle's coords. */}
      {selected && handlesForShape(selected).map((h) => {
        const pos = handlePosition(selected, h);
        const cx = rect.x + pos.x * rect.w;
        const cy = rect.y + pos.y * rect.h;
        return (
          <div
            key={`${selected.id}-${h}`}
            className={`ed-handle ed-handle-${h}`}
            style={{ left: cx - 6, top: cy - 6 }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              (e.target as Element).setPointerCapture(e.pointerId);
              const startX = e.clientX, startY = e.clientY;
              let lastDx = 0, lastDy = 0;
              let recorded = false;
              const move = (ev: PointerEvent) => {
                if (!recorded) {
                  onEditStart();
                  recorded = true;
                }
                const totalDx = (ev.clientX - startX) / rect.w;
                const totalDy = (ev.clientY - startY) / rect.h;
                const dx = totalDx - lastDx;
                const dy = totalDy - lastDy;
                lastDx = totalDx;
                lastDy = totalDy;
                onResize(selected.id, h, dx, dy);
              };
              const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up);
            }}
          />
        );
      })}
    </div>
  );
}

type ShapeHandle = "tl" | "tr" | "bl" | "br" | "p1" | "p2";

function handlesForShape(a: Annotation): ShapeHandle[] {
  switch (a.geom.shape) {
    case "rect":
    case "ellipse":
      return ["tl", "tr", "bl", "br"];
    case "arrow":
    case "line":
      return ["p1", "p2"];
    default:
      return [];
  }
}

function handlePosition(a: Annotation, h: ShapeHandle): { x: number; y: number } {
  const g = a.geom;
  if (g.shape === "rect" || g.shape === "ellipse") {
    switch (h) {
      case "tl": return { x: g.x,         y: g.y };
      case "tr": return { x: g.x + g.w,   y: g.y };
      case "bl": return { x: g.x,         y: g.y + g.h };
      case "br": return { x: g.x + g.w,   y: g.y + g.h };
      default:   return { x: g.x + g.w/2, y: g.y + g.h/2 };
    }
  }
  if (g.shape === "arrow" || g.shape === "line") {
    return h === "p1" ? { x: g.x1, y: g.y1 } : { x: g.x2, y: g.y2 };
  }
  return { x: 0, y: 0 };
}

/// Apply a (dx, dy) drag from a specific handle to a shape annotation.
/// Mirrors the Swift `AnnotationGeom.resized(...)`: rect/ellipse keep
/// the opposite corner fixed; line/arrow move only the dragged endpoint.
function resizeAnnotation(a: Annotation, h: ShapeHandle, dx: number, dy: number): Annotation {
  const g = a.geom;
  const minSize = 0.02;
  if (g.shape === "rect" || g.shape === "ellipse") {
    let { x, y, w, hh } = { x: g.x, y: g.y, w: g.w, hh: g.h };
    if (h === "tl") {
      x += dx; y += dy; w -= dx; hh -= dy;
    } else if (h === "tr") {
      y += dy; w += dx; hh -= dy;
    } else if (h === "bl") {
      x += dx; w -= dx; hh += dy;
    } else if (h === "br") {
      w += dx; hh += dy;
    }
    if (w < minSize) { if (h === "tl" || h === "bl") x = g.x + (g.w - minSize); w = minSize; }
    if (hh < minSize) { if (h === "tl" || h === "tr") y = g.y + (g.h - minSize); hh = minSize; }
    return { ...a, geom: { ...g, x, y, w, h: hh } };
  }
  if (g.shape === "arrow" || g.shape === "line") {
    if (h === "p1") return { ...a, geom: { ...g, x1: g.x1 + dx, y1: g.y1 + dy } };
    if (h === "p2") return { ...a, geom: { ...g, x2: g.x2 + dx, y2: g.y2 + dy } };
  }
  return a;
}

// ── TextBox overlay layer ───────────────────────────────────────────────
//
// One movable / resizable / editable speech-bubble per textBox
// annotation. Lives entirely in the DOM (not the canvas) so the textarea
// is actually editable and the tail's drag handle has its own hit area.

function TextBoxLayer({
  annotations, rect, selectedId, tool, readOnly, onSelect, onEditStart, onUpdate, onDelete,
}: {
  annotations: Annotation[];
  rect: Rect;
  selectedId: string | null;
  tool: Tool;
  readOnly?: boolean;
  onSelect: (id: string | null) => void;
  onEditStart: () => void;
  onUpdate: (id: string, geom: TextBoxGeom) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="ed-tblayer">
      {annotations.map((a) => {
        if (a.geom.shape !== "textBox") return null;
        return (
          <EditableTextBox
            key={a.id}
            annotation={a}
            geom={a.geom}
            rect={rect}
            isSelected={selectedId === a.id}
            tool={tool}
            readOnly={readOnly}
            onSelect={() => onSelect(a.id)}
            onEditStart={onEditStart}
            onUpdate={(g) => onUpdate(a.id, g)}
            onDelete={() => onDelete(a.id)}
          />
        );
      })}
    </div>
  );
}

function EditableTextBox({
  geom, rect, isSelected, tool, readOnly = false, onSelect, onEditStart, onUpdate, onDelete,
}: {
  annotation: Annotation;
  geom: TextBoxGeom;
  rect: Rect;
  isSelected: boolean;
  tool: Tool;
  readOnly?: boolean;
  onSelect: () => void;
  onEditStart: () => void;
  onUpdate: (g: TextBoxGeom) => void;
  onDelete: () => void;
}) {
  const left = rect.x + geom.x * rect.w;
  const top  = rect.y + geom.y * rect.h;
  const w    = geom.w * rect.w;
  const h    = geom.h * rect.h;
  const tipL = rect.x + geom.tailX * rect.w;
  const tipT = rect.y + geom.tailY * rect.h;

  const taRef = useRef<HTMLTextAreaElement>(null);

  // Edit-mode toggle. The bubble starts as a plain label and only
  // turns into a real textarea when:
  //   • the bubble was just created (text still empty), OR
  //   • the user double-clicks the body, OR
  //   • the user single-clicks the body while the text tool is active.
  // Single clicks otherwise just *select* the bubble (so it can be
  // moved / resized / deleted). The textarea steals every keystroke
  // it sees — without this gate, typing 'a' over a finished bubble
  // would silently extend it instead of advancing the playhead.
  const [isEditing, setIsEditing] = useState(geom.text === "" && !readOnly);

  // Auto-focus brand-new bubbles (text still empty). Existing ones with
  // content only focus when the user enters edit mode. Read-only
  // sessions never auto-focus.
  useEffect(() => {
    if (geom.text === "" && !readOnly && taRef.current) taRef.current.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-focus the textarea when edit mode is entered post-creation
  // (double-click / text tool). Without this, the user has to click
  // the body a second time to actually start typing.
  useEffect(() => {
    if (isEditing && taRef.current) taRef.current.focus();
  }, [isEditing]);

  // EXIT EDIT MODE the moment selection moves to anything else. The
  // background's pointerdown clears `selectedId` to null on every
  // outside-click; clicking another shape moves it to that shape's
  // id. Either way `isSelected` flips to false here, and the bubble
  // drops back to the read-only label.
  useEffect(() => {
    if (!isSelected && isEditing) setIsEditing(false);
  }, [isSelected, isEditing]);

  const enterEdit = () => {
    onSelect();
    onEditStart();
    setIsEditing(true);
  };

  // Tail-base geometry: the side of the box closest to the tip wins.
  const dx = tipL - (left + w / 2);
  const dy = tipT - (top + h / 2);
  const baseW = Math.max(10, Math.min(w, h) * 0.20);
  let b1x: number, b1y: number, b2x: number, b2y: number;
  if (Math.abs(dx) > Math.abs(dy)) {
    const bx = dx > 0 ? left + w : left;
    const cy = clamp(top + h / 2, top + baseW / 2 + 4, top + h - baseW / 2 - 4);
    b1x = bx; b1y = cy - baseW / 2;
    b2x = bx; b2y = cy + baseW / 2;
  } else {
    const by = dy > 0 ? top + h : top;
    const cx = clamp(left + w / 2, left + baseW / 2 + 4, left + w - baseW / 2 - 4);
    b1x = cx - baseW / 2; b1y = by;
    b2x = cx + baseW / 2; b2y = by;
  }

  const startDrag = (e: React.PointerEvent) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect();
    (e.target as Element).setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const startG = { ...geom };
    let recorded = false;
    const move = (ev: PointerEvent) => {
      if (!recorded) {
        onEditStart();
        recorded = true;
      }
      const ndx = (ev.clientX - startX) / rect.w;
      const ndy = (ev.clientY - startY) / rect.h;
      onUpdate({
        ...startG,
        x: clamp(startG.x + ndx, 0, Math.max(0, 1 - startG.w)),
        y: clamp(startG.y + ndy, 0, Math.max(0, 1 - startG.h)),
        tailX: clamp(startG.tailX + ndx, 0, 1),
        tailY: clamp(startG.tailY + ndy, 0, 1),
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startResize = (e: React.PointerEvent) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const startG = { ...geom };
    let recorded = false;
    const move = (ev: PointerEvent) => {
      if (!recorded) {
        onEditStart();
        recorded = true;
      }
      const nw = Math.max(0.10, startG.w + (ev.clientX - startX) / rect.w);
      const nh = Math.max(0.06, startG.h + (ev.clientY - startY) / rect.h);
      onUpdate({
        ...startG,
        w: Math.min(nw, 1 - startG.x),
        h: Math.min(nh, 1 - startG.y),
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startTail = (e: React.PointerEvent) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY;
    const startG = { ...geom };
    let recorded = false;
    const move = (ev: PointerEvent) => {
      if (!recorded) {
        onEditStart();
        recorded = true;
      }
      onUpdate({
        ...startG,
        tailX: clamp(startG.tailX + (ev.clientX - startX) / rect.w, 0, 1),
        tailY: clamp(startG.tailY + (ev.clientY - startY) / rect.h, 0, 1),
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <>
      {/* Tail SVG — behind the box. Filled with the bubble surface so the box's
          bottom edge crossing the base of the triangle is masked. */}
      <svg
        className="ed-tb-tail"
        style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none",
                 width: "100%", height: "100%", overflow: "visible" }}
      >
        <polygon
          points={`${b1x},${b1y} ${tipL},${tipT} ${b2x},${b2y}`}
          fill={BUBBLE_PAPER}
          stroke={BUBBLE_ACCENT}
          strokeWidth={1}
        />
      </svg>

      {/* Box */}
      <div
        className={`ed-tb${isSelected ? " on" : ""}${readOnly ? " readonly" : ""}`}
        style={{ left, top, width: w, height: h }}
        onPointerDown={(e) => {
          if (readOnly) return;            // no select in view-only
          e.stopPropagation();
          onSelect();
        }}
      >
        {/* Drag bar (grip + delete) — write chrome only. */}
        {!readOnly && (
          <div className="ed-tb-bar" onPointerDown={startDrag}>
            <span className="ed-tb-grip">≡</span>
            <button
              className="ed-tb-x"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              onPointerDown={(e) => e.stopPropagation()}
              title="Excluir"
            >×</button>
          </div>
        )}
        {isEditing && !readOnly ? (
          <textarea
            ref={taRef}
            className="ed-tb-text"
            value={geom.text}
            onChange={(e) => onUpdate({ ...geom, text: e.target.value })}
            // Clicking inside the open editor keeps the bubble selected
            // — don't bubble up to the parent which would toggle edit
            // mode off (single-click on a non-edit bubble = select).
            onPointerDown={(e) => e.stopPropagation()}
            // Esc / Enter (without Shift) commits and returns to label.
            onKeyDown={(e) => {
              if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                setIsEditing(false);
              }
            }}
            placeholder="Comentário…"
          />
        ) : (
          <div
            className="ed-tb-text ed-tb-text-static"
            // Static label — single-click selects, double-click edits,
            // single-click while the text tool is active also edits.
            // In read-only, just a plain label; the underlying media
            // takes the click instead.
            onPointerDown={(e) => {
              if (readOnly) return;
              e.stopPropagation(); onSelect();
            }}
            onClick={(e) => {
              if (readOnly) return;
              e.stopPropagation();
              if (tool === "text") enterEdit();
            }}
            onDoubleClick={(e) => {
              if (readOnly) return;
              e.stopPropagation(); enterEdit();
            }}
          >
            {geom.text || (
              !readOnly && (
                <span className="ed-tb-text-placeholder">Toque duas vezes para editar</span>
              )
            )}
          </div>
        )}
        {/* Resize handle — write chrome only. */}
        {!readOnly && (
          <div
            className="ed-tb-resize"
            onPointerDown={startResize}
            title="Redimensionar"
          >⤡</div>
        )}
      </div>

      {/* Tail-tip handle — write chrome only. */}
      {!readOnly && (
        <div
          className="ed-tb-tip"
          style={{ left: tipL - 5, top: tipT - 5 }}
          onPointerDown={startTail}
          title="Mover a ponta do balão"
        />
      )}
    </>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi);
}

function positiveSize(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function initialVersionStates(
  session: SessionContext | undefined,
  payload: ReviewPayload,
  initialVersionId: string,
): Record<string, ReviewVersionState> {
  const states: Record<string, ReviewVersionState> = {};
  for (const [versionId, state] of Object.entries(session?.versionStates ?? {})) {
    states[versionId] = {
      ...state,
      comments: cloneComments(state.comments ?? []),
    };
  }
  if (!states[initialVersionId]) {
    states[initialVersionId] = {
      status: payload.status || "in_review",
      comments: cloneComments(payload.comments ?? []),
    };
  }
  return states;
}

function cloneComments(comments: ReviewComment[]): ReviewComment[] {
  return comments.map((c) => ({
    ...c,
    anchor: { ...c.anchor } as ReviewComment["anchor"],
    annotations: cloneAnnotations(c.annotations),
  }));
}

function cloneAnnotations(annotations: Annotation[]): Annotation[] {
  return annotations.map((a) => ({
    ...a,
    geom: cloneGeom(a.geom),
  }));
}

function cloneGeom(g: AnnotationGeom): AnnotationGeom {
  switch (g.shape) {
    case "rect":
    case "ellipse":
      return { shape: g.shape, x: g.x, y: g.y, w: g.w, h: g.h };
    case "arrow":
    case "line":
      return { shape: g.shape, x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2 };
    case "freehand":
      return { shape: "freehand", points: g.points.map((p) => ({ ...p })) };
    case "text":
      return { shape: "text", x: g.x, y: g.y, text: g.text };
    case "textBox":
      return {
        shape: "textBox",
        x: g.x,
        y: g.y,
        w: g.w,
        h: g.h,
        text: g.text,
        tailX: g.tailX,
        tailY: g.tailY,
      };
  }
}

function notTextBox(a: Annotation): boolean {
  return a.geom.shape !== "textBox";
}

function findAnnotation(
  id: string, pending: Annotation[], comments: ReviewComment[],
): Annotation | undefined {
  const inPending = pending.find((a) => a.id === id);
  if (inPending) return inPending;
  for (const c of comments) {
    const hit = c.annotations.find((a) => a.id === id);
    if (hit) return hit;
  }
  return undefined;
}

function mkAnnotation(geom: AnnotationGeom, color: string, strokeWidth: number): Annotation {
  return { id: crypto.randomUUID(), commentId: "", color, strokeWidth, geom };
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
  return mkAnnotation(geom, d.color, d.strokeValue);
}

function anchorMs(c: ReviewComment): number {
  return c.anchor.kind === "video" ? c.anchor.timeMs : Number.MAX_SAFE_INTEGER;
}

function commentIsActiveAtMs(c: ReviewComment, currentMs: number): boolean {
  if (c.anchor.kind !== "video") return false;
  const toleranceMs = 50;
  const start = c.anchor.timeMs;
  const end = c.anchor.endMs;
  if (typeof end === "number" && end > start) {
    return currentMs >= start - toleranceMs && currentMs <= end + toleranceMs;
  }
  return Math.abs(start - currentMs) <= toleranceMs;
}

function summarize(
  comments: ReviewComment[],
  status: string,
  title: string,
  reviewerName: string = "",
): string {
  const total = comments.length;
  const resolved = comments.filter((c) => c.resolved).length;
  const label = status === "approved" ? "Aprovado"
    : status === "changes_requested" ? "Pede alterações" : "Em revisão";
  const lines: string[] = [];
  if (title) lines.push(title);
  // The web review posts back to ClickUp via the workspace-owner's API
  // token, so the ClickUp avatar/byline of the resulting comment is
  // ALWAYS the owner — never the reviewer. Prepending "Review por X"
  // is the only honest attribution the body can carry.
  const author = reviewerName.trim();
  const byline = author ? ` por ${author}` : "";
  lines.push(`📝 Review${byline} (${label}) — ${total} comentário(s), ${resolved} resolvido(s):`);
  for (const c of comments) {
    const mark = c.annotations.length ? " ✎" : "";
    const who = c.authorName && c.authorName !== "Revisor" && c.authorName !== author
      ? `${c.authorName} · ` : "";
    lines.push(`• [${anchorLabel(c)}]${mark} ${who}${c.body || "(marcação)"}`);
  }
  return lines.join("\n");
}
