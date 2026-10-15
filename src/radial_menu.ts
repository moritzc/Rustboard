export interface RadialItem {
  id: string;
  label: string;
  icon?: string;
  color?: string;
  action: () => void;
}

export class RadialMenu {
  visible = false;
  x = 0;
  y = 0;
  items: RadialItem[] = [];
  selectedIndex = -1;

  show(x: number, y: number, items: RadialItem[]) {
    this.x = x;
    this.y = y;
    this.items = items;
    this.visible = true;
    this.selectedIndex = -1;
  }

  hide() {
    this.visible = false;
    this.selectedIndex = -1;
  }

  updateHover(px: number, py: number) {
    if (!this.visible || this.items.length === 0) return;
    const dx = px - this.x;
    const dy = py - this.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 20 || dist > 110) {
      this.selectedIndex = -1;
      return;
    }

    let angle = Math.atan2(dy, dx); // -PI to PI
    if (angle < 0) angle += Math.PI * 2; // 0 to 2PI

    const segment = (Math.PI * 2) / this.items.length;
    this.selectedIndex = Math.floor(angle / segment) % this.items.length;
  }

  triggerSelected() {
    if (this.visible && this.selectedIndex >= 0 && this.selectedIndex < this.items.length) {
      const it = this.items[this.selectedIndex];
      this.hide();
      it.action();
      return true;
    }
    this.hide();
    return false;
  }

  render(ctx: CanvasRenderingContext2D) {
    if (!this.visible || this.items.length === 0) return;

    const n = this.items.length;
    const innerR = 28;
    const outerR = 90;
    const segment = (Math.PI * 2) / n;

    ctx.save();
    ctx.translate(this.x, this.y);

    // Drop shadow
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = 12;

    for (let i = 0; i < n; i++) {
      const it = this.items[i];
      const startAngle = i * segment;
      const endAngle = (i + 1) * segment;
      const isHover = i === this.selectedIndex;

      ctx.beginPath();
      ctx.arc(0, 0, outerR, startAngle, endAngle);
      ctx.arc(0, 0, innerR, endAngle, startAngle, true);
      ctx.closePath();

      ctx.fillStyle = isHover ? '#2b6cb0' : 'rgba(255, 255, 255, 0.95)';
      ctx.fill();

      ctx.strokeStyle = '#cbd5e0';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Content of wedge
      const midAngle = startAngle + segment / 2;
      const labelR = (innerR + outerR) / 2;
      const lx = Math.cos(midAngle) * labelR;
      const ly = Math.sin(midAngle) * labelR;

      if (it.color) {
        // Draw color circle
        ctx.beginPath();
        ctx.arc(lx, ly, isHover ? 14 : 11, 0, Math.PI * 2);
        ctx.fillStyle = it.color;
        ctx.fill();
        ctx.strokeStyle = isHover ? '#ffffff' : '#718096';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        // Draw text label
        ctx.fillStyle = isHover ? '#ffffff' : '#2d3748';
        ctx.font = 'bold 11px -apple-system, Segoe UI, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(it.label, lx, ly);
      }
    }

    // Center hub
    ctx.beginPath();
    ctx.arc(0, 0, innerR - 2, 0, Math.PI * 2);
    ctx.fillStyle = '#1a365d';
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Tools', 0, 0);

    ctx.restore();
  }
}
