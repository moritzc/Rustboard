import { bboxOf } from './objects';
import type { Camera, FrameObj, Obj } from './types';

export class Minimap {
  visible = true;
  x = 0;
  y = 0;
  w = 200;
  h = 130;

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
  ) {
    if (!this.visible) return;

    this.w = 200;
    this.h = 130;
    this.x = canvasW - this.w - 18;
    this.y = canvasH - this.h - 90;

    ctx.save();
    // Container box
    ctx.fillStyle = dark ? 'rgba(30, 41, 59, 0.92)' : 'rgba(255, 255, 255, 0.92)';
    ctx.strokeStyle = dark ? '#475569' : '#cbd5e1';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.2)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 2;

    ctx.beginPath();
    ctx.roundRect(this.x, this.y, this.w, this.h, 8);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.stroke();

    // Compute bounding box of all objects and current screen viewport
    const vpWorldLeft = -camera.x / camera.zoom;
    const vpWorldTop = -camera.y / camera.zoom;
    const vpWorldRight = (canvasW - camera.x) / camera.zoom;
    const vpWorldBottom = (canvasH - camera.y) / camera.zoom;

    let minX = vpWorldLeft, minY = vpWorldTop, maxX = vpWorldRight, maxY = vpWorldBottom;
    for (const o of objects) {
      const b = bboxOf(o);
      if (b[0] < minX) minX = b[0];
      if (b[1] < minY) minY = b[1];
      if (b[2] > maxX) maxX = b[2];
      if (b[3] > maxY) maxY = b[3];
    }

    // Add 10% padding
    const spanX = Math.max(100, maxX - minX);
    const spanY = Math.max(100, maxY - minY);
    minX -= spanX * 0.1;
    maxX += spanX * 0.1;
    minY -= spanY * 0.1;
    maxY += spanY * 0.1;

    const totalW = maxX - minX;
    const totalH = maxY - minY;

    const innerPadding = 10;
    const innerW = this.w - innerPadding * 2;
    const innerH = this.h - innerPadding * 2;
    const scale = Math.min(innerW / totalW, innerH / totalH);

    const offsetX = this.x + innerPadding + (innerW - totalW * scale) / 2;
    const offsetY = this.y + innerPadding + (innerH - totalH * scale) / 2;

    const worldToMap = (wx: number, wy: number): [number, number] => [
      offsetX + (wx - minX) * scale,
      offsetY + (wy - minY) * scale,
    ];

    // Render tiny representations of objects
    for (const o of objects) {
      if (o.type === 'frame') {
        const [fx, fy] = worldToMap(o.x, o.y);
        ctx.strokeStyle = '#3182ce';
        ctx.lineWidth = 1;
        ctx.strokeRect(fx, fy, o.w * scale, o.h * scale);
      } else {
        const b = bboxOf(o);
        const [bx, by] = worldToMap(b[0], b[1]);
        const bw = Math.max(1.5, (b[2] - b[0]) * scale);
        const bh = Math.max(1.5, (b[3] - b[1]) * scale);
        ctx.fillStyle = o.type === 'stroke' ? o.color : '#a0aec0';
        ctx.fillRect(bx, by, bw, bh);
      }
    }

    // Viewport box
    const [vx1, vy1] = worldToMap(vpWorldLeft, vpWorldTop);
    const [vx2, vy2] = worldToMap(vpWorldRight, vpWorldBottom);
    ctx.strokeStyle = '#e53e3e';
    ctx.lineWidth = 1.5;
    ctx.fillStyle = 'rgba(229, 62, 62, 0.12)';
    ctx.fillRect(vx1, vy1, vx2 - vx1, vy2 - vy1);
    ctx.strokeRect(vx1, vy1, vx2 - vx1, vy2 - vy1);

    ctx.restore();
  }

  isPointInside(px: number, py: number): boolean {
    if (!this.visible) return false;
    return px >= this.x && px <= this.x + this.w && py >= this.y && py <= this.y + this.h;
  }
}
