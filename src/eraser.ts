import { type BBox, bboxUnion } from './geom';
import { bboxOf, shapeOutline } from './objects';
import type { Obj, StrokeObj } from './types';
import { uid } from './types';

export interface EraserState {
  active: boolean;
  x: number; // world x
  y: number; // world y
  radius: number; // world radius
}

export interface EraseResult {
  remaining: Obj[];
  changed: boolean;
  dirtyBBox: BBox | null;
}

function distToSegSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const rx = px - (ax + t * dx);
  const ry = py - (ay + t * dy);
  return rx * rx + ry * ry;
}

function segsIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function segSegDistSq(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): number {
  if (segsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    distToSegSq(ax, ay, cx, cy, dx, dy),
    distToSegSq(bx, by, cx, cy, dx, dy),
    distToSegSq(cx, cy, ax, ay, bx, by),
    distToSegSq(dx, dy, ax, ay, bx, by),
  );
}

function segmentIntersectsAABB(
  x0: number, y0: number, x1: number, y1: number,
  minX: number, minY: number, maxX: number, maxY: number,
): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;

  if (dx === 0) {
    if (x0 < minX || x0 > maxX) return false;
  } else {
    const inv = 1 / dx;
    let ta = (minX - x0) * inv;
    let tb = (maxX - x0) * inv;
    if (ta > tb) {
      const tmp = ta;
      ta = tb;
      tb = tmp;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }

  if (dy === 0) {
    if (y0 < minY || y0 > maxY) return false;
  } else {
    const inv = 1 / dy;
    let ta = (minY - y0) * inv;
    let tb = (maxY - y0) * inv;
    if (ta > tb) {
      const tmp = ta;
      ta = tb;
      tb = tmp;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }

  return true;
}

/**
 * Partial / Slicing Eraser at a single point: delegates to the capsule eraser.
 */
export function eraseObjectsAt(
  objects: Obj[],
  ex: number,
  ey: number,
  radius: number,
): EraseResult {
  return eraseObjectsAlongSegment(objects, ex, ey, ex, ey, radius);
}

/**
 * Single-pass capsule (swept circle) eraser from (x0, y0) to (x1, y1) with radius.
 * Uses cached object bounding boxes for O(1) rejection and returns the exact
 * world dirtyBBox of modified/removed objects for incremental canvas repainting.
 */
export function eraseObjectsAlongSegment(
  objects: Obj[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
): EraseResult {
  let changed = false;
  let dirtyBBox: BBox | null = null;
  const result: Obj[] = [];

  const segMinX = Math.min(x0, x1) - radius;
  const segMinY = Math.min(y0, y1) - radius;
  const segMaxX = Math.max(x0, x1) + radius;
  const segMaxY = Math.max(y0, y1) + radius;

  const mergeDirty = (b: BBox) => {
    dirtyBBox = dirtyBBox ? bboxUnion(dirtyBBox, b) : [b[0], b[1], b[2], b[3]];
  };

  for (let idx = 0; idx < objects.length; idx++) {
    const obj = objects[idx];
    if (obj.locked || obj.type === 'frame') {
      result.push(obj);
      continue;
    }

    // Fast O(1) cached bounding box rejection
    const ob = bboxOf(obj);
    if (ob[2] < segMinX || ob[0] > segMaxX || ob[3] < segMinY || ob[1] > segMaxY) {
      result.push(obj);
      continue;
    }

    if (obj.type === 'stroke') {
      const sliced = sliceStrokeSegment(obj, x0, y0, x1, y1, radius);
      if (sliced.length !== 1 || sliced[0] !== obj) {
        changed = true;
        mergeDirty(ob);
        for (let k = 0; k < sliced.length; k++) {
          result.push(sliced[k]);
        }
      } else {
        result.push(obj);
      }
    } else if (obj.type === 'shape' && !obj.fill) {
      // Unfilled shapes (lines, arrows, rects, ellipses, etc.) can be partially erased/sliced
      const ol = shapeOutline(obj);
      const strokePts: number[] = [];
      const n = ol.pts.length;
      for (let i = 0; i < n; i += 2) {
        strokePts.push(ol.pts[i], ol.pts[i + 1], 0.5);
      }
      if (ol.closed && n >= 4) {
        strokePts.push(ol.pts[0], ol.pts[1], 0.5);
      }
      const surrogateStroke: StrokeObj = {
        id: obj.id,
        type: 'stroke',
        pts: strokePts,
        color: obj.color,
        size: obj.width,
      };
      const sliced = sliceStrokeSegment(surrogateStroke, x0, y0, x1, y1, radius);
      if (sliced.length !== 1 || sliced[0] !== surrogateStroke) {
        changed = true;
        mergeDirty(ob);
        for (let k = 0; k < sliced.length; k++) {
          result.push(sliced[k]);
        }
      } else {
        result.push(obj);
      }
    } else {
      // Filled shapes, sticky notes, images, pdf pages, text: check hit against swept segment
      let hit = false;
      if (obj.type === 'shape' && (obj.kind === 'line' || obj.kind === 'arrow')) {
        const pts = obj.pts!;
        const eff = radius + (obj.width || 2) / 2;
        if (segSegDistSq(x0, y0, x1, y1, pts[0], pts[1], pts[2], pts[3]) <= eff * eff) {
          hit = true;
        }
      } else {
        if (segmentIntersectsAABB(x0, y0, x1, y1, ob[0] - radius, ob[1] - radius, ob[2] + radius, ob[3] + radius)) {
          hit = true;
        }
      }

      if (hit) {
        changed = true; // deleted
        mergeDirty(ob);
      } else {
        result.push(obj);
      }
    }
  }

  return { remaining: result, changed, dirtyBBox };
}

/**
 * Cuts a stroke with an eraser circle at a single point.
 */
export function sliceStroke(stroke: StrokeObj, ex: number, ey: number, radius: number): StrokeObj[] {
  return sliceStrokeSegment(stroke, ex, ey, ex, ey, radius);
}

/**
 * Cuts a stroke with a swept eraser capsule from (x0, y0) to (x1, y1) of radius.
 * Only segments near the eraser capsule are subdivided; untouched strokes exit
 * immediately with zero heap allocations.
 */
export function sliceStrokeSegment(
  stroke: StrokeObj,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
): StrokeObj[] {
  const pts = stroke.pts;
  const len = pts.length;
  if (len < 3) return [];

  const effR = radius + stroke.size / 2;
  const effR2 = effR * effR;
  const isPoint = x0 === x1 && y0 === y1;

  // Single-point dot stroke
  if (len === 3) {
    const d2 = isPoint
      ? (pts[0] - x0) * (pts[0] - x0) + (pts[1] - y0) * (pts[1] - y0)
      : distToSegSq(pts[0], pts[1], x0, y0, x1, y1);
    return d2 <= effR2 ? [] : [stroke];
  }

  const capMinX = Math.min(x0, x1) - effR;
  const capMinY = Math.min(y0, y1) - effR;
  const capMaxX = Math.max(x0, x1) + effR;
  const capMaxY = Math.max(y0, y1) + effR;

  // Fast allocation-free intersection check across stroke segments
  let touches = false;
  for (let i = 3; i < len; i += 3) {
    const ax = pts[i - 3];
    const ay = pts[i - 2];
    const bx = pts[i];
    const by = pts[i + 1];

    if (
      (ax < capMinX && bx < capMinX) ||
      (ax > capMaxX && bx > capMaxX) ||
      (ay < capMinY && by < capMinY) ||
      (ay > capMaxY && by > capMaxY)
    ) {
      continue;
    }

    const d2 = isPoint
      ? distToSegSq(x0, y0, ax, ay, bx, by)
      : segSegDistSq(ax, ay, bx, by, x0, y0, x1, y1);
    if (d2 <= effR2) {
      touches = true;
      break;
    }
  }

  if (!touches) {
    return [stroke];
  }

  // Stream through stroke points, subdividing ONLY segments whose bounds overlap the capsule
  const maxStep = Math.max(3, effR * 0.4);
  const maxStep2 = maxStep * maxStep;
  const subStrokes: StrokeObj[] = [];
  let currentSegment: number[] = [];
  let anyCut = false;

  const testAndPush = (px: number, py: number, pp: number) => {
    const d2 = isPoint
      ? (px - x0) * (px - x0) + (py - y0) * (py - y0)
      : distToSegSq(px, py, x0, y0, x1, y1);
    if (d2 > effR2) {
      currentSegment.push(px, py, pp);
    } else {
      anyCut = true;
      if (currentSegment.length >= 6) {
        subStrokes.push({
          ...stroke,
          id: uid(),
          pts: currentSegment,
        });
      }
      currentSegment = [];
    }
  };

  testAndPush(pts[0], pts[1], pts[2]);

  for (let i = 3; i < len; i += 3) {
    const ax = pts[i - 3];
    const ay = pts[i - 2];
    const ap = pts[i - 1];
    const bx = pts[i];
    const by = pts[i + 1];
    const bp = pts[i + 2];

    if (
      (ax < capMinX && bx < capMinX) ||
      (ax > capMaxX && bx > capMaxX) ||
      (ay < capMinY && by < capMinY) ||
      (ay > capMaxY && by > capMaxY)
    ) {
      // Entire segment is strictly outside the eraser capsule — keep untouched without subdividing
      currentSegment.push(bx, by, bp);
      continue;
    }

    const dx = bx - ax;
    const dy = by - ay;
    const d2 = dx * dx + dy * dy;

    if (d2 > maxStep2) {
      const steps = Math.ceil(Math.sqrt(d2) / maxStep);
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        testAndPush(ax + dx * t, ay + dy * t, ap + (bp - ap) * t);
      }
    } else {
      testAndPush(bx, by, bp);
    }
  }

  if (currentSegment.length >= 6) {
    subStrokes.push({
      ...stroke,
      id: uid(),
      pts: currentSegment,
    });
  }

  if (!anyCut) {
    return [stroke];
  }

  return subStrokes;
}
