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
  const color = a.color || "#C7321B";
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
  }
}
