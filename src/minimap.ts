import type { Assets } from './assets';
import { bboxOf } from './objects';
import type { Camera, DockPosition, Obj } from './types';

export class Minimap {
  visible = false;
  x = 0;
  y = 0;
  w = 220;
  h = 144;

  private cacheCanvas: HTMLCanvasElement | null = null;
  private cacheCtx: CanvasRenderingContext2D | null = null;
  private cacheKey = '';

  private lastSceneVersion = -1;
  private cachedObjBounds: [number, number, number, number] | null = null;

  // Current map transform for click-to-navigate
  private mapMinX = 0;
  private mapMinY = 0;
  private mapScale = 1;
  private mapOffsetX = 0;
  private mapOffsetY = 0;

  toggle() {
    this.visible = !this.visible;
  }

  render(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    objects: Obj[],
    canvasW: number,
    canvasH: number,
    dark: boolean,
    assets?: Assets,
    sceneVersion = 0,
    dockPosition: DockPosition = 'bottom',
  ) {
    if (!this.visible) return;

    this.w = 220;
    this.h = 144;
    if (dockPosition === 'right') {
      this.x = 18;
      this.y = canvasH - this.h - 80;
    } else if (dockPosition === 'bottom') {
      this.x = canvasW - this.w - 18;
      this.y = canvasH - this.h - 86;
    } else {
      this.x = canvasW - this.w - 18;
      this.y = canvasH - this.h - 80;
    }

    // 1. Update cached object union bounds only when sceneVersion changes
    if (this.lastSceneVersion !== sceneVersion) {
      this.lastSceneVersion = sceneVersion;
      if (objects.length === 0) {
        this.cachedObjBounds = null;
      } else {
        let oMinX = Infinity, oMinY = Infinity, oMaxX = -Infinity, oMaxY = -Infinity;
        for (const o of objects) {
          const b = bboxOf(o);
          if (b[0] < oMinX) oMinX = b[0];
          if (b[1] < oMinY) oMinY = b[1];
          if (b[2] > oMaxX) oMaxX = b[2];
          if (b[3] > oMaxY) oMaxY = b[3];
        }
        this.cachedObjBounds = [oMinX, oMinY, oMaxX, oMaxY];
      }
    }

    // Current viewport in world coordinates
    const vpWorldLeft = -camera.x / camera.zoom;
    const vpWorldTop = -camera.y / camera.zoom;
    const vpWorldRight = (canvasW - camera.x) / camera.zoom;
    const vpWorldBottom = (canvasH - camera.y) / camera.zoom;

    // Quantize viewport bounds to coarse 1200px steps so small camera wiggles/pans
    // never invalidate the minimap object cache
    const qStep = 1200;
    const qLeft = Math.floor(vpWorldLeft / qStep) * qStep;
    const qTop = Math.floor(vpWorldTop / qStep) * qStep;
    const qRight = Math.ceil(vpWorldRight / qStep) * qStep;
    const qBottom = Math.ceil(vpWorldBottom / qStep) * qStep;

    let minX = qLeft, minY = qTop, maxX = qRight, maxY = qBottom;
    if (this.cachedObjBounds) {
      minX = Math.min(minX, this.cachedObjBounds[0]);
      minY = Math.min(minY, this.cachedObjBounds[1]);
      maxX = Math.max(maxX, this.cachedObjBounds[2]);
      maxY = Math.max(maxY, this.cachedObjBounds[3]);
    }

    const spanX = Math.max(200, maxX - minX);
    const spanY = Math.max(200, maxY - minY);
    minX -= spanX * 0.08;
    maxX += spanX * 0.08;
    minY -= spanY * 0.08;
    maxY += spanY * 0.08;

    const totalW = maxX - minX;
    const totalH = maxY - minY;

    const innerPadding = 8;
    const innerW = this.w - innerPadding * 2;
    const innerH = this.h - innerPadding * 2;
    const scale = Math.min(innerW / totalW, innerH / totalH);

    const localOffsetX = innerPadding + (innerW - totalW * scale) / 2;
    const localOffsetY = innerPadding + (innerH - totalH * scale) / 2;

    this.mapMinX = minX;
    this.mapMinY = minY;
    this.mapScale = scale;
    this.mapOffsetX = this.x + localOffsetX;
    this.mapOffsetY = this.y + localOffsetY;

    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(this.w * dpr);
    const ph = Math.round(this.h * dpr);
    const aVer = assets?.version ?? 0;
    const key = `${pw}x${ph}_sv${sceneVersion}_av${aVer}_${dark}_${minX.toFixed(0)}_${minY.toFixed(0)}_${maxX.toFixed(0)}_${maxY.toFixed(0)}`;

    if (this.cacheKey !== key || !this.cacheCanvas) {
      if (!this.cacheCanvas) {
        this.cacheCanvas = document.createElement('canvas');
      }
      if (this.cacheCanvas.width !== pw || this.cacheCanvas.height !== ph) {
        this.cacheCanvas.width = pw;
        this.cacheCanvas.height = ph;
        this.cacheCtx = this.cacheCanvas.getContext('2d');
      }
      if (!this.cacheCtx) {
        this.cacheCtx = this.cacheCanvas.getContext('2d');
      }

      const cCtx = this.cacheCtx!;
      cCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cCtx.clearRect(0, 0, this.w, this.h);

      // Container card
      cCtx.fillStyle = dark ? 'rgba(15, 23, 42, 0.94)' : 'rgba(255, 255, 255, 0.95)';
      cCtx.strokeStyle = dark ? '#475569' : '#cbd5e1';
      cCtx.lineWidth = 1.5;
      cCtx.beginPath();
      cCtx.roundRect(0.75, 0.75, this.w - 1.5, this.h - 1.5, 8);
      cCtx.fill();
      cCtx.stroke();

      // Clip to inner area and transform into world coordinates
      cCtx.save();
      cCtx.beginPath();
      cCtx.roundRect(2, 2, this.w - 4, this.h - 4, 6);
      cCtx.clip();

      cCtx.translate(localOffsetX, localOffsetY);
      cCtx.scale(scale, scale);
      cCtx.translate(-minX, -minY);

      // Draw objects with true miniature geometry
      this.renderDetailedObjects(cCtx, objects, scale, dark, assets);

      cCtx.restore();
      this.cacheKey = key;
    }

    // Blit cached high-detail minimap
    ctx.save();
    // Subtle fast shadow rect behind minimap (no Gaussian blur cost)
    ctx.fillStyle = dark ? 'rgba(0, 0, 0, 0.35)' : 'rgba(15, 23, 42, 0.1)';
    ctx.beginPath();
    ctx.roundRect(this.x + 2, this.y + 3, this.w, this.h, 8);
    ctx.fill();

    ctx.drawImage(this.cacheCanvas, this.x, this.y, this.w, this.h);

    // Draw live red viewport indicator clipped inside the minimap box
    ctx.beginPath();
    ctx.roundRect(this.x + 1.5, this.y + 1.5, this.w - 3, this.h - 3, 7);
    ctx.clip();

    const vx1 = this.mapOffsetX + (vpWorldLeft - minX) * scale;
    const vy1 = this.mapOffsetY + (vpWorldTop - minY) * scale;
    const vw = Math.max(4, (vpWorldRight - vpWorldLeft) * scale);
    const vh = Math.max(4, (vpWorldBottom - vpWorldTop) * scale);

    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1.5;
    ctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
    ctx.fillRect(vx1, vy1, vw, vh);
    ctx.strokeRect(vx1, vy1, vw, vh);

    ctx.restore();
  }

  private renderDetailedObjects(
    ctx: CanvasRenderingContext2D,
    objects: Obj[],
    scale: number,
    dark: boolean,
    assets?: Assets,
  ) {
    const invScale = 1 / scale;

    // 1. Frames & PDF Pages first
    for (const o of objects) {
      if (o.type === 'frame') {
        ctx.fillStyle = dark ? 'rgba(30, 41, 59, 0.6)' : 'rgba(241, 245, 249, 0.85)';
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = Math.max(invScale * 1.2, 2);
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.strokeRect(o.x, o.y, o.w, o.h);
      } else if (o.type === 'pdfpage') {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = invScale;
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.strokeRect(o.x, o.y, o.w, o.h);
      } else if (o.type === 'image') {
        const img = assets?.image(o.asset);
        if (img) {
          ctx.save();
          ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
          if (o.rot) ctx.rotate(o.rot);
          ctx.drawImage(img, -o.w / 2, -o.h / 2, o.w, o.h);
          ctx.restore();
        } else {
          ctx.fillStyle = '#cbd5e1';
          ctx.fillRect(o.x, o.y, o.w, o.h);
        }
      }
    }

    // 2. Strokes, Shapes, Stickies, Text
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const o of objects) {
      if (o.type === 'stroke') {
        const pts = o.pts;
        const n = pts.length;
        if (n < 3) continue;
        ctx.save();
        if (o.highlighter) ctx.globalAlpha = 0.4;
        ctx.strokeStyle = o.color;
        ctx.fillStyle = o.color;
        ctx.lineWidth = Math.max(invScale * 1.1, o.size);

        if (n === 3) {
          const r = Math.max(invScale, o.size / 2);
          ctx.beginPath();
          ctx.arc(pts[0], pts[1], r, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Sample points adaptively for crisp miniature polyline
          const step = n > 180 ? 6 : 3;
          ctx.beginPath();
          ctx.moveTo(pts[0], pts[1]);
          for (let i = step; i < n; i += step) {
            ctx.lineTo(pts[i], pts[i + 1]);
          }
          if ((n - 3) % step !== 0) {
            ctx.lineTo(pts[n - 3], pts[n - 2]);
          }
          ctx.stroke();
        }
        ctx.restore();
      } else if (o.type === 'shape') {
        ctx.save();
        ctx.strokeStyle = o.color;
        ctx.lineWidth = Math.max(invScale * 1.1, o.width);
        if (o.kind === 'line' || o.kind === 'arrow' || o.kind === 'polygon') {
          const pts = o.pts;
          if (pts && pts.length >= 4) {
            ctx.beginPath();
            ctx.moveTo(pts[0], pts[1]);
            for (let i = 2; i < pts.length; i += 2) {
              ctx.lineTo(pts[i], pts[i + 1]);
            }
            ctx.stroke();
          }
        } else {
          ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
          if (o.rot) ctx.rotate(o.rot);
          ctx.translate(-o.w / 2, -o.h / 2);
          ctx.beginPath();
          if (o.kind === 'rect') {
            ctx.rect(0, 0, o.w, o.h);
          } else if (o.kind === 'ellipse') {
            ctx.ellipse(o.w / 2, o.h / 2, o.w / 2, o.h / 2, 0, 0, Math.PI * 2);
          } else if (o.kind === 'triangle') {
            ctx.moveTo(o.w / 2, 0);
            ctx.lineTo(o.w, o.h);
            ctx.lineTo(0, o.h);
            ctx.closePath();
          } else if (o.kind === 'diamond') {
            ctx.moveTo(o.w / 2, 0);
            ctx.lineTo(o.w, o.h / 2);
            ctx.lineTo(o.w / 2, o.h);
            ctx.lineTo(0, o.h / 2);
            ctx.closePath();
          }
          if (o.fill) {
            ctx.fillStyle = o.fill;
            ctx.fill();
          }
          ctx.stroke();
        }
        ctx.restore();
      } else if (o.type === 'sticky') {
        ctx.save();
        ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
        if (o.rot) ctx.rotate(o.rot);
        ctx.fillStyle = o.color;
        ctx.fillRect(-o.w / 2, -o.h / 2, o.w, o.h);
        ctx.restore();
      } else if (o.type === 'text') {
        ctx.save();
        ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
        if (o.rot) ctx.rotate(o.rot);
        ctx.translate(-o.w / 2, -o.h / 2);
        ctx.fillStyle = o.color;
        const lineH = Math.max(invScale * 1.2, o.fontSize * 0.55);
        const stepY = Math.max(lineH * 1.6, o.fontSize * 1.25);
        for (let y = 0; y + lineH <= o.h; y += stepY) {
          ctx.fillRect(0, y, o.w * 0.85, lineH);
        }
        ctx.restore();
      }
    }
  }

  panCameraToScreenPoint(px: number, py: number, camera: Camera, canvasW: number, canvasH: number): boolean {
    if (!this.isPointInside(px, py) || this.mapScale <= 0) return false;
    const wx = this.mapMinX + (px - this.mapOffsetX) / this.mapScale;
    const wy = this.mapMinY + (py - this.mapOffsetY) / this.mapScale;
    camera.x = canvasW / 2 - wx * camera.zoom;
    camera.y = canvasH / 2 - wy * camera.zoom;
    return true;
  }

  isPointInside(px: number, py: number): boolean {
    if (!this.visible) return false;
    return px >= this.x && px <= this.x + this.w && py >= this.y && py <= this.y + this.h;
  }
}
