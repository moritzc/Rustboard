import {
  type BBox, type Mat, apply, bboxOfPoints, distToSeg, normAngle, pointInPoly, rotPt,
} from './geom';
import { layoutText } from './textlayout';
import type { Box, BoxObj, Obj, ShapeObj, StrokeObj, TextObj } from './types';
import { isPtsShape } from './types';

export function textHeight(o: TextObj) {
  return layoutText(o.text || ' ', o.font, o.fontSize, o.w, o.bold, o.italic).height;
}

export function boxOf(o: BoxObj): Box {
  if (o.type === 'text') return { x: o.x, y: o.y, w: o.w, h: textHeight(o), rot: o.rot };
  return o;
}

/** 4 rotated corners [x0,y0, x1,y1, x2,y2, x3,y3] (TL, TR, BR, BL) */
export function corners(b: Box): number[] {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const pts = [b.x, b.y, b.x + b.w, b.y, b.x + b.w, b.y + b.h, b.x, b.y + b.h];
  if (!b.rot) return pts;
  const out: number[] = [];
  for (let i = 0; i < 8; i += 2) out.push(...rotPt(pts[i], pts[i + 1], cx, cy, b.rot));
  return out;
}

const bboxCache = new WeakMap<Obj, BBox>();
export function bboxOf(o: Obj): BBox {
  let b = bboxCache.get(o);
  if (b) return b;
  if (o.type === 'stroke') {
    b = bboxOfPoints(o.pts, 3, o.size / 2 + 1);
  } else if (o.type === 'shape') {
    if (o.kind === 'line' || o.kind === 'arrow' || o.kind === 'polygon') {
      const hasHead = o.kind === 'arrow' || o.arrowStart || o.arrowEnd;
      b = bboxOfPoints(o.pts!, 2, o.width / 2 + (hasHead ? o.width * 3 + 6 : 1));
    } else {
      b = bboxOfPoints(corners(boxOf(o)), 2, o.width / 2 + 1);
    }
  } else {
    b = bboxOfPoints(corners(boxOf(o)), 2, 0);
  }
  bboxCache.set(o, b);
  return b;
}

/** local polygon of a box shape, relative to its top-left, unrotated */
export function boxShapeLocal(kind: ShapeObj['kind'], w: number, h: number): number[] | null {
  switch (kind) {
    case 'rect': return [0, 0, w, 0, w, h, 0, h];
    case 'triangle': return [w / 2, 0, w, h, 0, h];
    case 'diamond': return [w / 2, 0, w, h / 2, w / 2, h, 0, h / 2];
    default: return null;
  }
}

/** Outline as a world-space polyline. Returns {pts, closed}. */
export function shapeOutline(o: ShapeObj): { pts: number[]; closed: boolean } {
  if (o.kind === 'line' || o.kind === 'arrow') return { pts: o.pts!, closed: false };
  if (o.kind === 'polygon') return { pts: o.pts!, closed: true };
  let local = boxShapeLocal(o.kind, o.w, o.h);
  if (!local) {
    local = [];
    const n = 48;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      local.push(o.w / 2 + (Math.cos(a) * o.w) / 2, o.h / 2 + (Math.sin(a) * o.h) / 2);
    }
  }
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  const pts: number[] = [];
  for (let i = 0; i < local.length; i += 2) pts.push(...rotPt(o.x + local[i], o.y + local[i + 1], cx, cy, o.rot));
  return { pts, closed: true };
}

function polyDist(x: number, y: number, pts: number[], closed: boolean, stride = 2) {
  let d = Infinity;
  const n = pts.length;
  if (n < 2 * stride) return n >= 2 ? Math.hypot(x - pts[0], y - pts[1]) : Infinity;
  for (let i = 0; i + stride < n; i += stride) d = Math.min(d, distToSeg(x, y, pts[i], pts[i + 1], pts[i + stride], pts[i + stride + 1]));
  if (closed) d = Math.min(d, distToSeg(x, y, pts[n - stride], pts[n - stride + 1], pts[0], pts[1]));
  return d;
}

export function strokeDist(s: StrokeObj, x: number, y: number) {
  return polyDist(x, y, s.pts, false, 3);
}

export function insideBox(b: Box, x: number, y: number) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const [lx, ly] = rotPt(x, y, cx, cy, -b.rot);
  return lx >= b.x && lx <= b.x + b.w && ly >= b.y && ly <= b.y + b.h;
}

/** Frame label hit area (world units) */
export function frameLabelBox(o: BoxObj, zoom: number): Box {
  const h = 22 / zoom;
  return { x: o.x, y: o.y - h, w: Math.max(80 / zoom, o.w * 0.5), h, rot: 0 };
}

export function hitTest(o: Obj, x: number, y: number, tol: number, zoom: number): boolean {
  const b = bboxOf(o);
  if (o.type !== 'frame' && (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol)) return false;
  switch (o.type) {
    case 'stroke': return strokeDist(o, x, y) <= o.size / 2 + tol;
    case 'shape': {
      const ol = shapeOutline(o);
      if (polyDist(x, y, ol.pts, ol.closed) <= o.width / 2 + tol) return true;
      if (o.fill && ol.closed) return pointInPoly(x, y, ol.pts);
      return false;
    }
    case 'frame': {
      if (insideBox(frameLabelBox(o, zoom), x, y)) return true;
      const ol = corners(o);
      return polyDist(x, y, ol, true) <= Math.max(tol * 1.5, 12 / zoom);
    }
    default: return insideBox(boxOf(o), x, y);
  }
}

/** Sample points used to decide lasso inclusion. */
export function samplePoints(o: Obj): number[] {
  if (o.type === 'stroke') {
    const out: number[] = [];
    const step = Math.max(1, Math.floor(o.pts.length / 3 / 40)) * 3;
    for (let i = 0; i < o.pts.length; i += step) out.push(o.pts[i], o.pts[i + 1]);
    return out;
  }
  if (o.type === 'shape') return shapeOutline(o).pts;
  const b = boxOf(o);
  return [...corners(b), b.x + b.w / 2, b.y + b.h / 2];
}

export interface TransformInfo {
  sx: number;
  sy: number;
  dAngle: number;
  frameAngle: number;
  scaling: boolean;
}

function approx(a: number, b: number) {
  return Math.abs(a - b) < 0.02;
}

export function transformObj(o: Obj, M: Mat, t: TransformInfo): Obj {
  const k = Math.sqrt(Math.abs(t.sx * t.sy));
  if (o.type === 'stroke') {
    const pts = o.pts.slice();
    for (let i = 0; i < pts.length; i += 3) {
      const [x, y] = apply(M, pts[i], pts[i + 1]);
      pts[i] = x;
      pts[i + 1] = y;
    }
    return { ...o, pts, size: t.scaling ? Math.max(0.5, o.size * k) : o.size };
  }
  if (isPtsShape(o)) {
    const pts = o.pts!.slice();
    for (let i = 0; i < pts.length; i += 2) {
      const [x, y] = apply(M, pts[i], pts[i + 1]);
      pts[i] = x;
      pts[i + 1] = y;
    }
    return { ...o, pts };
  }
  const b = boxOf(o);
  const [cx, cy] = apply(M, b.x + b.w / 2, b.y + b.h / 2);
  let w = b.w, h = b.h;
  let extra: Partial<Obj> = {};
  if (t.scaling) {
    const rel = Math.abs(normAngle(b.rot - t.frameAngle)) % Math.PI;
    let fx: number, fy: number;
    if (approx(rel, 0) || approx(rel, Math.PI)) { fx = t.sx; fy = t.sy; }
    else if (approx(rel, Math.PI / 2)) { fx = t.sy; fy = t.sx; }
    else { fx = fy = k; }
    fx = Math.abs(fx);
    fy = Math.abs(fy);
    if (o.type === 'text') {
      const fs = Math.max(4, o.fontSize * (fx !== 1 && fy !== 1 ? fy : fy));
      w = Math.max(20, w * fx);
      extra = { fontSize: fs };
      h = layoutText(o.text || ' ', o.font, fs, w).height;
    } else {
      w = Math.max(4, w * fx);
      h = Math.max(4, h * fy);
      if (o.type === 'sticky') extra = { fontSize: Math.max(6, o.fontSize * Math.sqrt(fx * fy)) };
    }
  }
  const rot = o.type === 'frame' || o.type === 'pdfpage' ? 0 : normAngle(b.rot + t.dAngle);
  return { ...o, ...extra, x: cx - w / 2, y: cy - h / 2, w, h, rot } as Obj;
}

export function translateObj(o: Obj, dx: number, dy: number): Obj {
  if (o.type === 'stroke') {
    const pts = o.pts.slice();
    for (let i = 0; i < pts.length; i += 3) { pts[i] += dx; pts[i + 1] += dy; }
    return { ...o, pts };
  }
  if (isPtsShape(o)) {
    const pts = o.pts!.map((v, i) => v + (i % 2 ? dy : dx));
    return { ...o, pts };
  }
  return { ...o, x: o.x + dx, y: o.y + dy } as Obj;
}

/** Objects that ink erasers can affect */
export const isInk = (o: Obj) => o.type === 'stroke' || o.type === 'shape';

/** Which ends of a line shape carry an arrowhead. */
export function shapeArrows(sh: ShapeObj): { start: boolean; end: boolean } {
  return { start: !!sh.arrowStart, end: !!sh.arrowEnd || sh.kind === 'arrow' };
}

/** Dash pattern (world units) for a shape stroke; empty = solid. */
export function shapeDash(sh: ShapeObj): number[] {
  const w = Math.max(1, sh.width);
  if (sh.dash === 'dashed') return [w * 3.2, w * 2.4];
  if (sh.dash === 'dotted') return [0.01, w * 2.2];
  return [];
}

/** Two arrowhead wing points for a tip at (tx,ty) pointing away from (fx,fy). */
export function arrowWings(fx: number, fy: number, tx: number, ty: number, width: number): number[] {
  const a = Math.atan2(ty - fy, tx - fx);
  const len = Math.max(12, width * 3.5);
  return [
    tx - len * Math.cos(a - Math.PI / 6), ty - len * Math.sin(a - Math.PI / 6),
    tx - len * Math.cos(a + Math.PI / 6), ty - len * Math.sin(a + Math.PI / 6),
  ];
}

/** True if object `o` sits inside frame `f` (its bbox centre lies within the frame). */
export function insideFrame(o: Obj, f: Box): boolean {
  const b = bboxOf(o);
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  return cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h;
}

export interface SelectionFrame {
  box: Box;
  canRotate: boolean;
  locked: boolean;
}

/**
 * Manipulation box for the current selection: a single box-type object keeps its own
 * rotated box; strokes, lines and multi-selections use the union AABB.
 */
export function selectionFrame(objects: Obj[], ids: Set<string>): SelectionFrame | null {
  const sel = objects.filter((o) => ids.has(o.id));
  if (sel.length === 0) return null;
  const canRotate = !sel.some((o) => o.type === 'frame' || o.type === 'pdfpage');
  const locked = sel.every((o) => o.locked);
  if (sel.length === 1 && sel[0].type !== 'stroke' && !isPtsShape(sel[0])) {
    const b = boxOf(sel[0] as BoxObj);
    return { box: { x: b.x, y: b.y, w: b.w, h: b.h, rot: b.rot || 0 }, canRotate, locked };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of sel) {
    const b = bboxOf(o);
    minX = Math.min(minX, b[0]); minY = Math.min(minY, b[1]);
    maxX = Math.max(maxX, b[2]); maxY = Math.max(maxY, b[3]);
  }
  return { box: { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY), rot: 0 }, canRotate, locked };
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rot';

/** Distance (screen px) of the rotate handle above the selection box. */
export const ROT_HANDLE_OFFSET = 34;

/** World positions of all selection handles. */
export function handlePositions(b: Box, zoom: number, canRotate: boolean): [Handle, number, number][] {
  const local: [Handle, number, number][] = [
    ['nw', 0, 0], ['n', b.w / 2, 0], ['ne', b.w, 0], ['e', b.w, b.h / 2],
    ['se', b.w, b.h], ['s', b.w / 2, b.h], ['sw', 0, b.h], ['w', 0, b.h / 2],
  ];
  if (canRotate) local.push(['rot', b.w / 2, -ROT_HANDLE_OFFSET / zoom]);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return local.map(([h, lx, ly]) => {
    const [x, y] = rotPt(b.x + lx, b.y + ly, cx, cy, b.rot);
    return [h, x, y];
  });
}
