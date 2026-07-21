import type { Annotation } from "../contract/model";

export interface Rect { x: number; y: number; w: number; h: number }

/// Aspect-fit a content size inside a box (matches object-fit: contain).
export function fitRect(boxW: number, boxH: number, cW: number, cH: number): Rect {
  if (!cW || !cH || !boxW || !boxH) return { x: 0, y: 0, w: boxW, h: boxH };
  const s = Math.min(boxW / cW, boxH / cH);
  const w = cW * s, h = cH * s;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/// Render annotations (normalized [0..1] coords) onto a canvas within `rect`.
export function drawAnnotations(ctx: CanvasRenderingContext2D, anns: Annotation[], rect: Rect) {
  for (const a of anns) drawOne(ctx, a, rect);
}

function drawOne(ctx: CanvasRenderingContext2D, a: Annotation, r: Rect) {
  const color = a.color || "#7C5CFF";
  const lw = Math.max(1.5, (a.strokeWidth ?? 0.004) * r.w);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const X = (x: number) => r.x + x * r.w;
  const Y = (y: number) => r.y + y * r.h;
  const g = a.geom;

  switch (g.shape) {
    case "rect":
      ctx.strokeRect(X(g.x), Y(g.y), g.w * r.w, g.h * r.h);
      break;
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(X(g.x) + (g.w * r.w) / 2, Y(g.y) + (g.h * r.h) / 2,
        (g.w * r.w) / 2, (g.h * r.h) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "line":
      ctx.beginPath();
      ctx.moveTo(X(g.x1), Y(g.y1));
      ctx.lineTo(X(g.x2), Y(g.y2));
      ctx.stroke();
      break;
    case "arrow": {
      const ax = X(g.x2), ay = Y(g.y2);
      const ang = Math.atan2(ay - Y(g.y1), ax - X(g.x1));
      const head = Math.max(9, lw * 4);
      ctx.beginPath();
      ctx.moveTo(X(g.x1), Y(g.y1));
      ctx.lineTo(ax, ay);
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - head * Math.cos(ang - Math.PI / 6), ay - head * Math.sin(ang - Math.PI / 6));
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - head * Math.cos(ang + Math.PI / 6), ay - head * Math.sin(ang + Math.PI / 6));
      ctx.stroke();
      break;
    }
    case "freehand":
      ctx.beginPath();
      g.points.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
      ctx.stroke();
      break;
    case "text":
      ctx.font = `600 ${Math.max(12, r.w * 0.025)}px -apple-system, system-ui, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(g.text, X(g.x), Y(g.y));
      break;
    case "textBox":
      // Rendered as an HTML overlay (movable + resizable + editable
      // speech-bubble) by the Editor's TextBoxLayer — skip here so the
      // canvas doesn't double-paint a stale non-interactive copy.
      break;
  }
}

/**
 * Normalised bounding box of an annotation in [0..1] coords. Used by
 * the interactive layer to position per-shape hit-areas and to draw
 * the dashed selection outline.
 */
export function annotationBBox(a: Annotation): { x: number; y: number; w: number; h: number } {
  const g = a.geom;
  switch (g.shape) {
    case "rect":
    case "ellipse":
      return { x: g.x, y: g.y, w: g.w, h: g.h };
    case "arrow":
    case "line": {
      const x = Math.min(g.x1, g.x2), y = Math.min(g.y1, g.y2);
      return { x, y, w: Math.abs(g.x2 - g.x1), h: Math.abs(g.y2 - g.y1) };
    }
    case "freehand": {
      if (!g.points.length) return { x: 0, y: 0, w: 0, h: 0 };
      let mnx = g.points[0].x, mxx = mnx, mny = g.points[0].y, mxy = mny;
      for (const p of g.points) {
        if (p.x < mnx) mnx = p.x; if (p.x > mxx) mxx = p.x;
        if (p.y < mny) mny = p.y; if (p.y > mxy) mxy = p.y;
      }
      return { x: mnx, y: mny, w: mxx - mnx, h: mxy - mny };
    }
    case "text":
      return { x: g.x, y: g.y, w: 0.20, h: 0.04 };
    case "textBox":
      return { x: g.x, y: g.y, w: g.w, h: g.h };
  }
}

/**
 * Return a NEW annotation with every coord shifted by a normalised
 * delta. Used while a selected shape is being dragged: parent owns
 * the model, child reports `(dx, dy)` on drag end, parent commits.
 */
export function translateAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  const g = a.geom;
  let geom: typeof a.geom;
  switch (g.shape) {
    case "rect":
    case "ellipse":
      geom = { ...g, x: g.x + dx, y: g.y + dy };
      break;
    case "arrow":
    case "line":
      geom = { ...g, x1: g.x1 + dx, y1: g.y1 + dy, x2: g.x2 + dx, y2: g.y2 + dy };
      break;
    case "freehand":
      geom = { ...g, points: g.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
      break;
    case "text":
      geom = { ...g, x: g.x + dx, y: g.y + dy };
      break;
    case "textBox":
      geom = { ...g, x: g.x + dx, y: g.y + dy, tailX: g.tailX + dx, tailY: g.tailY + dy };
      break;
  }
  return { ...a, geom };
}
