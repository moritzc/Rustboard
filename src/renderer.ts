import type { Assets } from './assets';
import type { EraserState } from './eraser';
import { bboxIntersects, type BBox } from './geom';
import { strokeGeometry } from './ink';
import type { Minimap } from './minimap';
import {
  arrowWings, bboxOf, frameLabelBox, handlePositions, ROT_HANDLE_OFFSET, selectionFrame, shapeArrows, shapeDash,
} from './objects';
import type { RadialMenu } from './radial_menu';
import type { Ruler } from './ruler';
import { FONTS, layoutText } from './textlayout';
import type { BoardSettings, Box, Camera, FrameObj, ImageObj, InkingSmoothing, Obj, PdfPageObj, ShapeObj, StickyObj, StrokeObj, TextObj } from './types';
import { PT } from './types';

export interface LaserPoint {
  x: number;
  y: number;
  time: number;
  color: string;
}

export class Renderer {
  laserPoints: LaserPoint[] = [];
  private sceneCanvas: HTMLCanvasElement | null = null;
  private sceneCtx: CanvasRenderingContext2D | null = null;
  private sceneCacheKey = '';
  private cachedCamX = 0;
  private cachedCamY = 0;
  private cachedPadX = 0;
  private cachedPadY = 0;
  private lastMainStateKey = '';
  private prevOverlayDirty: BBox | null = null;

  invalidateCache() {
    this.sceneCacheKey = '';
    this.lastMainStateKey = '';
  }

  addLaser(x: number, y: number, color = '#ff1744') {
    this.laserPoints.push({ x, y, time: performance.now(), color });
  }

  pruneLaser() {
    const now = performance.now();
    this.laserPoints = this.laserPoints.filter((p) => now - p.time < 1200);
  }

  render(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    objects: Obj[],
    selectedIds: Set<string>,
    settings: BoardSettings,
    assets: Assets,
    ruler: Ruler,
    radial: RadialMenu,
    minimap: Minimap,
    activeDraft?: Obj | null,
    lassoPoly?: number[] | null,
    eraserState?: EraserState | null,
    activeSelectionBox?: Box | null,
    sceneVersion?: number,
    assetsVersion?: number,
    activeTransformIds?: Set<string> | null,
    transformSessionId?: number,
    overlayCtx?: CanvasRenderingContext2D,
  ) {
    const cssW = window.innerWidth || 1;
    const cssH = window.innerHeight || 1;
    const canvasW = ctx.canvas.width;
    const dpr = canvasW / cssW;

    // Overscan padding in CSS pixels so camera panning/wiggling reuses the cached bitmap
    const overscanRatio = settings.screenShareMode ? 0.15 : 0.4;
    const padX = Math.round(cssW * overscanRatio);
    const padY = Math.round(cssH * overscanRatio);
    const bufCssW = cssW + padX * 2;
    const bufCssH = cssH + padY * 2;
    const bufW = Math.round(bufCssW * dpr);
    const bufH = Math.round(bufCssH * dpr);

    const sVer = sceneVersion ?? 0;
    const aVer = assetsVersion ?? 0;
    const smoothingMode = settings.smoothing || 'balanced';
    const hasActiveTransform = !!(activeTransformIds && activeTransformIds.size > 0);
    const versionTag = hasActiveTransform ? `tx${transformSessionId ?? 0}` : `sv${sVer}`;
    const baseCacheKey = `${bufW}x${bufH}_${camera.zoom.toFixed(4)}_${settings.dark}_${smoothingMode}_${versionTag}_av${aVer}`;

    const withinOverscan =
      Math.abs(camera.x - this.cachedCamX) <= this.cachedPadX &&
      Math.abs(camera.y - this.cachedCamY) <= this.cachedPadY;

    const canUseCache =
      this.sceneCacheKey === baseCacheKey &&
      this.sceneCanvas !== null &&
      withinOverscan;

    if (!canUseCache) {
      if (!this.sceneCanvas) {
        this.sceneCanvas = document.createElement('canvas');
      }
      if (this.sceneCanvas.width !== bufW || this.sceneCanvas.height !== bufH) {
        this.sceneCanvas.width = bufW;
        this.sceneCanvas.height = bufH;
        this.sceneCtx = this.sceneCanvas.getContext('2d');
      }
      if (!this.sceneCtx) {
        this.sceneCtx = this.sceneCanvas.getContext('2d');
      }

      const sCtx = this.sceneCtx!;
      sCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sCtx.clearRect(0, 0, bufCssW, bufCssH);

      sCtx.save();
      sCtx.translate(camera.x + padX, camera.y + padY);
      sCtx.scale(camera.zoom, camera.zoom);

      // Visible viewport in world coordinates (including overscan margin)
      const vLeft = (-camera.x - padX) / camera.zoom;
      const vTop = (-camera.y - padY) / camera.zoom;
      const vRight = (cssW + padX - camera.x) / camera.zoom;
      const vBottom = (cssH + padY - camera.y) / camera.zoom;
      const viewBBox: BBox = [vLeft - 80, vTop - 80, vRight + 80, vBottom + 80];

      this.renderLayerObjects(
        sCtx,
        objects,
        viewBBox,
        camera.zoom,
        settings.dark,
        assets,
        smoothingMode,
        hasActiveTransform ? activeTransformIds! : null,
        false,
      );

      sCtx.restore();
      this.sceneCacheKey = baseCacheKey;
      this.cachedCamX = camera.x;
      this.cachedCamY = camera.y;
      this.cachedPadX = padX;
      this.cachedPadY = padY;
    }

    const useSplitOverlay = !!(settings.screenShareMode && overlayCtx);
    const mainStateKey = `${baseCacheKey}_${camera.x.toFixed(2)}_${camera.y.toFixed(2)}_${settings.pattern}`;

    if (!useSplitOverlay || this.lastMainStateKey !== mainStateKey) {
      // 1. Render background directly to screen
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.renderBackground(ctx, camera, settings, cssW, cssH);

      // 2. Blit the pre-rendered overscan scene buffer at the current camera offset
      const shiftX = camera.x - this.cachedCamX - this.cachedPadX;
      const shiftY = camera.y - this.cachedCamY - this.cachedPadY;
      ctx.drawImage(this.sceneCanvas!, shiftX, shiftY, bufCssW, bufCssH);
      this.lastMainStateKey = useSplitOverlay ? mainStateKey : '';
    }

    if (!useSplitOverlay && this.prevOverlayDirty && overlayCtx) {
      overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      overlayCtx.clearRect(0, 0, cssW, cssH);
      this.prevOverlayDirty = null;
    }

    const targetCtx = useSplitOverlay ? overlayCtx! : ctx;
    let curOverlayDirty: BBox | null = null;

    if (useSplitOverlay) {
      curOverlayDirty = this.computeOverlayDirtyBBox(
        cssW,
        cssH,
        camera,
        hasActiveTransform,
        activeDraft,
        selectedIds,
        lassoPoly,
        eraserState,
        ruler,
        radial,
        minimap,
      );

      targetCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const clearBox = this.unionBBox(this.prevOverlayDirty, curOverlayDirty);
      if (clearBox) {
        targetCtx.clearRect(
          clearBox[0],
          clearBox[1],
          clearBox[2] - clearBox[0],
          clearBox[3] - clearBox[1],
        );
      }
      this.prevOverlayDirty = curOverlayDirty;
      if (!curOverlayDirty) {
        return;
      }
      targetCtx.save();
      targetCtx.beginPath();
      targetCtx.rect(
        curOverlayDirty[0],
        curOverlayDirty[1],
        curOverlayDirty[2] - curOverlayDirty[0],
        curOverlayDirty[3] - curOverlayDirty[1],
      );
      targetCtx.clip();
    }

    // 3. Render dynamic overlays with camera transform
    targetCtx.save();
    targetCtx.translate(camera.x, camera.y);
    targetCtx.scale(camera.zoom, camera.zoom);

    // 3a. Actively moving / rotating / resizing selection objects
    if (hasActiveTransform) {
      const vLeft = -camera.x / camera.zoom;
      const vTop = -camera.y / camera.zoom;
      const vRight = (cssW - camera.x) / camera.zoom;
      const vBottom = (cssH - camera.y) / camera.zoom;
      const screenBBox: BBox = [vLeft - 80, vTop - 80, vRight + 80, vBottom + 80];
      this.renderLayerObjects(
        targetCtx,
        objects,
        screenBBox,
        camera.zoom,
        settings.dark,
        assets,
        smoothingMode,
        activeTransformIds!,
        true,
      );
    }

    // 2f. Active interactive draft (in-progress stroke, shape, or frame)
    if (activeDraft) {
      if (activeDraft.type === 'frame') {
        this.renderFrame(targetCtx, activeDraft, camera.zoom, settings.dark, true);
      } else if (activeDraft.type === 'stroke' && activeDraft.highlighter) {
        targetCtx.save();
        targetCtx.globalAlpha = 0.45;
        this.renderStroke(targetCtx, activeDraft, smoothingMode);
        targetCtx.restore();
      } else {
        this.renderObject(targetCtx, activeDraft, assets, camera.zoom, smoothingMode);
      }
    }

    // 2g. Laser pointer / fading ink trails
    this.renderLaser(targetCtx);

    // 2h. Selection indicators & bounding box
    if (selectedIds.size > 0) {
      this.renderSelection(targetCtx, objects, selectedIds, camera.zoom, activeSelectionBox);
    }

    // 2i. Lasso outline
    if (lassoPoly && lassoPoly.length >= 4) {
      targetCtx.save();
      targetCtx.strokeStyle = '#2b6cb0';
      targetCtx.lineWidth = 1.5 / camera.zoom;
      targetCtx.setLineDash([4 / camera.zoom, 4 / camera.zoom]);
      targetCtx.fillStyle = 'rgba(43, 108, 176, 0.08)';
      targetCtx.beginPath();
      targetCtx.moveTo(lassoPoly[0], lassoPoly[1]);
      for (let i = 2; i < lassoPoly.length; i += 2) {
        targetCtx.lineTo(lassoPoly[i], lassoPoly[i + 1]);
      }
      targetCtx.closePath();
      targetCtx.fill();
      targetCtx.stroke();
      targetCtx.restore();
    }

    // 2j. Eraser circle cursor with velocity-adaptive radius
    if (eraserState && eraserState.active) {
      targetCtx.save();
      const strokeColor = settings.dark ? 'rgba(255, 255, 255, 0.8)' : 'rgba(71, 85, 105, 0.85)';
      const fillColor = settings.dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(203, 213, 225, 0.35)';
      targetCtx.strokeStyle = strokeColor;
      targetCtx.fillStyle = fillColor;
      targetCtx.lineWidth = 1.8 / camera.zoom;
      targetCtx.setLineDash([5 / camera.zoom, 4 / camera.zoom]);
      targetCtx.beginPath();
      targetCtx.arc(eraserState.x, eraserState.y, eraserState.radius, 0, Math.PI * 2);
      targetCtx.fill();
      targetCtx.stroke();

      // Center dot
      targetCtx.setLineDash([]);
      targetCtx.fillStyle = strokeColor;
      targetCtx.beginPath();
      targetCtx.arc(eraserState.x, eraserState.y, 2 / camera.zoom, 0, Math.PI * 2);
      targetCtx.fill();
      targetCtx.restore();
    }

    targetCtx.restore(); // Exit camera world transform

    // 3. Screen overlays (Ruler, Radial menu, Minimap)
    ruler.render(targetCtx);
    radial.render(targetCtx);
    minimap.render(targetCtx, camera, objects, cssW, cssH, settings.dark, assets, sVer, settings.dockPosition || 'bottom');

    if (useSplitOverlay) {
      targetCtx.restore(); // Exit dirty rect clip
    }
  }

  private unionBBox(a: BBox | null, b: BBox | null): BBox | null {
    if (!a) return b;
    if (!b) return a;
    return [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[2], b[2]),
      Math.max(a[3], b[3]),
    ];
  }

  private computeOverlayDirtyBBox(
    cssW: number,
    cssH: number,
    camera: Camera,
    hasActiveTransform: boolean,
    activeDraft: Obj | null | undefined,
    selectedIds: Set<string>,
    lassoPoly: number[] | null | undefined,
    eraserState: EraserState | null | undefined,
    ruler: Ruler,
    radial: RadialMenu,
    minimap: Minimap,
  ): BBox | null {
    if (hasActiveTransform || selectedIds.size > 0 || ruler.state.enabled || radial.visible) {
      return [0, 0, cssW, cssH];
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const addScreenRect = (x0: number, y0: number, x1: number, y1: number) => {
      if (x0 < minX) minX = x0;
      if (y0 < minY) minY = y0;
      if (x1 > maxX) maxX = x1;
      if (y1 > maxY) maxY = y1;
    };

    if (activeDraft) {
      const b = bboxOf(activeDraft);
      const pad = 42;
      addScreenRect(
        b[0] * camera.zoom + camera.x - pad,
        b[1] * camera.zoom + camera.y - pad,
        b[2] * camera.zoom + camera.x + pad,
        b[3] * camera.zoom + camera.y + pad,
      );
    }

    if (this.laserPoints.length > 0) {
      for (const lp of this.laserPoints) {
        const sx = lp.x * camera.zoom + camera.x;
        const sy = lp.y * camera.zoom + camera.y;
        addScreenRect(sx - 24, sy - 24, sx + 24, sy + 24);
      }
    }

    if (lassoPoly && lassoPoly.length >= 4) {
      for (let i = 0; i < lassoPoly.length; i += 2) {
        const sx = lassoPoly[i] * camera.zoom + camera.x;
        const sy = lassoPoly[i + 1] * camera.zoom + camera.y;
        addScreenRect(sx - 12, sy - 12, sx + 12, sy + 12);
      }
    }

    if (eraserState && eraserState.active) {
      const sx = eraserState.x * camera.zoom + camera.x;
      const sy = eraserState.y * camera.zoom + camera.y;
      const sr = eraserState.radius * camera.zoom + 12;
      addScreenRect(sx - sr, sy - sr, sx + sr, sy + sr);
    }

    if (minimap.visible) {
      addScreenRect(0, cssH - 250, cssW, cssH);
    }

    if (!isFinite(minX)) return null;

    return [
      Math.max(0, Math.floor(minX)),
      Math.max(0, Math.floor(minY)),
      Math.min(cssW, Math.ceil(maxX)),
      Math.min(cssH, Math.ceil(maxY)),
    ];
  }

  private renderLayerObjects(
    sCtx: CanvasRenderingContext2D,
    objects: Obj[],
    viewBBox: BBox,
    zoom: number,
    dark: boolean,
    assets: Assets,
    smoothingMode: InkingSmoothing,
    filterIds: Set<string> | null,
    includeMatching: boolean,
  ) {
    const frames: FrameObj[] = [];
    const pdfPages: PdfPageObj[] = [];
    const images: ImageObj[] = [];
    const highlighters: StrokeObj[] = [];
    const others: Obj[] = [];

    for (const o of objects) {
      if (filterIds) {
        const has = filterIds.has(o.id);
        if (includeMatching ? !has : has) continue;
      }
      if (!bboxIntersects(bboxOf(o), viewBBox)) continue;
      if (o.type === 'frame') frames.push(o);
      else if (o.type === 'pdfpage') pdfPages.push(o);
      else if (o.type === 'image') images.push(o);
      else if (o.type === 'stroke' && o.highlighter) highlighters.push(o);
      else others.push(o);
    }

    for (const f of frames) this.renderFrame(sCtx, f, zoom, dark);
    for (const p of pdfPages) this.renderPdfPage(sCtx, p, assets, zoom);
    for (const im of images) this.renderImage(sCtx, im, assets);

    if (highlighters.length > 0) {
      sCtx.save();
      sCtx.globalAlpha = 0.42;
      for (const hl of highlighters) this.renderStroke(sCtx, hl, smoothingMode);
      sCtx.restore();
    }

    for (const o of others) {
      this.renderObject(sCtx, o, assets, zoom, smoothingMode);
    }
  }

  private renderBackground(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    settings: BoardSettings,
    w: number,
    h: number,
  ) {
    const bg = settings.dark ? '#1a202c' : '#ffffff';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    if (settings.pattern === 'none') return;

    const baseSpacing = 28;
    const spacing = baseSpacing * cam.zoom;
    if (spacing < 10) return; // Too dense to render

    const offsetX = ((cam.x % spacing) + spacing) % spacing;
    const offsetY = ((cam.y % spacing) + spacing) % spacing;

    ctx.save();
    const patternColor = settings.dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.12)';
    ctx.strokeStyle = patternColor;
    ctx.fillStyle = patternColor;

    if (settings.pattern === 'dots') {
      const r = Math.max(1, 1.2 * Math.min(2, cam.zoom));
      if (r <= 1.6) {
        // Fast GPU quad batching instead of thousands of bezier arc() subpaths
        const d = r * 1.85;
        for (let y = offsetY; y < h; y += spacing) {
          const py = y - r * 0.92;
          for (let x = offsetX; x < w; x += spacing) {
            ctx.fillRect(x - r * 0.92, py, d, d);
          }
        }
      } else {
        // Flush path per row when zoomed in so path tessellator stays tiny
        for (let y = offsetY; y < h; y += spacing) {
          ctx.beginPath();
          for (let x = offsetX; x < w; x += spacing) {
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, Math.PI * 2);
          }
          ctx.fill();
        }
      }
    } else if (settings.pattern === 'grid') {
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = offsetX; x < w; x += spacing) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let y = offsetY; y < h; y += spacing) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();
    } else if (settings.pattern === 'lines') {
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let y = offsetY; y < h; y += spacing) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private renderFrame(ctx: CanvasRenderingContext2D, f: FrameObj, zoom: number, dark: boolean, isPreview = false) {
    ctx.save();
    // Frame boundary
    ctx.fillStyle = isPreview
      ? 'rgba(49, 130, 206, 0.12)'
      : dark ? 'rgba(30, 41, 59, 0.45)' : 'rgba(248, 250, 252, 0.7)';
    ctx.strokeStyle = isPreview ? '#3182ce' : (dark ? '#475569' : '#cbd5e1');
    ctx.lineWidth = (isPreview ? 2.5 : 2) / zoom;
    ctx.setLineDash(isPreview ? [8 / zoom, 5 / zoom] : [6 / zoom, 4 / zoom]);
    ctx.strokeRect(f.x, f.y, f.w, f.h);
    ctx.fillRect(f.x, f.y, f.w, f.h);
    ctx.setLineDash([]);

    // Frame title pill on top
    const lBox = frameLabelBox(f, zoom);
    ctx.fillStyle = '#3182ce';
    ctx.beginPath();
    ctx.roundRect(lBox.x, lBox.y, lBox.w, lBox.h, 4 / zoom);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${12 / zoom}px -apple-system, Segoe UI, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(f.name || 'Frame', lBox.x + 6 / zoom, lBox.y + lBox.h / 2);
    ctx.restore();
  }

  private renderPdfPage(ctx: CanvasRenderingContext2D, p: PdfPageObj, assets: Assets, zoom: number) {
    ctx.save();
    ctx.translate(p.x, p.y);
    if (p.rot) {
      ctx.translate(p.w / 2, p.h / 2);
      ctx.rotate(p.rot);
      ctx.translate(-p.w / 2, -p.h / 2);
    }

    // Fast crisp layered shadow (avoids expensive per-frame Gaussian shadowBlur)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.09)';
    ctx.fillRect(3 / zoom, 4 / zoom, p.w, p.h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, p.w, p.h);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(0, 0, p.w, p.h);

    const wantScale = Math.max(1, zoom * (p.w / (p.pw * PT)));
    const entry = assets.pageBitmap(p.asset, p.page, wantScale);
    if (entry && entry.canvas.width > 0) {
      ctx.drawImage(entry.canvas, 0, 0, p.w, p.h);
    } else {
      ctx.fillStyle = '#f7fafc';
      ctx.fillRect(0, 0, p.w, p.h);
      ctx.fillStyle = '#718096';
      ctx.font = '14px -apple-system, Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`Loading Page ${p.page + 1}...`, p.w / 2, p.h / 2);
    }
    ctx.restore();
  }

  private renderImage(ctx: CanvasRenderingContext2D, im: ImageObj, assets: Assets) {
    ctx.save();
    ctx.translate(im.x + im.w / 2, im.y + im.h / 2);
    if (im.rot) ctx.rotate(im.rot);
    ctx.translate(-im.w / 2, -im.h / 2);

    const img = assets.image(im.asset);
    if (img) {
      if (im.crop) {
        const nw = 'naturalWidth' in img ? img.naturalWidth : img.width;
        const nh = 'naturalHeight' in img ? img.naturalHeight : img.height;
        const sx = im.crop.x * nw;
        const sy = im.crop.y * nh;
        const sw = im.crop.w * nw;
        const sh = im.crop.h * nh;
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, im.w, im.h);
      } else {
        ctx.drawImage(img, 0, 0, im.w, im.h);
      }
    } else {
      ctx.fillStyle = '#edf2f7';
      ctx.fillRect(0, 0, im.w, im.h);
      ctx.strokeStyle = '#cbd5e0';
      ctx.strokeRect(0, 0, im.w, im.h);
    }
    ctx.restore();
  }

  private renderObject(ctx: CanvasRenderingContext2D, o: Obj, assets: Assets, zoom: number, smoothingMode?: InkingSmoothing) {
    switch (o.type) {
      case 'stroke':
        this.renderStroke(ctx, o, smoothingMode);
        break;
      case 'shape':
        this.renderShape(ctx, o);
        break;
      case 'sticky':
        this.renderSticky(ctx, o);
        break;
      case 'text':
        this.renderText(ctx, o);
        break;
    }
  }

  private renderStroke(ctx: CanvasRenderingContext2D, s: StrokeObj, smoothingMode?: InkingSmoothing) {
    const g = strokeGeometry(s, smoothingMode);
    ctx.fillStyle = s.color;
    ctx.fill(g.path);
  }

  private renderShape(ctx: CanvasRenderingContext2D, sh: ShapeObj) {
    ctx.save();
    ctx.strokeStyle = sh.color;
    ctx.lineWidth = sh.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash(shapeDash(sh));

    if (sh.kind === 'line' || sh.kind === 'arrow') {
      const [x1, y1, x2, y2] = sh.pts!;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      // Arrowheads are always drawn solid
      ctx.setLineDash([]);
      const arrows = shapeArrows(sh);
      const head = (fx: number, fy: number, tx: number, ty: number) => {
        const wg = arrowWings(fx, fy, tx, ty, sh.width);
        ctx.beginPath();
        ctx.moveTo(wg[0], wg[1]);
        ctx.lineTo(tx, ty);
        ctx.lineTo(wg[2], wg[3]);
        ctx.stroke();
      };
      if (arrows.end) head(x1, y1, x2, y2);
      if (arrows.start) head(x2, y2, x1, y1);
      ctx.restore();
      return;
    }

    // Boxed shapes
    ctx.translate(sh.x + sh.w / 2, sh.y + sh.h / 2);
    if (sh.rot) ctx.rotate(sh.rot);
    ctx.translate(-sh.w / 2, -sh.h / 2);

    ctx.beginPath();
    if (sh.kind === 'rect') {
      ctx.roundRect(0, 0, sh.w, sh.h, Math.min(6, sh.w / 4, sh.h / 4));
    } else if (sh.kind === 'ellipse') {
      ctx.ellipse(sh.w / 2, sh.h / 2, sh.w / 2, sh.h / 2, 0, 0, Math.PI * 2);
    } else if (sh.kind === 'triangle') {
      ctx.moveTo(sh.w / 2, 0);
      ctx.lineTo(sh.w, sh.h);
      ctx.lineTo(0, sh.h);
      ctx.closePath();
    } else if (sh.kind === 'diamond') {
      ctx.moveTo(sh.w / 2, 0);
      ctx.lineTo(sh.w, sh.h / 2);
      ctx.lineTo(sh.w / 2, sh.h);
      ctx.lineTo(0, sh.h / 2);
      ctx.closePath();
    }

    if (sh.fill) {
      ctx.fillStyle = sh.fill;
      ctx.fill();
    }
    ctx.stroke();
    ctx.restore();
  }

  private renderSticky(ctx: CanvasRenderingContext2D, st: StickyObj) {
    ctx.save();
    ctx.translate(st.x + st.w / 2, st.y + st.h / 2);
    if (st.rot) ctx.rotate(st.rot);
    ctx.translate(-st.w / 2, -st.h / 2);

    // Fast layered drop shadow (avoids expensive per-frame Gaussian shadowBlur)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.beginPath();
    ctx.roundRect(2.5, 3.5, st.w, st.h, 4);
    ctx.fill();

    ctx.fillStyle = st.color;
    ctx.beginPath();
    ctx.roundRect(0, 0, st.w, st.h, 4);
    ctx.fill();

    // Text inside sticky note
    ctx.fillStyle = '#1a202c';
    ctx.font = `${st.fontSize}px ${FONTS.hand}`;
    const padding = 14;
    const layout = layoutText(st.text || '', 'hand', st.fontSize, st.w - padding * 2);
    let ty = padding + st.fontSize * 0.9;
    for (const line of layout.lines) {
      ctx.fillText(line, padding, ty);
      ty += layout.lineHeight;
    }
    ctx.restore();
  }

  private renderText(ctx: CanvasRenderingContext2D, t: TextObj) {
    ctx.save();
    ctx.translate(t.x + t.w / 2, t.y + t.h / 2);
    if (t.rot) ctx.rotate(t.rot);
    ctx.translate(-t.w / 2, -t.h / 2);

    ctx.fillStyle = t.color;
    const weight = t.bold ? 'bold ' : '';
    const style = t.italic ? 'italic ' : '';
    ctx.font = `${style}${weight}${t.fontSize}px ${FONTS[t.font]}`;
    const layout = layoutText(t.text || '', t.font, t.fontSize, t.w, t.bold, t.italic);
    let ty = t.fontSize * 0.9;
    for (const line of layout.lines) {
      ctx.fillText(line, 0, ty);
      ty += layout.lineHeight;
    }
    ctx.restore();
  }

  private renderLaser(ctx: CanvasRenderingContext2D) {
    const now = performance.now();
    for (let i = 1; i < this.laserPoints.length; i++) {
      const p1 = this.laserPoints[i - 1];
      const p2 = this.laserPoints[i];
      const age = now - p2.time;
      if (age > 1200) continue;
      const alpha = 1 - age / 1200;

      ctx.save();
      ctx.strokeStyle = p2.color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 6 * alpha;
      ctx.lineCap = 'round';
      ctx.shadowColor = p2.color;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  private renderSelection(
    ctx: CanvasRenderingContext2D,
    objects: Obj[],
    selectedIds: Set<string>,
    zoom: number,
    customBox?: Box | null,
  ) {
    const sf = selectionFrame(objects, selectedIds);
    if (!sf) return;
    const b = customBox ?? sf.box;

    ctx.save();
    const accent = '#2563eb';

    // Main selection box
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    ctx.save();
    ctx.translate(cx, cy);
    if (b.rot) ctx.rotate(b.rot);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5 / zoom;
    if (sf.locked) ctx.setLineDash([6 / zoom, 4 / zoom]);
    ctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
    ctx.setLineDash([]);
    if (sf.canRotate && !sf.locked) {
      ctx.beginPath();
      ctx.moveTo(0, -b.h / 2);
      ctx.lineTo(0, -b.h / 2 - ROT_HANDLE_OFFSET / zoom);
      ctx.stroke();
    }
    ctx.restore();

    // Classic Anchor Point (pivot indicator at center of rotation)
    if (sf.canRotate && !sf.locked) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, 3.5 / zoom, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2 / zoom;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cx - 5.5 / zoom, cy);
      ctx.lineTo(cx + 5.5 / zoom, cy);
      ctx.moveTo(cx, cy - 5.5 / zoom);
      ctx.lineTo(cx, cy + 5.5 / zoom);
      ctx.stroke();
      ctx.restore();
    }

    if (!sf.locked) {
      for (const [h, hx, hy] of handlePositions(b, zoom, sf.canRotate)) {
        ctx.beginPath();
        if (h === 'rot') {
          ctx.arc(hx, hy, 7.5 / zoom, 0, Math.PI * 2);
          ctx.fillStyle = accent;
          ctx.fill();
          // circular arrow glyph
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.6 / zoom;
          ctx.beginPath();
          ctx.arc(hx, hy, 3.8 / zoom, -Math.PI * 0.9, Math.PI * 0.5);
          ctx.stroke();
        } else {
          const s = (h.length === 2 ? 11 : 9) / zoom;
          ctx.save();
          ctx.translate(hx, hy);
          ctx.rotate(b.rot);
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1.8 / zoom;
          ctx.beginPath();
          ctx.roundRect(-s / 2, -s / 2, s, s, 2.5 / zoom);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      }
    }
    ctx.restore();
  }
}
