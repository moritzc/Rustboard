import { dist, distToSeg, rotPt } from './geom';

export interface RulerState {
  enabled: boolean;
  x: number; // screen center X
  y: number; // screen center Y
  angle: number; // in radians
  length: number; // in screen pixels
  height: number; // in screen pixels
}

export class Ruler {
  state: RulerState = {
    enabled: false,
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    angle: 0,
    length: 540,
    height: 80,
  };

  toggle() {
    this.state.enabled = !this.state.enabled;
    if (this.state.enabled) {
      this.state.x = window.innerWidth / 2;
      this.state.y = window.innerHeight / 2;
    }
  }

  containsScreenPoint(sx: number, sy: number): boolean {
    if (!this.state.enabled) return false;
    const { x: cx, y: cy, angle, length: len, height: h } = this.state;
    const [lx, ly] = rotPt(sx, sy, cx, cy, -angle);
    return Math.abs(lx - cx) <= len / 2 && Math.abs(ly - cy) <= h / 2;
  }

  isNearRuler(sx: number, sy: number, margin = 40): boolean {
    if (!this.state.enabled) return false;
    const { x: cx, y: cy, angle, length: len, height: h } = this.state;
    const [lx, ly] = rotPt(sx, sy, cx, cy, -angle);
    return Math.abs(lx - cx) <= len / 2 + margin && Math.abs(ly - cy) <= h / 2 + margin;
  }

  isDialScreenPoint(sx: number, sy: number): boolean {
    if (!this.state.enabled) return false;
    const { x: cx, y: cy } = this.state;
    return Math.hypot(sx - cx, sy - cy) <= 32;
  }

  rotateBy(rad: number) {
    this.state.angle = this.snapAngle(this.state.angle + rad);
  }

  setAngle(rad: number) {
    this.state.angle = this.snapAngle(rad);
  }

  snapAngle(rad: number): number {
    let deg = ((rad * 180) / Math.PI) % 360;
    if (deg < 0) deg += 360;
    // Common snaps: every 15 degrees and 45 degrees
    const snapTargets = [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225, 240, 255, 270, 285, 300, 315, 330, 345, 360];
    for (const t of snapTargets) {
      if (Math.abs(deg - t) <= 2.2) {
        return (t * Math.PI) / 180;
      }
    }
    return rad;
  }

  /**
   * Snaps a world point (or screen point) to the ruler's top or bottom edge if within threshold.
   * Return snapped coords if close, or null if no snap.
   */
  snapScreenPoint(sx: number, sy: number, threshold = 26): { x: number; y: number } | null {
    if (!this.state.enabled) return null;

    const { x: cx, y: cy, angle, length: len, height: h } = this.state;
    const [lx, ly] = rotPt(sx, sy, cx, cy, -angle);
    const relX = lx - cx;
    const relY = ly - cy;

    // Check if within ruler length (+ small margin)
    if (Math.abs(relX) > len / 2 + 10) return null;

    // Top edge is at relY = -h/2, bottom edge is at relY = h/2
    const distTop = Math.abs(relY - (-h / 2));
    const distBottom = Math.abs(relY - (h / 2));

    let snapY: number | null = null;
    if (distTop <= threshold && distTop < distBottom) {
      snapY = -h / 2;
    } else if (distBottom <= threshold) {
      snapY = h / 2;
    }

    if (snapY !== null) {
      const snappedLocalX = Math.max(-len / 2, Math.min(len / 2, relX));
      const [snappedSx, snappedSy] = rotPt(cx + snappedLocalX, cy + snapY, cx, cy, angle);
      return { x: snappedSx, y: snappedSy };
    }

    return null;
  }

  render(ctx: CanvasRenderingContext2D) {
    if (!this.state.enabled) return;

    const { x: cx, y: cy, angle, length: len, height: h } = this.state;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    // Ruler body with glassmorphic semi-transparent background
    ctx.fillStyle = 'rgba(255, 255, 255, 0.90)';
    ctx.strokeStyle = '#2b6cb0';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;

    const r = 8;
    const rx = -len / 2;
    const ry = -h / 2;
    ctx.beginPath();
    ctx.roundRect(rx, ry, len, h, r);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.stroke();

    // Edge highlight to indicate snapping edge
    ctx.strokeStyle = '#3182ce';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-len / 2 + 6, -h / 2);
    ctx.lineTo(len / 2 - 6, -h / 2);
    ctx.moveTo(-len / 2 + 6, h / 2);
    ctx.lineTo(len / 2 - 6, h / 2);
    ctx.stroke();

    // Tick marks along top edge
    ctx.strokeStyle = '#4a5568';
    ctx.fillStyle = '#2d3748';
    ctx.font = '10px -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';

    const mmStep = 10;
    const startX = -len / 2 + 10;
    const endX = len / 2 - 10;
    let markCount = 0;

    for (let x = startX; x <= endX; x += mmStep) {
      const isMajor = markCount % 5 === 0;
      const isInch = markCount % 10 === 0;
      const tickH = isInch ? 16 : isMajor ? 11 : 6;

      ctx.beginPath();
      ctx.moveTo(x, -h / 2);
      ctx.lineTo(x, -h / 2 + tickH);
      ctx.stroke();

      if (isInch) {
        ctx.fillText(String(markCount / 10), x, -h / 2 + tickH + 10);
      }

      // Also tick marks on bottom edge
      ctx.beginPath();
      ctx.moveTo(x, h / 2);
      ctx.lineTo(x, h / 2 - tickH);
      ctx.stroke();

      markCount++;
    }

    // Center protractor dial
    const deg = Math.round(((angle * 180) / Math.PI) % 360);
    const displayDeg = deg < 0 ? deg + 360 : deg;

    ctx.fillStyle = '#1a365d';
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#63b3ed';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${displayDeg}°`, 0, 0);

    // Rotation hint arrows on dial
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, 20, -Math.PI / 3, Math.PI / 3);
    ctx.stroke();

    ctx.restore();
  }
}
