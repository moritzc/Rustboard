import { getStroke } from 'perfect-freehand';
import type { InkingSmoothing, StrokeObj } from './types';

export interface InkStyle {
  size: number;
  highlighter?: boolean;
  sim?: boolean;
  smoothingMode?: InkingSmoothing;
}

interface SmoothingConfig {
  pen: { smoothing: number; streamline: number; thinning: number };
  mouse: { smoothing: number; streamline: number; thinning: number };
  hlPen: { smoothing: number; streamline: number };
  hlMouse: { smoothing: number; streamline: number };
}

const SMOOTHING_PROFILES: Record<InkingSmoothing, SmoothingConfig> = {
  raw: {
    // Precision / Direct (Zero string-pull lag, crisp fine lettering at any zoom)
    pen: { smoothing: 0.2, streamline: 0.0, thinning: 0.2 },
    mouse: { smoothing: 0.35, streamline: 0.1, thinning: 0.25 },
    hlPen: { smoothing: 0.2, streamline: 0.02 },
    hlMouse: { smoothing: 0.4, streamline: 0.12 },
  },
  balanced: {
    // Natural Handwriting (Clean letter loops, minimal lag, controlled pressure variation)
    pen: { smoothing: 0.35, streamline: 0.08, thinning: 0.3 },
    mouse: { smoothing: 0.5, streamline: 0.22, thinning: 0.3 },
    hlPen: { smoothing: 0.32, streamline: 0.08 },
    hlMouse: { smoothing: 0.55, streamline: 0.24 },
  },
  smooth: {
    // Stabilized / Calligraphy (Smooth curves, jitter stabilization, expressive line weight)
    pen: { smoothing: 0.56, streamline: 0.28, thinning: 0.45 },
    mouse: { smoothing: 0.68, streamline: 0.42, thinning: 0.35 },
    hlPen: { smoothing: 0.48, streamline: 0.2 },
    hlMouse: { smoothing: 0.68, streamline: 0.4 },
  },
};

export function strokeOutline(pts: number[], st: InkStyle, last = true): number[][] {
  const input: number[][] = [];
  for (let i = 0; i < pts.length; i += 3) {
    input.push([pts[i], pts[i + 1], pts[i + 2]]);
  }

  if (input.length === 0) return [];

  // Single point tap: generate a round dot
  if (input.length === 1) {
    const [x, y, p] = input[0];
    const r = Math.max(0.5, (st.size * (st.highlighter ? 1 : 0.35 + (p || 0.5) * 0.65)) / 2);
    const dot: number[][] = [];
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      dot.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
    }
    return dot;
  }

  // Compute average point step so fine handwriting at high zoom (500%+)
  // isn't collapsed by perfect-freehand's size-proportional smoothing window.
  let totalDist = 0;
  const sampleCount = Math.min(input.length - 1, 32);
  for (let i = 0; i < sampleCount; i++) {
    totalDist += Math.hypot(input[i + 1][0] - input[i][0], input[i + 1][1] - input[i][1]);
  }
  const avgStep = sampleCount > 0 ? totalDist / sampleCount : st.size;
  // When writing fine letters relative to stroke size (e.g. high zoom), scale down smoothing & streamline
  const detailRatio = Math.min(1, Math.max(0.32, (avgStep * 2.2) / Math.max(0.5, st.size)));

  const mode: InkingSmoothing = st.smoothingMode || 'balanced';
  const profile = SMOOTHING_PROFILES[mode] || SMOOTHING_PROFILES.balanced;

  if (st.highlighter) {
    const hlCfg = st.sim ? profile.hlMouse : profile.hlPen;
    return getStroke(input, {
      size: st.size,
      thinning: 0,
      smoothing: hlCfg.smoothing * detailRatio,
      streamline: hlCfg.streamline * detailRatio,
      simulatePressure: false,
      last,
    });
  }

  const penCfg = st.sim ? profile.mouse : profile.pen;
  return getStroke(input, {
    size: st.size,
    thinning: penCfg.thinning,
    smoothing: penCfg.smoothing * detailRatio,
    streamline: penCfg.streamline * detailRatio,
    simulatePressure: !!st.sim,
    easing: (t) => t * (2 - t),
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
  smoothingMode: InkingSmoothing;
  last: boolean;
  outline: number[][];
  path: Path2D;
}

const cache = new WeakMap<StrokeObj, CacheEntry>();

export function strokeGeometry(s: StrokeObj, smoothingMode: InkingSmoothing = 'balanced', last = true) {
  let g = cache.get(s);
  if (!g || g.ptsLen !== s.pts.length || g.size !== s.size || g.smoothingMode !== smoothingMode || g.last !== last) {
    const outline = strokeOutline(s.pts, { ...s, smoothingMode }, last);
    g = { ptsLen: s.pts.length, size: s.size, smoothingMode, last, outline, path: outlinePath(outline) };
    cache.set(s, g);
  }
  return g;
}

export function translateStrokeCache(oldStroke: StrokeObj, newStroke: StrokeObj, dx: number, dy: number) {
  const g = cache.get(oldStroke);
  if (!g || g.ptsLen !== newStroke.pts.length || g.size !== newStroke.size) return;
  const path = new Path2D();
  path.addPath(g.path, new DOMMatrix([1, 0, 0, 1, dx, dy]));
  const outline = g.outline.map((pt) => [pt[0] + dx, pt[1] + dy]);
  cache.set(newStroke, {
    ptsLen: newStroke.pts.length,
    size: newStroke.size,
    smoothingMode: g.smoothingMode,
    last: g.last,
    outline,
    path,
  });
}

export function rotateStrokeCache(oldStroke: StrokeObj, newStroke: StrokeObj, cx: number, cy: number, dAngle: number) {
  const g = cache.get(oldStroke);
  if (!g || g.ptsLen !== newStroke.pts.length || g.size !== newStroke.size) return;
  const cos = Math.cos(dAngle);
  const sin = Math.sin(dAngle);
  const tx = cx - cx * cos + cy * sin;
  const ty = cy - cx * sin - cy * cos;
  const path = new Path2D();
  path.addPath(g.path, new DOMMatrix([cos, sin, -sin, cos, tx, ty]));
  const outline = g.outline.map((pt) => [
    pt[0] * cos - pt[1] * sin + tx,
    pt[0] * sin + pt[1] * cos + ty,
  ]);
  cache.set(newStroke, {
    ptsLen: newStroke.pts.length,
    size: newStroke.size,
    smoothingMode: g.smoothingMode,
    last: g.last,
    outline,
    path,
  });
}
