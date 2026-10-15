import { invoke } from '@tauri-apps/api/core';
import type { Assets } from './assets';
import type { BBox } from './geom';
import { outlineSvgD, strokeOutline } from './ink';
import { arrowWings, bboxOf, shapeArrows, shapeDash } from './objects';
import { layoutText, SVG_FONTS } from './textlayout';
import type { FrameObj, Obj, PdfPageObj, ShapeObj, StickyObj, StrokeObj, TextObj } from './types';
import { PT } from './types';

function escapeXml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function exportToSvg(
  objects: Obj[],
  assets: Assets,
  bounds: BBox,
  dark = false,
  includeBg = true,
): string {
  const [minX, minY, maxX, maxY] = bounds;
  const w = Math.max(10, maxX - minX);
  const h = Math.max(10, maxY - minY);

  let xml = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="${minX} ${minY} ${w} ${h}">\n`;

  if (includeBg) {
    const bg = dark ? '#1a202c' : '#ffffff';
    xml += `  <rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="${bg}"/>\n`;
  }

  // Partition into highlighters and others
  const highlighters: StrokeObj[] = [];
  const normal: Obj[] = [];
  for (const o of objects) {
    if (o.type === 'frame') continue; // Frames define pages, don't draw border in export
    if (o.type === 'stroke' && o.highlighter) highlighters.push(o);
    else normal.push(o);
  }

  // Highlighters first
  if (highlighters.length > 0) {
    xml += `  <g opacity="0.45">\n`;
    for (const hl of highlighters) {
      const outline = strokeOutline(hl.pts, hl);
      const d = outlineSvgD(outline);
      if (d) xml += `    <path d="${d}" fill="${hl.color}"/>\n`;
    }
    xml += `  </g>\n`;
  }

  // Normal items
  for (const o of normal) {
    xml += objectToSvg(o, assets);
  }

  xml += `</svg>`;
  return xml;
}

function objectToSvg(o: Obj, assets: Assets): string {
  switch (o.type) {
    case 'stroke': {
      const outline = strokeOutline(o.pts, o);
      const d = outlineSvgD(outline);
      return d ? `  <path d="${d}" fill="${o.color}"/>\n` : '';
    }
    case 'shape':
      return shapeToSvg(o);
    case 'sticky':
      return stickyToSvg(o);
    case 'text':
      return textToSvg(o);
    case 'image': {
      const href = assets.dataUrl(o.asset);
      const rot = o.rot ? ` transform="rotate(${(o.rot * 180) / Math.PI} ${o.x + o.w / 2} ${o.y + o.h / 2})"` : '';
      return `  <image href="${href}" x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" preserveAspectRatio="none"${rot}/>\n`;
    }
    case 'pdfpage': {
      const entry = assets.pageBitmap(o.asset, o.page, 3);
      if (entry) {
        const href = entry.canvas.toDataURL('image/png');
        const rot = o.rot ? ` transform="rotate(${(o.rot * 180) / Math.PI} ${o.x + o.w / 2} ${o.y + o.h / 2})"` : '';
        return `  <image href="${href}" x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" preserveAspectRatio="none"${rot}/>\n`;
      }
      return '';
    }
    default:
      return '';
  }
}

function shapeToSvg(sh: ShapeObj): string {
  let s = '';
  const fill = sh.fill ? ` fill="${sh.fill}"` : ' fill="none"';
  const solid = ` stroke="${sh.color}" stroke-width="${sh.width}" stroke-linecap="round" stroke-linejoin="round"`;
  const dash = shapeDash(sh);
  const stroke = dash.length ? `${solid} stroke-dasharray="${dash.join(' ')}"` : solid;

  if (sh.kind === 'line' || sh.kind === 'arrow') {
    const [x1, y1, x2, y2] = sh.pts!;
    s += `  <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${stroke}/>\n`;
    const arrows = shapeArrows(sh);
    const head = (fx: number, fy: number, tx: number, ty: number) => {
      const w = arrowWings(fx, fy, tx, ty, sh.width);
      s += `  <polyline points="${w[0]},${w[1]} ${tx},${ty} ${w[2]},${w[3]}"${solid} fill="none"/>\n`;
    };
    if (arrows.end) head(x1, y1, x2, y2);
    if (arrows.start) head(x2, y2, x1, y1);
    return s;
  }

  const rot = sh.rot ? ` transform="rotate(${(sh.rot * 180) / Math.PI} ${sh.x + sh.w / 2} ${sh.y + sh.h / 2})"` : '';
  if (sh.kind === 'rect') {
    s += `  <rect x="${sh.x}" y="${sh.y}" width="${sh.w}" height="${sh.h}" rx="6"${fill}${stroke}${rot}/>\n`;
  } else if (sh.kind === 'ellipse') {
    s += `  <ellipse cx="${sh.x + sh.w / 2}" cy="${sh.y + sh.h / 2}" rx="${sh.w / 2}" ry="${sh.h / 2}"${fill}${stroke}${rot}/>\n`;
  } else if (sh.kind === 'triangle') {
    const pts = `${sh.x + sh.w / 2},${sh.y} ${sh.x + sh.w},${sh.y + sh.h} ${sh.x},${sh.y + sh.h}`;
    s += `  <polygon points="${pts}"${fill}${stroke}${rot}/>\n`;
  } else if (sh.kind === 'diamond') {
    const pts = `${sh.x + sh.w / 2},${sh.y} ${sh.x + sh.w},${sh.y + sh.h / 2} ${sh.x + sh.w / 2},${sh.y + sh.h} ${sh.x},${sh.y + sh.h / 2}`;
    s += `  <polygon points="${pts}"${fill}${stroke}${rot}/>\n`;
  }
  return s;
}

function stickyToSvg(st: StickyObj): string {
  const rot = st.rot ? ` transform="rotate(${(st.rot * 180) / Math.PI} ${st.x + st.w / 2} ${st.y + st.h / 2})"` : '';
  let s = `  <g${rot}>\n`;
  s += `    <rect x="${st.x}" y="${st.y}" width="${st.w}" height="${st.h}" rx="4" fill="${st.color}"/>\n`;

  const padding = 14;
  const layout = layoutText(st.text || '', 'hand', st.fontSize, st.w - padding * 2);
  let ty = st.y + padding + st.fontSize * 0.9;
  for (const line of layout.lines) {
    s += `    <text x="${st.x + padding}" y="${ty}" font-family="${SVG_FONTS.hand}" font-size="${st.fontSize}" fill="#1a202c">${escapeXml(line)}</text>\n`;
    ty += layout.lineHeight;
  }
  s += `  </g>\n`;
  return s;
}

function textToSvg(t: TextObj): string {
  const rot = t.rot ? ` transform="rotate(${(t.rot * 180) / Math.PI} ${t.x + t.w / 2} ${t.y + t.h / 2})"` : '';
  let s = `  <g${rot}>\n`;
  const layout = layoutText(t.text || '', t.font, t.fontSize, t.w, t.bold, t.italic);
  let ty = t.y + t.fontSize * 0.9;
  const boldAttr = t.bold ? ' font-weight="bold"' : '';
  const italicAttr = t.italic ? ' font-style="italic"' : '';
  for (const line of layout.lines) {
    s += `    <text x="${t.x}" y="${ty}" font-family="${SVG_FONTS[t.font]}" font-size="${t.fontSize}"${boldAttr}${italicAttr} fill="${t.color}">${escapeXml(line)}</text>\n`;
    ty += layout.lineHeight;
  }
  s += `  </g>\n`;
  return s;
}

/**
 * PDF Export: converts board (either whole board, or one page per Frame) to vector PDF.
 */
export async function exportPdf(
  objects: Obj[],
  assets: Assets,
  path: string,
  frames: FrameObj[] | null = null,
  dark = false,
) {
  interface SvgPage {
    svg: string;
    width: number;
    height: number;
  }
  const pages: SvgPage[] = [];

  if (frames && frames.length > 0) {
    // Export one PDF page per Frame
    for (const f of frames) {
      // Find objects inside or intersecting this frame
      const fBBox: BBox = [f.x, f.y, f.x + f.w, f.y + f.h];
      const pageObjs = objects.filter((o) => {
        if (o.id === f.id) return false;
        const b = bboxOf(o);
        return !(b[2] < fBBox[0] || b[0] > fBBox[2] || b[3] < fBBox[1] || b[1] > fBBox[3]);
      });
      const svg = exportToSvg(pageObjs, assets, fBBox, dark, true);
      // Convert world px to PDF points
      pages.push({
        svg,
        width: f.w / PT,
        height: f.h / PT,
      });
    }
  } else {
    // Whole board on single page
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of objects) {
      const b = bboxOf(o);
      if (b[0] < minX) minX = b[0];
      if (b[1] < minY) minY = b[1];
      if (b[2] > maxX) maxX = b[2];
      if (b[3] > maxY) maxY = b[3];
    }
    if (!isFinite(minX)) {
      minX = 0; minY = 0; maxX = 800; maxY = 600;
    }
    const pad = 40;
    const b: BBox = [minX - pad, minY - pad, maxX + pad, maxY + pad];
    const w = b[2] - b[0];
    const h = b[3] - b[1];
    const svg = exportToSvg(objects, assets, b, dark, true);
    pages.push({
      svg,
      width: w / PT,
      height: h / PT,
    });
  }

  await invoke('export_pdf', { pages, path });
}

/**
 * PDF Round-Trip (Idea #5): Stamps user annotations onto original PDF pages, keeping text vector & crisp.
 */
export async function exportAnnotatedPdfRoundTrip(
  objects: Obj[],
  assets: Assets,
  pdfAssetId: string,
  outPath: string,
) {
  const asset = assets.get(pdfAssetId);
  if (!asset) throw new Error('PDF asset not found');

  // Stage original PDF in Rust
  const blobId = await invoke<number>('stage_blob', asset.bytes);

  // Group annotations by PDF page
  const pdfPages = objects.filter((o): o is PdfPageObj => o.type === 'pdfpage' && o.asset === pdfAssetId);
  const overlays: { page: number; svg: string }[] = [];

  for (const pp of pdfPages) {
    const pageBBox: BBox = [pp.x, pp.y, pp.x + pp.w, pp.y + pp.h];
    // Find ink/annotations over this PDF page
    const pageAnnotations = objects.filter((o) => {
      if (o.type === 'pdfpage' || o.type === 'frame') return false;
      const b = bboxOf(o);
      return !(b[2] < pageBBox[0] || b[0] > pageBBox[2] || b[3] < pageBBox[1] || b[1] > pageBBox[3]);
    });

    // Generate overlay SVG with transparent background
    const svg = exportToSvg(pageAnnotations, assets, pageBBox, false, false);
    overlays.push({
      page: pp.page,
      svg,
    });
  }

  await invoke('export_annotated_pdf', {
    blob: blobId,
    overlays,
    path: outPath,
  });
}
