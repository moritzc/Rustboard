import { dist, distToSeg, rdp } from './geom';
import type { ShapeKind, ShapeObj } from './types';
import { uid } from './types';

export interface RecognizedShape {
  kind: ShapeKind;
  pts?: number[];
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

/**
 * Recognizes if a stroke outline / polyline resembles:
 * - Line
 * - Arrow
 * - Rectangle / Square
 * - Ellipse / Circle
 * - Triangle
 */
export function recognizeShape(rawPts: number[], isArrowHint = false): RecognizedShape | null {
  // rawPts are [x, y, pressure, x, y, pressure...]
  const pts: [number, number][] = [];
  for (let i = 0; i < rawPts.length; i += 3) {
    pts.push([rawPts[i], rawPts[i + 1]]);
  }
  if (pts.length < 5) return null;

  const totalLen = calcPathLength(pts);
  if (totalLen < 20) return null;

  const startPt = pts[0];
  const endPt = pts[pts.length - 1];
  const endDist = dist(startPt[0], startPt[1], endPt[0], endPt[1]);
  const isClosed = endDist / totalLen < 0.22;

  // Check for Line or Arrow first
  const chordLen = dist(startPt[0], startPt[1], endPt[0], endPt[1]);
  if (!isClosed && chordLen / totalLen > 0.88) {
    // Very straight line or arrow
    const maxDev = maxDeviationFromLine(pts, startPt, endPt);
    if (maxDev < 0.15 * chordLen || maxDev < 15) {
      return {
        kind: isArrowHint ? 'arrow' : 'line',
        pts: [startPt[0], startPt[1], endPt[0], endPt[1]],
        x: Math.min(startPt[0], endPt[0]),
        y: Math.min(startPt[1], endPt[1]),
        w: Math.abs(endPt[0] - startPt[0]),
        h: Math.abs(endPt[1] - startPt[1]),
        rot: 0,
      };
    }
  }

  // Simplified polyline
  const eps = Math.max(8, totalLen * 0.035);
  const simp = rdp(pts, eps);

  if (isClosed) {
    // Check if it's a circle or ellipse
    const center = calcCentroid(pts);
    const radii: number[] = [];
    let avgR = 0;
    for (const p of pts) {
      const r = dist(center[0], center[1], p[0], p[1]);
      radii.push(r);
      avgR += r;
    }
    avgR /= radii.length;

    let varR = 0;
    for (const r of radii) {
      varR += Math.abs(r - avgR);
    }
    const rVariance = varR / radii.length;

    // Circle condition
    if (rVariance / avgR < 0.18) {
      const radius = avgR;
      return {
        kind: 'ellipse',
        x: center[0] - radius,
        y: center[1] - radius,
        w: radius * 2,
        h: radius * 2,
        rot: 0,
      };
    }

    // Check triangle (3 vertices)
    const closedCorners = simp.length - 1;
    if (closedCorners === 3) {
      return {
        kind: 'triangle',
        x: Math.min(simp[0][0], simp[1][0], simp[2][0]),
        y: Math.min(simp[0][1], simp[1][1], simp[2][1]),
        w: Math.max(simp[0][0], simp[1][0], simp[2][0]) - Math.min(simp[0][0], simp[1][0], simp[2][0]),
        h: Math.max(simp[0][1], simp[1][1], simp[2][1]) - Math.min(simp[0][1], simp[1][1], simp[2][1]),
        rot: 0,
      };
    }

    // Check rectangle (4 vertices)
    if (closedCorners === 4 || closedCorners === 5) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (p[0] < minX) minX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] > maxY) maxY = p[1];
      }
      return {
        kind: 'rect',
        x: minX,
        y: minY,
        w: maxX - minX,
        h: maxY - minY,
        rot: 0,
      };
    }

    // General ellipse fallback if closed
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
    return {
      kind: 'ellipse',
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
      rot: 0,
    };
  }

  return null;
}

function calcPathLength(pts: [number, number][]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  }
  return len;
}

function maxDeviationFromLine(pts: [number, number][], a: [number, number], b: [number, number]): number {
  let maxD = 0;
  for (const p of pts) {
    const d = distToSeg(p[0], p[1], a[0], a[1], b[0], b[1]);
    if (d > maxD) maxD = d;
  }
  return maxD;
}

function calcCentroid(pts: [number, number][]): [number, number] {
  let cx = 0, cy = 0;
  for (const p of pts) {
    cx += p[0];
    cy += p[1];
  }
  return [cx / pts.length, cy / pts.length];
}
