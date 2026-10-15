import { getStroke } from 'perfect-freehand';
import type { StrokeObj } from './types';

export interface InkStyle {
  size: number;
  highlighter?: boolean;
  sim?: boolean;
}

export function strokeOutline(pts: number[], st: InkStyle, last = true): number[][] {
  const input: number[][] = [];
  for (let i = 0; i < pts.length; i += 3) {
    input.push([pts[i], pts[i + 1], pts[i + 2]]);
  }

  if (input.length === 0) return [];

  // Single point tap: generate a round dot
  if (input.length === 1) {
    const [x, y, p] = input[0];
    const r = Math.max(1, (st.size * (st.highlighter ? 1 : p || 0.5)) / 2);
    const dot: number[][] = [];
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      dot.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
    }
    return dot;
  }

  if (st.highlighter) {
    return getStroke(input, {
      size: st.size,
      thinning: 0,
      smoothing: 0.6,
      streamline: 0.45,
      simulatePressure: false,
      last,
    });
  }

  return getStroke(input, {
    size: st.size,
    thinning: st.sim ? 0.35 : 0.55,
    smoothing: 0.55,
    streamline: 0.28,
    simulatePressure: !!st.sim,
    easing: (t) => Math.sin((t * Math.PI) / 2),
    last,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 },
  });
}

export function outlinePath(outline: number[][]): Path2D {
  const p = new Path2D();
  const n = outline.length;
  if (n < 2) return p;
  p.moveTo(outline[0][0], outline[0][1]);
  for (let i = 0; i < n; i++) {
    const a = outline[i], b = outline[(i + 1) % n];
    p.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  p.closePath();
  return p;
}

const r = (v: number) => Math.round(v * 100) / 100;

export function outlineSvgD(outline: number[][]): string {
  const n = outline.length;
  if (n < 2) return '';
  const parts = [`M${r(outline[0][0])} ${r(outline[0][1])}`];
  for (let i = 0; i < n; i++) {
    const a = outline[i], b = outline[(i + 1) % n];
    parts.push(`Q${r(a[0])} ${r(a[1])} ${r((a[0] + b[0]) / 2)} ${r((a[1] + b[1]) / 2)}`);
  }
  parts.push('Z');
  return parts.join('');
}

interface CacheEntry {
  ptsLen: number;
  size: number;
  outline: number[][];
  path: Path2D;
}

const cache = new WeakMap<StrokeObj, CacheEntry>();

export function strokeGeometry(s: StrokeObj) {
  let g = cache.get(s);
  if (!g || g.ptsLen !== s.pts.length || g.size !== s.size) {
    const outline = strokeOutline(s.pts, s);
    g = { ptsLen: s.pts.length, size: s.size, outline, path: outlinePath(outline) };
    cache.set(s, g);
  }
  return g;
}
