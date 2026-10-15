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
    // Direct / Low Latency (direct tracking, minimum latency)
    pen: { smoothing: 0.3, streamline: 0.05, thinning: 0.55 },
    mouse: { smoothing: 0.4, streamline: 0.14, thinning: 0.35 },
    hlPen: { smoothing: 0.25, streamline: 0.04 },
    hlMouse: { smoothing: 0.45, streamline: 0.15 },
  },
  balanced: {
    // Balanced (Natural handwriting & drawing, smooth curves, no perceptible lag)
    pen: { smoothing: 0.48, streamline: 0.16, thinning: 0.55 },
    mouse: { smoothing: 0.58, streamline: 0.28, thinning: 0.35 },
    hlPen: { smoothing: 0.38, streamline: 0.12 },
    hlMouse: { smoothing: 0.6, streamline: 0.3 },
  },
  smooth: {
    // High / Stabilized (Clean lettering, calm lines, jitter reduction)
    pen: { smoothing: 0.62, streamline: 0.36, thinning: 0.55 },
    mouse: { smoothing: 0.72, streamline: 0.48, thinning: 0.35 },
    hlPen: { smoothing: 0.52, streamline: 0.24 },
    hlMouse: { smoothing: 0.72, streamline: 0.45 },
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
    const r = Math.max(1, (st.size * (st.highlighter ? 1 : p || 0.5)) / 2);
    const dot: number[][] = [];
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      dot.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
    }
    return dot;
  }

  const mode: InkingSmoothing = st.smoothingMode || 'balanced';
  const profile = SMOOTHING_PROFILES[mode] || SMOOTHING_PROFILES.balanced;

  if (st.highlighter) {
    const hlCfg = st.sim ? profile.hlMouse : profile.hlPen;
    return getStroke(input, {
      size: st.size,
      thinning: 0,
      smoothing: hlCfg.smoothing,
      streamline: hlCfg.streamline,
      simulatePressure: false,
      last,
    });
  }

  const penCfg = st.sim ? profile.mouse : profile.pen;
  return getStroke(input, {
    size: st.size,
    thinning: penCfg.thinning,
    smoothing: penCfg.smoothing,
    streamline: penCfg.streamline,
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
  smoothingMode: InkingSmoothing;
  outline: number[][];
  path: Path2D;
}

const cache = new WeakMap<StrokeObj, CacheEntry>();

export function strokeGeometry(s: StrokeObj, smoothingMode: InkingSmoothing = 'balanced') {
  let g = cache.get(s);
  if (!g || g.ptsLen !== s.pts.length || g.size !== s.size || g.smoothingMode !== smoothingMode) {
    const outline = strokeOutline(s.pts, { ...s, smoothingMode });
    g = { ptsLen: s.pts.length, size: s.size, smoothingMode, outline, path: outlinePath(outline) };
    cache.set(s, g);
  }
  return g;
}
