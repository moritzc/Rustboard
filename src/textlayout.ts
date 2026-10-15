import type { FontKey } from './types';

export const FONTS: Record<FontKey, string> = {
  sans: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  hand: "'Segoe Print', 'Comic Sans MS', cursive",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "Consolas, 'Courier New', monospace",
};
/** Single family name used for SVG/PDF export (resolved by fontdb in Rust). */
export const SVG_FONTS: Record<FontKey, string> = {
  sans: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  hand: "'Segoe Print', cursive",
  serif: 'Georgia, serif',
  mono: 'Consolas, monospace',
};

export const LINE_HEIGHT = 1.3;
/** baseline of line i = top + i*lineHeight + BASELINE*size */
export const BASELINE = 1.0;

export interface TextLayout {
  lines: string[];
  lineHeight: number;
  height: number;
}

const mctx = document.createElement('canvas').getContext('2d')!;
const cache = new Map<string, TextLayout>();

export function layoutText(
  text: string,
  font: FontKey,
  size: number,
  maxWidth: number,
  bold = false,
  italic = false,
): TextLayout {
  const key = `${font}|${size}|${Math.round(maxWidth)}|${bold}|${italic}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (cache.size > 3000) cache.clear();
  const weight = bold ? 'bold ' : '';
  const style = italic ? 'italic ' : '';
  mctx.font = `${style}${weight}${size}px ${FONTS[font]}`;
  const lines: string[] = [];
  const w = (s: string) => mctx.measureText(s).width;
  for (const para of text.split('\n')) {
    const tokens = para.split(/(\s+)/);
    let line = '';
    for (const tok of tokens) {
      if (!tok) continue;
      const cand = line + tok;
      if (w(cand) <= maxWidth || line === '') {
        if (line === '' && w(tok) > maxWidth && !/^\s+$/.test(tok)) {
          // break very long word
          let part = '';
          for (const ch of tok) {
            if (w(part + ch) > maxWidth && part) {
              lines.push(part);
              part = ch;
            } else part += ch;
          }
          line = part;
        } else line = cand;
      } else {
        lines.push(line.trimEnd());
        line = /^\s+$/.test(tok) ? '' : tok;
        if (w(line) > maxWidth) {
          let part = '';
          for (const ch of line) {
            if (w(part + ch) > maxWidth && part) {
              lines.push(part);
              part = ch;
            } else part += ch;
          }
          line = part;
        }
      }
    }
    lines.push(line.trimEnd());
  }
  const lh = size * LINE_HEIGHT;
  const res = { lines, lineHeight: lh, height: Math.max(1, lines.length) * lh };
  cache.set(key, res);
  return res;
}

export function measureWidth(text: string, font: FontKey, size: number) {
  mctx.font = `${size}px ${FONTS[font]}`;
  return Math.max(...text.split('\n').map((l) => mctx.measureText(l).width), 10);
}
