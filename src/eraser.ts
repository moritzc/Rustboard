import { dist, distToSeg } from './geom';
import { shapeOutline } from './objects';
import type { Obj, ShapeObj, StrokeObj } from './types';
import { uid } from './types';

export interface EraserState {
  active: boolean;
  x: number; // world x
  y: number; // world y
  radius: number; // world radius
}

/**
 * Partial / Slicing Eraser: cuts out segments of strokes that intersect the eraser circle.
 * Splits affected strokes into new sub-strokes, trimming ends and deleting fully covered parts.
 */
export function eraseObjectsAt(
  objects: Obj[],
  ex: number,
  ey: number,
  radius: number,
): { remaining: Obj[]; changed: boolean } {
  let changed = false;
  const result: Obj[] = [];

  for (const obj of objects) {
    if (obj.locked || obj.type === 'frame') {
      result.push(obj);
      continue;
    }

    if (obj.type === 'stroke') {
      const sliced = sliceStroke(obj, ex, ey, radius);
      if (sliced.length !== 1 || sliced[0] !== obj) {
        changed = true;
        result.push(...sliced);
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
      const sliced = sliceStroke(surrogateStroke, ex, ey, radius);
      if (sliced.length !== 1 || sliced[0] !== surrogateStroke) {
        changed = true;
        result.push(...sliced);
      } else {
        result.push(obj);
      }
    } else {
      // Filled shapes, sticky notes, images, pdf pages, text: check hit
      let hit = false;
      if (obj.type === 'shape' && (obj.kind === 'line' || obj.kind === 'arrow')) {
        const pts = obj.pts!;
        const d = distToSeg(ex, ey, pts[0], pts[1], pts[2], pts[3]);
        if (d <= radius + (obj.width || 2) / 2) hit = true;
      } else {
        // Check box bounds
        if (
          ex >= obj.x - radius &&
          ex <= obj.x + obj.w + radius &&
          ey >= obj.y - radius &&
          ey <= obj.y + obj.h + radius
        ) {
          hit = true;
        }
      }

      if (hit) {
        changed = true; // deleted
      } else {
        result.push(obj);
      }
    }
  }

  return { remaining: result, changed };
}

/**
 * Cuts a stroke with an eraser circle.
 * Points inside distance R of (ex, ey) are excised.
 * Long segments crossing the circle are subdivided to cleanly clip at the circle boundary.
 */
export function sliceStroke(stroke: StrokeObj, ex: number, ey: number, radius: number): StrokeObj[] {
  const pts = stroke.pts;
  if (pts.length < 3) return [];

  // Quick bounding box rejection
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    if (pts[i] < minX) minX = pts[i];
    if (pts[i + 1] < minY) minY = pts[i + 1];
    if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 1] > maxY) maxY = pts[i + 1];
  }
  const strokeMargin = stroke.size / 2;
  const effR = radius + strokeMargin;

  if (
    ex + effR < minX ||
    ex - effR > maxX ||
    ey + effR < minY ||
    ey - effR > maxY
  ) {
    return [stroke]; // No collision
  }

  // Subdivide long segments so we get a smooth, clean cut edge
  const densePts: number[] = [pts[0], pts[1], pts[2]];
  const maxStep = Math.max(3, effR * 0.4);

  for (let i = 3; i < pts.length; i += 3) {
    const x0 = pts[i - 3], y0 = pts[i - 2], p0 = pts[i - 1];
    const x1 = pts[i], y1 = pts[i + 1], p1 = pts[i + 2];
    const d = dist(x0, y0, x1, y1);

    if (d > maxStep) {
      const steps = Math.ceil(d / maxStep);
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        densePts.push(
          x0 + (x1 - x0) * t,
          y0 + (y1 - y0) * t,
          p0 + (p1 - p0) * t,
        );
      }
    } else {
      densePts.push(x1, y1, p1);
    }
  }

  // Filter and split into sub-strokes
  const subStrokes: StrokeObj[] = [];
  let currentSegment: number[] = [];
  let anyCut = false;

  for (let i = 0; i < densePts.length; i += 3) {
    const px = densePts[i];
    const py = densePts[i + 1];
    const pp = densePts[i + 2];

    const d = dist(px, py, ex, ey);

    if (d > effR) {
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
