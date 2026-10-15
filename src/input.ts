import { invoke } from '@tauri-apps/api/core';
import type { Assets } from './assets';
import { eraseObjectsAt, type EraserState } from './eraser';
import {
  apply, type BBox, compose, dist, normAngle, pointInPoly, rotateM, rotPt, scaleM, translate,
} from './geom';
import type { Minimap } from './minimap';
import {
  bboxOf, boxOf, Handle, handlePositions, hitTest, insideBox, insideFrame,
  samplePoints, selectionFrame, TransformInfo, transformObj, translateObj,
} from './objects';
import type { RadialMenu } from './radial_menu';
import type { Ruler } from './ruler';
import type { Scene } from './scene';
import type {
  Box, Camera, FrameObj, ImageObj, LineDash, Obj, PdfPageObj, SelectMode, ShapeKind, ShapeObj, ShapeTool, StrokeObj, TextObj, Tool,
} from './types';
import { PT, uid } from './types';

export interface PenConfig {
  color: string;
  size: number;
}

export class InputManager {
  currentTool: Tool = 'pen';
  penConfig: PenConfig = { color: '#1a202c', size: 3.5 };
  highlighterConfig: PenConfig = { color: '#ffd600', size: 24 };
  eraserBaseSize = 16;
  textConfig = { fontSize: 24, bold: false, italic: false };

  onToolChanged?: (tool: Tool) => void;
  onEditText?: (obj: TextObj, isNew: boolean) => void;
  onPromptDeleteFrame?: (onDeleteFrameOnly: () => void, onDeleteFrameAndContent: () => void) => void;

  // Shape tool settings
  shapeTool: ShapeTool = 'rect';
  shapeKind: ShapeKind = 'rect';
  shapeLineDash: LineDash = 'solid';
  shapeArrowStart = false;
  shapeArrowEnd = false;
  fillShape = false;

  // Selection & Lasso settings
  selectMode: SelectMode = 'lasso';
  activeDraft: Obj | null = null;
  lassoPoly: number[] | null = null;
  selectedIds = new Set<string>();
  activeSelectionBox: Box | null = null;
  private frameContainedIds = new Set<string>();
  private rotAnchor: { x: number; y: number } | null = null;
  private rotStartPointerAngle = 0;
  private rotStartBoxAngle = 0;

  // Eraser state (velocity-adaptive circle indicator & slicing)
  eraserState: EraserState = { active: false, x: 0, y: 0, radius: 16 };
  private eraserActive = false;
  private eraserInitialObjs: Obj[] | null = null;
  private lastEraserPoint = { x: 0, y: 0, time: 0 };
  private eraserSpeed = 0;
  private currentScreenRadius = 16;
  private eraserStrokeDist = 0;

  // Multi-touch pinch-zoom & pan tracking
  private lastTouchDist = 0;
  private lastTouchMid = { x: 0, y: 0 };

  // Ruler interaction tracking
  private rulerTouchMode: 'single' | 'dial' | 'two-touch' | null = null;
  private rulerMouseMode: 'body' | 'dial' | null = null;
  private rulerDragStart = { x: 0, y: 0 };
  private rulerStartCenter = { x: 0, y: 0 };
  private rulerDialStartAngle = 0;
  private rulerDialStartPointerAngle = 0;
  private rulerTwoTouchStartAngle = 0;
  private rulerTwoTouchBaseAngle = 0;
  private rulerTwoTouchStartMid = { x: 0, y: 0 };
  private rulerTwoTouchStartCenter = { x: 0, y: 0 };

  // Pointer tracking
  private activePointers = new Map<number, { x: number; y: number; type: string }>();
  private penDown = false;
  private isPanning = false;
  private panStart = { x: 0, y: 0 };

  // Stroke points [x, y, pressure...]
  private rawStrokePts: number[] = [];

  // Selection interaction
  private dragMode: 'move' | 'resize' | 'rotate' | 'lasso' | null = null;
  private activeHandle: Handle | null = null;
  private transformStartBox: Box | null = null;
  private transformInitialObjs: Obj[] = [];
  private dragStartWorld = { x: 0, y: 0 };

  constructor(
    private canvas: HTMLCanvasElement,
    private scene: Scene,
    private assets: Assets,
    private camera: Camera,
    private ruler: Ruler,
    private radial: RadialMenu,
    private minimap: Minimap,
    private onNeedRender: () => void,
    private onSelectionChanged: (ids: Set<string>) => void,
  ) {
    this.bindEvents();
  }

  private screenToWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.camera.x) / this.camera.zoom, (sy - this.camera.y) / this.camera.zoom];
  }

  private worldToScreen(wx: number, wy: number): [number, number] {
    return [wx * this.camera.zoom + this.camera.x, wy * this.camera.zoom + this.camera.y];
  }

  private bindEvents() {
    const el = this.canvas;
    el.addEventListener('pointerdown', this.onPointerDown.bind(this));
    el.addEventListener('pointermove', this.onPointerMove.bind(this));
    el.addEventListener('pointerup', this.onPointerUp.bind(this));
    el.addEventListener('pointercancel', this.onPointerUp.bind(this));
    el.addEventListener('dblclick', this.onDoubleClick.bind(this));
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    // Wheel zoom & pan, plus ruler rotation when scrolling over ruler
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.ruler.state.enabled && this.ruler.containsScreenPoint(e.clientX, e.clientY)) {
        const step = (e.shiftKey ? 5 : 1) * (Math.PI / 180);
        const dir = e.deltaY < 0 ? -1 : 1;
        this.ruler.rotateBy(dir * step);
        this.onNeedRender();
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        // Zoom centered on cursor
        const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
        const newZoom = Math.max(0.08, Math.min(15, this.camera.zoom * zoomFactor));
        const mouseX = e.clientX;
        const mouseY = e.clientY;

        this.camera.x = mouseX - (mouseX - this.camera.x) * (newZoom / this.camera.zoom);
        this.camera.y = mouseY - (mouseY - this.camera.y) * (newZoom / this.camera.zoom);
        this.camera.zoom = newZoom;
      } else {
        // Pan
        this.camera.x -= e.deltaX;
        this.camera.y -= e.deltaY;
      }
      this.onNeedRender();
    }, { passive: false });

    el.addEventListener('pointerleave', () => {
      if (!this.eraserActive && this.eraserState.active) {
        this.eraserState.active = false;
        this.onNeedRender();
      }
    });

    // Global keyboard shortcuts
    window.addEventListener('keydown', this.onKeyDown.bind(this));

    // Clipboard image paste (Ctrl+V)
    window.addEventListener('paste', this.onPaste.bind(this));

    // Drag & Drop files and web images
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
    });
    window.addEventListener('drop', this.onDrop.bind(this));
  }

  setTool(tool: Tool) {
    if (this.currentTool !== tool) {
      if (tool !== 'select') {
        this.clearSelection();
      }
      this.currentTool = tool;
      this.onToolChanged?.(tool);
      this.onNeedRender();
    }
  }

  clearSelection() {
    if (this.selectedIds.size > 0 || this.activeSelectionBox) {
      this.selectedIds.clear();
      this.activeSelectionBox = null;
      this.onSelectionChanged(this.selectedIds);
      this.onNeedRender();
    }
  }

  private onDoubleClick(e: MouseEvent) {
    const [wx, wy] = this.screenToWorld(e.clientX, e.clientY);
    const tol = 12 / this.camera.zoom;
    for (let i = this.scene.objects.length - 1; i >= 0; i--) {
      const o = this.scene.objects[i];
      if (o.type === 'text' && hitTest(o, wx, wy, tol, this.camera.zoom)) {
        this.onEditText?.(o, false);
        return;
      }
    }
  }

  private onPointerDown(e: PointerEvent) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);

    // Palm Rejection: If pen is active or hovering, completely ignore touch
    if (this.penDown && e.pointerType === 'touch') return;

    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

    // Stylus Barrel Button or Right Click -> Quick Select (draw to select)
    if (e.button === 2 || (e.buttons & 2)) {
      const [wx, wy] = this.screenToWorld(e.clientX, e.clientY);
      this.clearSelection();
      this.currentTool = 'select';
      this.dragMode = 'lasso';
      this.lassoPoly = [wx, wy];
      this.onToolChanged?.('select');
      this.onNeedRender();
      return;
    }

    // Check if clicking inside Minimap (Idea #7)
    if (this.minimap.isPointInside(e.clientX, e.clientY)) {
      return;
    }

    // Touch: Pen draws, finger manipulates ruler or canvas
    if (e.pointerType === 'touch') {
      if (this.activePointers.size === 2) {
        const pts = [...this.activePointers.values()];
        const isNear =
          this.ruler.state.enabled &&
          (this.rulerTouchMode !== null ||
            this.ruler.isNearRuler(pts[0].x, pts[0].y) ||
            this.ruler.isNearRuler(pts[1].x, pts[1].y));

        if (isNear) {
          // Two-finger ruler rotate and move
          this.isPanning = false;
          this.rulerTouchMode = 'two-touch';
          this.rulerTwoTouchStartAngle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
          this.rulerTwoTouchBaseAngle = this.ruler.state.angle;
          this.rulerTwoTouchStartMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
          this.rulerTwoTouchStartCenter = { x: this.ruler.state.x, y: this.ruler.state.y };
          return;
        }

        // Anchored two-finger pinch-zoom & pan
        this.isPanning = false;
        this.rulerTouchMode = null;
        this.lastTouchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        this.lastTouchMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        return;
      }

      if (this.activePointers.size === 1) {
        if (this.ruler.state.enabled) {
          if (this.ruler.isDialScreenPoint(e.clientX, e.clientY)) {
            this.rulerTouchMode = 'dial';
            this.rulerDialStartAngle = this.ruler.state.angle;
            this.rulerDialStartPointerAngle = Math.atan2(e.clientY - this.ruler.state.y, e.clientX - this.ruler.state.x);
            return;
          }
          if (this.ruler.containsScreenPoint(e.clientX, e.clientY)) {
            this.rulerTouchMode = 'single';
            this.rulerDragStart = { x: e.clientX, y: e.clientY };
            this.rulerStartCenter = { x: this.ruler.state.x, y: this.ruler.state.y };
            return;
          }
        }

        // Single finger touch = Pan canvas
        this.isPanning = true;
        this.panStart = { x: e.clientX - this.camera.x, y: e.clientY - this.camera.y };
        return;
      }
    }

    // Middle mouse or Space held -> Pan
    if (e.button === 1 || (e.buttons & 4)) {
      this.isPanning = true;
      this.panStart = { x: e.clientX - this.camera.x, y: e.clientY - this.camera.y };
      return;
    }

    // Mouse ruler interaction
    if (e.pointerType === 'mouse' && this.ruler.state.enabled) {
      if (this.ruler.isDialScreenPoint(e.clientX, e.clientY)) {
        this.rulerMouseMode = 'dial';
        this.rulerDialStartAngle = this.ruler.state.angle;
        this.rulerDialStartPointerAngle = Math.atan2(e.clientY - this.ruler.state.y, e.clientX - this.ruler.state.x);
        return;
      }
      const snap = this.ruler.snapScreenPoint(e.clientX, e.clientY);
      if (this.ruler.containsScreenPoint(e.clientX, e.clientY) && (!snap || this.currentTool === 'select')) {
        this.rulerMouseMode = 'body';
        this.rulerDragStart = { x: e.clientX, y: e.clientY };
        this.rulerStartCenter = { x: this.ruler.state.x, y: this.ruler.state.y };
        return;
      }
    }

    if (e.pointerType === 'pen') this.penDown = true;

    // Detect stylus eraser end (button 5 or buttons 32)
    const isEraserTip = e.button === 5 || (e.buttons & 32) !== 0;
    const effectiveTool: Tool = isEraserTip ? 'eraser' : this.currentTool;

    let [wx, wy] = this.screenToWorld(e.clientX, e.clientY);

    // Snap to ruler if enabled (Idea #3)
    const snap = this.ruler.snapScreenPoint(e.clientX, e.clientY);
    if (snap) {
      [wx, wy] = this.screenToWorld(snap.x, snap.y);
    }

    this.dragStartWorld = { x: wx, y: wy };

    if (effectiveTool === 'pen' || effectiveTool === 'highlighter') {
      const isHl = effectiveTool === 'highlighter';
      const cfg = isHl ? this.highlighterConfig : this.penConfig;
      const pressure = e.pressure > 0 ? e.pressure : 0.5;
      const sim = e.pointerType === 'mouse';

      this.rawStrokePts = [wx, wy, pressure];
      this.activeDraft = {
        id: uid(),
        type: 'stroke',
        pts: this.rawStrokePts.slice(),
        color: cfg.color,
        size: cfg.size,
        highlighter: isHl,
        sim,
      };
      this.onNeedRender();
    } else if (effectiveTool === 'laser' || effectiveTool === 'fading') {
      this.activeDraft = null;
      this.onNeedRender();
    } else if (effectiveTool === 'eraser') {
      this.startErasing(wx, wy);
    } else if (effectiveTool === 'select') {
      this.handleSelectDown(wx, wy, e.clientX, e.clientY);
    } else if (effectiveTool === 'text') {
      const tol = 12 / this.camera.zoom;
      let hitText: TextObj | null = null;
      for (let i = this.scene.objects.length - 1; i >= 0; i--) {
        const o = this.scene.objects[i];
        if (o.type === 'text' && hitTest(o, wx, wy, tol, this.camera.zoom)) {
          hitText = o;
          break;
        }
      }
      if (hitText) {
        this.onEditText?.(hitText, false);
      } else {
        const newText: TextObj = {
          id: uid(),
          type: 'text',
          text: '',
          fontSize: this.textConfig.fontSize,
          bold: this.textConfig.bold,
          italic: this.textConfig.italic,
          color: this.penConfig.color,
          font: 'sans',
          x: wx,
          y: wy,
          w: 240,
          h: 40,
          rot: 0,
        };
        this.onEditText?.(newText, true);
      }
    } else if (effectiveTool === 'shape') {
      const isLine = this.shapeTool === 'line';
      let kind: ShapeKind;
      if (isLine) {
        kind = this.shapeArrowEnd && !this.shapeArrowStart ? 'arrow' : 'line';
      } else if (this.shapeTool === 'square') {
        kind = 'rect';
      } else if (this.shapeTool === 'circle') {
        kind = 'ellipse';
      } else {
        kind = this.shapeTool;
      }
      this.shapeKind = kind;

      this.activeDraft = {
        id: uid(),
        type: 'shape',
        kind,
        x: wx,
        y: wy,
        w: 1,
        h: 1,
        rot: 0,
        color: this.penConfig.color,
        width: Math.max(2, this.penConfig.size),
        fill: !isLine && this.fillShape ? this.penConfig.color + '33' : null,
        dash: this.shapeLineDash !== 'solid' ? this.shapeLineDash : undefined,
        arrowStart: isLine ? this.shapeArrowStart : undefined,
        arrowEnd: isLine ? this.shapeArrowEnd : undefined,
        pts: isLine ? [wx, wy, wx, wy] : undefined,
      };
      this.onNeedRender();
    } else if (effectiveTool === 'frame') {
      this.dragStartWorld = { x: wx, y: wy };
      this.activeDraft = {
        id: uid(),
        type: 'frame',
        name: `Page ${this.scene.objects.filter((o) => o.type === 'frame').length + 1}`,
        x: wx,
        y: wy,
        w: 1,
        h: 1,
        rot: 0,
      };
      this.onNeedRender();
    }
  }

  private onPointerMove(e: PointerEvent) {
    if (this.radial.visible) {
      this.radial.updateHover(e.clientX, e.clientY);
      this.onNeedRender();
      return;
    }

    if (!this.activePointers.has(e.pointerId)) {
      if (this.currentTool === 'eraser') {
        const [hwx, hwy] = this.screenToWorld(e.clientX, e.clientY);
        this.eraserState.active = true;
        this.eraserState.x = hwx;
        this.eraserState.y = hwy;
        this.eraserState.radius = this.eraserBaseSize / this.camera.zoom;
        this.onNeedRender();
      } else if (this.currentTool === 'select') {
        this.updateSelectCursor(e.clientX, e.clientY);
      }
      return;
    }

    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

    // 1. Two-finger touch gestures: Ruler two-touch rotate/pan OR Canvas anchored pinch-zoom
    if (e.pointerType === 'touch' && this.activePointers.size === 2) {
      const pts = [...this.activePointers.values()];
      const p0 = pts[0];
      const p1 = pts[1];

      if (this.rulerTouchMode === 'two-touch') {
        const curAngle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
        const dAngle = curAngle - this.rulerTwoTouchStartAngle;
        this.ruler.setAngle(this.rulerTwoTouchBaseAngle + dAngle);

        const curMid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
        this.ruler.state.x = this.rulerTwoTouchStartCenter.x + (curMid.x - this.rulerTwoTouchStartMid.x);
        this.ruler.state.y = this.rulerTwoTouchStartCenter.y + (curMid.y - this.rulerTwoTouchStartMid.y);
        this.onNeedRender();
        return;
      }

      // Anchored canvas pinch-zoom & pan
      const curDist = Math.hypot(p0.x - p1.x, p0.y - p1.y);
      const curMidX = (p0.x + p1.x) / 2;
      const curMidY = (p0.y + p1.y) / 2;

      if (this.lastTouchDist > 0 && curDist > 0) {
        const zoomFactor = curDist / this.lastTouchDist;
        const oldZoom = this.camera.zoom;
        const newZoom = Math.max(0.08, Math.min(15, oldZoom * zoomFactor));

        // Anchor zoom directly at the midpoint of the fingers
        const newCamX = curMidX - (curMidX - this.camera.x) * (newZoom / oldZoom);
        const newCamY = curMidY - (curMidY - this.camera.y) * (newZoom / oldZoom);

        // Include finger translation
        const dx = curMidX - this.lastTouchMid.x;
        const dy = curMidY - this.lastTouchMid.y;

        this.camera.x = newCamX + dx;
        this.camera.y = newCamY + dy;
        this.camera.zoom = newZoom;
        this.onNeedRender();
      }

      this.lastTouchDist = curDist;
      this.lastTouchMid = { x: curMidX, y: curMidY };
      return;
    }

    // 2. Touch single-finger ruler interaction
    if (e.pointerType === 'touch') {
      if (this.rulerTouchMode === 'single') {
        this.ruler.state.x = this.rulerStartCenter.x + (e.clientX - this.rulerDragStart.x);
        this.ruler.state.y = this.rulerStartCenter.y + (e.clientY - this.rulerDragStart.y);
        this.onNeedRender();
        return;
      }
      if (this.rulerTouchMode === 'dial') {
        const curAngle = Math.atan2(e.clientY - this.ruler.state.y, e.clientX - this.ruler.state.x);
        const dAngle = curAngle - this.rulerDialStartPointerAngle;
        this.ruler.setAngle(this.rulerDialStartAngle + dAngle);
        this.onNeedRender();
        return;
      }
    }

    // 3. Mouse ruler interaction
    if (this.rulerMouseMode === 'body') {
      this.ruler.state.x = this.rulerStartCenter.x + (e.clientX - this.rulerDragStart.x);
      this.ruler.state.y = this.rulerStartCenter.y + (e.clientY - this.rulerDragStart.y);
      this.onNeedRender();
      return;
    }
    if (this.rulerMouseMode === 'dial') {
      const curAngle = Math.atan2(e.clientY - this.ruler.state.y, e.clientX - this.ruler.state.x);
      const dAngle = curAngle - this.rulerDialStartPointerAngle;
      this.ruler.setAngle(this.rulerDialStartAngle + dAngle);
      this.onNeedRender();
      return;
    }

    if (this.isPanning) {
      this.camera.x = e.clientX - this.panStart.x;
      this.camera.y = e.clientY - this.panStart.y;
      this.onNeedRender();
      return;
    }

    let [wx, wy] = this.screenToWorld(e.clientX, e.clientY);

    // Ruler snap
    const snap = this.ruler.snapScreenPoint(e.clientX, e.clientY);
    if (snap) {
      [wx, wy] = this.screenToWorld(snap.x, snap.y);
    }

    const isEraserTip = e.button === 5 || (e.buttons & 32) !== 0;
    const effectiveTool: Tool = isEraserTip ? 'eraser' : this.currentTool;

    if (effectiveTool === 'pen' || effectiveTool === 'highlighter') {
      if (this.activeDraft && this.activeDraft.type === 'stroke') {
        const pressure = e.pressure > 0 ? e.pressure : 0.5;
        this.rawStrokePts.push(wx, wy, pressure);
        this.activeDraft.pts = this.rawStrokePts.slice();
        this.onNeedRender();
      }
    } else if (effectiveTool === 'laser' || effectiveTool === 'fading') {
      (this as any).renderer?.addLaser(wx, wy, effectiveTool === 'laser' ? '#ff1744' : '#29b6f6');
      this.onNeedRender();
    } else if (effectiveTool === 'eraser') {
      this.continueErasing(wx, wy, e.clientX, e.clientY);
    } else if (effectiveTool === 'shape' && this.activeDraft && this.activeDraft.type === 'shape') {
      this.updateShapeDraft(wx, wy);
      this.onNeedRender();
    } else if (effectiveTool === 'frame' && this.activeDraft && this.activeDraft.type === 'frame') {
      const f = this.activeDraft;
      const x0 = Math.min(this.dragStartWorld.x, wx);
      const y0 = Math.min(this.dragStartWorld.y, wy);
      const w0 = Math.max(1, Math.abs(wx - this.dragStartWorld.x));
      const h0 = Math.max(1, Math.abs(wy - this.dragStartWorld.y));
      f.x = x0;
      f.y = y0;
      f.w = w0;
      f.h = h0;
      this.onNeedRender();
    } else if (effectiveTool === 'select') {
      this.handleSelectMove(wx, wy);
    }
  }

  private onPointerUp(e: PointerEvent) {
    if (e.pointerType === 'pen') this.penDown = false;
    this.activePointers.delete(e.pointerId);

    // End ruler drag modes
    this.rulerMouseMode = null;
    if (this.activePointers.size === 0) {
      this.rulerTouchMode = null;
      this.isPanning = false;
      this.lastTouchDist = 0;
    } else if (this.activePointers.size === 1) {
      // Transition from 2 fingers down to 1 finger
      const remaining = [...this.activePointers.values()][0];
      if (remaining.type === 'touch') {
        if (this.rulerTouchMode === 'two-touch') {
          this.rulerTouchMode = 'single';
          this.rulerDragStart = { x: remaining.x, y: remaining.y };
          this.rulerStartCenter = { x: this.ruler.state.x, y: this.ruler.state.y };
        } else {
          this.rulerTouchMode = null;
          this.isPanning = true;
          this.panStart = { x: remaining.x - this.camera.x, y: remaining.y - this.camera.y };
        }
      }
      this.lastTouchDist = 0;
    }

    if (this.eraserActive) {
      this.stopErasing();
    }

    if (this.activeDraft) {
      // If frame created, ensure minimum size
      if (this.activeDraft.type === 'frame') {
        if (this.activeDraft.w < 50 || this.activeDraft.h < 50) {
          this.activeDraft.w = 800;
          this.activeDraft.h = 600;
          this.activeDraft.x = this.dragStartWorld.x - 400;
          this.activeDraft.y = this.dragStartWorld.y - 300;
        }
      }
      if (this.activeDraft.type === 'stroke') {
        const finalStroke: StrokeObj = {
          ...this.activeDraft,
          pts: this.rawStrokePts.slice(),
        };
        this.scene.add([finalStroke]);
      } else {
        this.scene.add([this.activeDraft]);
      }
      this.activeDraft = null;
      this.rawStrokePts = [];
      this.onNeedRender();
    }

    if (this.dragMode === 'lasso') {
      if (this.lassoPoly && this.lassoPoly.length >= 6) {
        const poly = this.lassoPoly;
        this.selectedIds.clear();
        this.activeSelectionBox = null;
        for (const o of this.scene.objects) {
          if (o.locked) continue;
          const pts = samplePoints(o);
          let hit = false;
          for (let i = 0; i < pts.length; i += 2) {
            if (pointInPoly(pts[i], pts[i + 1], poly)) {
              hit = true;
              break;
            }
          }
          if (hit) {
            this.selectedIds.add(o.id);
          }
        }
        this.onSelectionChanged(this.selectedIds);
      }
      this.lassoPoly = null;
      this.dragMode = null;
      this.canvas.style.cursor = '';
      this.onNeedRender();
    } else if (this.dragMode) {
      if (this.dragMode === 'resize') {
        this.activeSelectionBox = null;
      }
      this.dragMode = null;
      this.activeHandle = null;
      this.rotAnchor = null;
      this.frameContainedIds.clear();
      this.canvas.style.cursor = '';
      this.scene.commit(this.scene.objects, this.transformInitialObjs);
      this.onNeedRender();
    }
  }

  private updateShapeDraft(wx: number, wy: number) {
    if (!this.activeDraft || this.activeDraft.type !== 'shape') return;
    const sh = this.activeDraft as ShapeObj;
    if (sh.kind === 'line' || sh.kind === 'arrow') {
      sh.pts = [this.dragStartWorld.x, this.dragStartWorld.y, wx, wy];
    } else {
      let dx = wx - this.dragStartWorld.x;
      let dy = wy - this.dragStartWorld.y;

      if (this.shapeTool === 'square' || this.shapeTool === 'circle') {
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        dx = dx >= 0 ? side : -side;
        dy = dy >= 0 ? side : -side;
        sh.x = dx >= 0 ? this.dragStartWorld.x : this.dragStartWorld.x - side;
        sh.y = dy >= 0 ? this.dragStartWorld.y : this.dragStartWorld.y - side;
        sh.w = Math.max(4, side);
        sh.h = Math.max(4, side);
      } else {
        sh.x = Math.min(this.dragStartWorld.x, wx);
        sh.y = Math.min(this.dragStartWorld.y, wy);
        sh.w = Math.max(4, Math.abs(dx));
        sh.h = Math.max(4, Math.abs(dy));
      }
    }
  }

  private startErasing(wx: number, wy: number) {
    this.eraserActive = true;
    this.eraserInitialObjs = [...this.scene.objects];
    this.lastEraserPoint = { x: wx, y: wy, time: performance.now() };
    this.eraserSpeed = 0;
    this.eraserStrokeDist = 0;
    this.currentScreenRadius = this.eraserBaseSize;

    const baseRadius = this.eraserBaseSize;
    const worldRadius = baseRadius / this.camera.zoom;
    this.eraserState = {
      active: true,
      x: wx,
      y: wy,
      radius: worldRadius,
    };

    const res = eraseObjectsAt(this.scene.objects, wx, wy, worldRadius);
    if (res.changed) {
      this.scene.transient(res.remaining);
      let selChanged = false;
      for (const id of this.selectedIds) {
        if (!res.remaining.some((o) => o.id === id)) {
          this.selectedIds.delete(id);
          selChanged = true;
        }
      }
      if (selChanged) this.onSelectionChanged(this.selectedIds);
    }
    this.onNeedRender();
  }

  private continueErasing(wx: number, wy: number, sx: number, sy: number) {
    if (!this.eraserActive) {
      this.startErasing(wx, wy);
      return;
    }

    const now = performance.now();
    const dt = Math.min(100, Math.max(1, now - this.lastEraserPoint.time));
    const lastScreenX = this.lastEraserPoint.x * this.camera.zoom + this.camera.x;
    const lastScreenY = this.lastEraserPoint.y * this.camera.zoom + this.camera.y;
    const dScreen = Math.hypot(sx - lastScreenX, sy - lastScreenY);

    // Accumulate total continuous stroke distance
    this.eraserStrokeDist += dScreen;

    // Filtered instant speed (px/ms)
    const instantSpeed = dScreen / dt;

    // Smooth speed over time (65ms time constant eliminates timestamp jitter from Windows pointer events)
    const speedAlpha = 1 - Math.exp(-dt / 65);
    this.eraserSpeed += (instantSpeed - this.eraserSpeed) * speedAlpha;

    // Speed factor: raised max-speed threshold to 2.8 px/ms (2800 px/s)
    const speedFactor = Math.min(1, Math.max(0, this.eraserSpeed / 2.8));

    // Stroke duration/distance factor: "Long solid strokes should lead to increased size"
    // Short scrub gestures (< 100px) stay compact; sustained strokes (> 380px) unlock full size
    const strokeFactor = Math.min(1, Math.max(0, this.eraserStrokeDist / 380));

    // Combined target size factor: baseline growth from speed (up to 30%), plus 70% from sustained stroke length
    const growth = speedFactor * (0.3 + 0.7 * strokeFactor);

    const baseRadius = this.eraserBaseSize;
    const maxRadius = this.eraserBaseSize * 3.5;
    const targetScreenRadius = baseRadius + (maxRadius - baseRadius) * growth;

    // Heavy exponential smoothing on radius itself to eliminate ANY jiggle / size jumping
    // 80ms relaxation gives buttery-smooth, organic expansion and contraction
    const radiusAlpha = 1 - Math.exp(-dt / 80);
    this.currentScreenRadius += (targetScreenRadius - this.currentScreenRadius) * radiusAlpha;

    const worldRadius = this.currentScreenRadius / this.camera.zoom;

    this.eraserState.active = true;
    this.eraserState.x = wx;
    this.eraserState.y = wy;
    this.eraserState.radius = worldRadius;

    // Interpolate steps along path so fast sweeps do not leave gaps
    const worldDist = Math.hypot(wx - this.lastEraserPoint.x, wy - this.lastEraserPoint.y);
    const stepSize = Math.max(3 / this.camera.zoom, worldRadius * 0.35);
    const steps = Math.max(1, Math.ceil(worldDist / stepSize));

    let changedAny = false;
    let currentObjs = this.scene.objects;

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const ix = this.lastEraserPoint.x + (wx - this.lastEraserPoint.x) * t;
      const iy = this.lastEraserPoint.y + (wy - this.lastEraserPoint.y) * t;
      const res = eraseObjectsAt(currentObjs, ix, iy, worldRadius);
      if (res.changed) {
        changedAny = true;
        currentObjs = res.remaining;
      }
    }

    if (changedAny) {
      this.scene.transient(currentObjs);
      let selChanged = false;
      for (const id of this.selectedIds) {
        if (!currentObjs.some((o) => o.id === id)) {
          this.selectedIds.delete(id);
          selChanged = true;
        }
      }
      if (selChanged) this.onSelectionChanged(this.selectedIds);
    }

    this.lastEraserPoint = { x: wx, y: wy, time: now };
    this.onNeedRender();
  }

  private stopErasing() {
    if (this.eraserActive) {
      this.eraserActive = false;
      this.eraserState.active = false;
      this.currentScreenRadius = 16;
      this.eraserSpeed = 0;
      this.eraserStrokeDist = 0;
      if (this.eraserInitialObjs) {
        if (this.scene.objects !== this.eraserInitialObjs) {
          this.scene.commit(this.scene.objects, this.eraserInitialObjs);
        }
        this.eraserInitialObjs = null;
      }
      this.onNeedRender();
    }
  }

  private updateSelectCursor(sx: number, sy: number) {
    if (this.dragMode || this.selectedIds.size === 0) {
      this.canvas.style.cursor = '';
      return;
    }
    const sf = selectionFrame(this.scene.objects, this.selectedIds);
    if (!sf || sf.locked) {
      this.canvas.style.cursor = '';
      return;
    }
    const currentBox = this.activeSelectionBox ?? sf.box;
    const [wx, wy] = this.screenToWorld(sx, sy);
    const tol = 12 / this.camera.zoom;
    const handles = handlePositions(currentBox, this.camera.zoom, sf.canRotate);

    // Check rotate handle first with generous hit radius
    if (sf.canRotate) {
      const rotEntry = handles.find(([h]) => h === 'rot');
      if (rotEntry && dist(wx, wy, rotEntry[1], rotEntry[2]) <= Math.max(tol * 1.5, 18 / this.camera.zoom)) {
        this.canvas.style.cursor = 'grab';
        return;
      }
    }

    for (const [h, hx, hy] of handles) {
      if (h === 'rot') continue;
      if (dist(wx, wy, hx, hy) <= tol) {
        if (h === 'nw' || h === 'se') {
          this.canvas.style.cursor = 'nwse-resize';
          return;
        }
        if (h === 'ne' || h === 'sw') {
          this.canvas.style.cursor = 'nesw-resize';
          return;
        }
        if (h === 'n' || h === 's') {
          this.canvas.style.cursor = 'ns-resize';
          return;
        }
        if (h === 'e' || h === 'w') {
          this.canvas.style.cursor = 'ew-resize';
          return;
        }
      }
    }
    this.canvas.style.cursor = '';
  }

  private handleSelectDown(wx: number, wy: number, sx: number, sy: number) {
    const tol = 12 / this.camera.zoom;
    const hadSelection = this.selectedIds.size > 0;

    // 1. Check hit on existing selection handles
    if (hadSelection) {
      const sf = selectionFrame(this.scene.objects, this.selectedIds);
      const currentBox = this.activeSelectionBox ?? sf?.box;
      if (sf && currentBox && !sf.locked) {
        const handles = handlePositions(currentBox, this.camera.zoom, sf.canRotate);

        // Check rotate handle FIRST with dedicated priority radius so resize handles never shadow it
        if (sf.canRotate) {
          const rotEntry = handles.find(([h]) => h === 'rot');
          if (rotEntry && dist(wx, wy, rotEntry[1], rotEntry[2]) <= Math.max(tol * 1.5, 18 / this.camera.zoom)) {
            this.activeHandle = 'rot';
            this.dragMode = 'rotate';
            this.canvas.style.cursor = 'grabbing';
            this.transformStartBox = { ...currentBox };
            const anchorX = currentBox.x + currentBox.w / 2;
            const anchorY = currentBox.y + currentBox.h / 2;
            this.rotAnchor = { x: anchorX, y: anchorY };
            this.rotStartPointerAngle = Math.atan2(wy - anchorY, wx - anchorX);
            this.rotStartBoxAngle = currentBox.rot || 0;
            this.transformInitialObjs = this.scene.objects.map((o) => ({ ...o }));
            this.dragStartWorld = { x: wx, y: wy };
            return;
          }
        }

        // Check resize handles
        for (const [h, hx, hy] of handles) {
          if (h === 'rot') continue;
          if (dist(wx, wy, hx, hy) <= tol) {
            this.activeHandle = h;
            this.dragMode = 'resize';
            this.transformStartBox = { ...currentBox };
            this.transformInitialObjs = this.scene.objects.map((o) => ({ ...o }));
            this.dragStartWorld = { x: wx, y: wy };
            return;
          }
        }
      }
    }

    // 2. Hit test objects in reverse render order (topmost first)
    let hit: Obj | null = null;
    for (let i = this.scene.objects.length - 1; i >= 0; i--) {
      const o = this.scene.objects[i];
      if (hitTest(o, wx, wy, tol, this.camera.zoom)) {
        hit = o;
        break;
      }
    }

    if (hit) {
      if (!this.selectedIds.has(hit.id)) {
        this.selectedIds.clear();
        this.activeSelectionBox = null;
        this.selectedIds.add(hit.id);
        this.onSelectionChanged(this.selectedIds);
      }
      this.dragMode = 'move';
      this.dragStartWorld = { x: wx, y: wy };
      this.transformInitialObjs = this.scene.objects.map((o) => ({ ...o }));

      // If any selected object is a frame, collect all objects inside it so they move together
      this.frameContainedIds.clear();
      for (const id of this.selectedIds) {
        const o = this.scene.get(id);
        if (o && o.type === 'frame') {
          const fBox = boxOf(o as any);
          for (const other of this.scene.objects) {
            if (!this.selectedIds.has(other.id) && insideFrame(other, fBox)) {
              this.frameContainedIds.add(other.id);
            }
          }
        }
      }
      this.onNeedRender();
      return;
    }

    // 3. Clicked empty space / outside selection:
    if (hadSelection) {
      // Any pen or mouse press OUTSIDE of an existing selection returns to draw/pen mode with the last selected color.
      this.clearSelection();
      this.frameContainedIds.clear();
      this.currentTool = 'pen';
      this.onToolChanged?.('pen');

      const pressure = 0.5;
      this.rawStrokePts = [wx, wy, pressure];
      this.activeDraft = {
        id: uid(),
        type: 'stroke',
        pts: this.rawStrokePts.slice(),
        color: this.penConfig.color,
        size: this.penConfig.size,
        highlighter: false,
        sim: true,
      };
      this.onNeedRender();
    } else {
      // In select mode without an existing selection: start lasso selection
      this.dragMode = 'lasso';
      this.lassoPoly = [wx, wy];
      this.onNeedRender();
    }
  }

  private handleSelectMove(wx: number, wy: number) {
    if (!this.dragMode) return;

    if (this.dragMode === 'move') {
      const dx = wx - this.dragStartWorld.x;
      const dy = wy - this.dragStartWorld.y;
      if (dx === 0 && dy === 0) return;

      if (this.activeSelectionBox) {
        this.activeSelectionBox = {
          ...this.activeSelectionBox,
          x: this.activeSelectionBox.x + dx,
          y: this.activeSelectionBox.y + dy,
        };
      }

      const movingIds = new Set([...this.selectedIds, ...this.frameContainedIds]);
      const updated = new Map<string, Obj>();
      for (const id of movingIds) {
        const o = this.scene.get(id);
        if (o && !o.locked) {
          updated.set(id, translateObj(o, dx, dy));
        }
      }
      this.dragStartWorld = { x: wx, y: wy };
      this.scene.transient(this.scene.objects.map((o) => updated.get(o.id) ?? o));
      this.onNeedRender();
      return;
    }

    if (this.dragMode === 'lasso') {
      if (!this.lassoPoly) this.lassoPoly = [];
      const len = this.lassoPoly.length;
      if (len >= 2) {
        const lx = this.lassoPoly[len - 2];
        const ly = this.lassoPoly[len - 1];
        if (Math.hypot(wx - lx, wy - ly) < 3 / this.camera.zoom) return;
      }
      this.lassoPoly.push(wx, wy);
      this.onNeedRender();
      return;
    }

    // Classic Rotate around Anchor Point (center of selection)
    if (this.dragMode === 'rotate') {
      if (!this.transformStartBox || !this.rotAnchor) return;
      const anchor = this.rotAnchor;
      const curAngle = Math.atan2(wy - anchor.y, wx - anchor.x);
      let dAngle = curAngle - this.rotStartPointerAngle;

      const totalAngle = normAngle(this.rotStartBoxAngle + dAngle);
      const snapInterval = Math.PI / 12; // 15 deg
      const nearestSnap = Math.round(totalAngle / snapInterval) * snapInterval;
      if (Math.abs(normAngle(totalAngle - nearestSnap)) < 0.05) {
        dAngle = nearestSnap - this.rotStartBoxAngle;
      }

      // Update the active selection box to rotate around the anchor point
      const newBoxRot = normAngle(this.rotStartBoxAngle + dAngle);
      this.activeSelectionBox = {
        ...this.transformStartBox,
        rot: newBoxRot,
      };

      const initMap = new Map(this.transformInitialObjs.map((o) => [o.id, o]));
      const next = this.scene.objects.map((o) => {
        if (!this.selectedIds.has(o.id) || o.locked) return o;
        const initObj = initMap.get(o.id) ?? o;

        // 1. Freehand Strokes: rotate each point around anchor (no dimension scaling!)
        if (initObj.type === 'stroke') {
          const pts = initObj.pts.slice();
          for (let i = 0; i < pts.length; i += 3) {
            const [nx, ny] = rotPt(pts[i], pts[i + 1], anchor.x, anchor.y, dAngle);
            pts[i] = nx;
            pts[i + 1] = ny;
          }
          return { ...initObj, pts };
        }

        // 2. Line / Arrow shapes: rotate line endpoints around anchor
        if (initObj.type === 'shape' && (initObj.kind === 'line' || initObj.kind === 'arrow' || initObj.pts)) {
          const pts = initObj.pts!.slice();
          for (let i = 0; i < pts.length; i += 2) {
            const [nx, ny] = rotPt(pts[i], pts[i + 1], anchor.x, anchor.y, dAngle);
            pts[i] = nx;
            pts[i + 1] = ny;
          }
          return { ...initObj, pts };
        }

        // 3. Box objects (Image, Shape, Sticky, Text):
        // Rotate its center around anchor, and rotate its own rot (w and h never change!)
        const b = boxOf(initObj as any);
        const initCx = b.x + b.w / 2;
        const initCy = b.y + b.h / 2;
        const [newCx, newCy] = rotPt(initCx, initCy, anchor.x, anchor.y, dAngle);
        const newRot = normAngle((b.rot || 0) + dAngle);
        return {
          ...initObj,
          x: newCx - b.w / 2,
          y: newCy - b.h / 2,
          rot: newRot,
        } as Obj;
      });

      this.scene.transient(next);
      this.onNeedRender();
      return;
    }

    if (this.dragMode === 'resize') {
      if (!this.transformStartBox || !this.activeHandle) return;
      const b = this.transformStartBox;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;

      // Transform world coords into unrotated local box coordinates
      const [curLx, curLy] = rotPt(wx, wy, cx, cy, -b.rot);
      const [startLx, startLy] = rotPt(this.dragStartWorld.x, this.dragStartWorld.y, cx, cy, -b.rot);
      const dlx = curLx - startLx;
      const dly = curLy - startLy;

      let x0 = b.x;
      let y0 = b.y;
      let x1 = b.x + b.w;
      let y1 = b.y + b.h;

      const h = this.activeHandle;
      if (h.includes('w')) x0 += dlx;
      if (h.includes('e')) x1 += dlx;
      if (h.includes('n')) y0 += dly;
      if (h.includes('s')) y1 += dly;

      const minDim = 20 / this.camera.zoom;
      if (x1 - x0 < minDim) {
        if (h.includes('w')) x0 = x1 - minDim;
        else x1 = x0 + minDim;
      }
      if (y1 - y0 < minDim) {
        if (h.includes('n')) y0 = y1 - minDim;
        else y1 = y0 + minDim;
      }

      const newW = x1 - x0;
      const newH = y1 - y0;
      const sx = newW / b.w;
      const sy = newH / b.h;

      const localMidX = (x0 + x1) / 2;
      const localMidY = (y0 + y1) / 2;
      const [newCx, newCy] = rotPt(localMidX, localMidY, cx, cy, b.rot);

      const M = compose(
        translate(newCx, newCy),
        rotateM(b.rot),
        scaleM(sx, sy),
        rotateM(-b.rot),
        translate(-cx, -cy),
      );
      const info: TransformInfo = { sx, sy, dAngle: 0, frameAngle: b.rot, scaling: true };

      const initMap = new Map(this.transformInitialObjs.map((o) => [o.id, o]));
      const next = this.scene.objects.map((o) => {
        if (!this.selectedIds.has(o.id) || o.locked) return o;
        const initial = initMap.get(o.id) ?? o;
        return transformObj(initial, M, info);
      });
      this.scene.transient(next);
      this.onNeedRender();
      return;
    }
  }

  private triggerRadialMenu(sx: number, sy: number) {
    this.radial.show(sx, sy, [
      { id: 'black', label: 'Black', color: '#1a202c', action: () => { this.currentTool = 'pen'; this.penConfig.color = '#1a202c'; } },
      { id: 'blue', label: 'Blue', color: '#2b6cb0', action: () => { this.currentTool = 'pen'; this.penConfig.color = '#2b6cb0'; } },
      { id: 'red', label: 'Red', color: '#e53e3e', action: () => { this.currentTool = 'pen'; this.penConfig.color = '#e53e3e'; } },
      { id: 'green', label: 'Green', color: '#38a169', action: () => { this.currentTool = 'pen'; this.penConfig.color = '#38a169'; } },
      { id: 'hl', label: 'Highlighter', color: '#ffd600', action: () => { this.currentTool = 'highlighter'; } },
      { id: 'eraser', label: 'Eraser', color: '#e2e8f0', action: () => { this.currentTool = 'eraser'; } },
      { id: 'select', label: 'Select', action: () => { this.currentTool = 'select'; } },
      { id: 'ruler', label: 'Ruler', action: () => { this.ruler.toggle(); } },
    ]);
    this.onNeedRender();
  }

  // Keyboard shortcuts
  private onKeyDown(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;

    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z') {
        e.preventDefault();
        this.scene.undo();
        this.onNeedRender();
      } else if (e.key === 'y') {
        e.preventDefault();
        this.scene.redo();
        this.onNeedRender();
      } else if (e.key === 'l') {
        // Toggle Lock on selection (Idea #8)
        e.preventDefault();
        this.toggleLockSelection();
      } else if (e.key === 'd') {
        // Duplicate selection
        e.preventDefault();
        this.duplicateSelection();
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selectedIds.size > 0) {
        e.preventDefault();
        this.deleteSelection();
      }
    }
  }

  deleteSelection() {
    if (this.selectedIds.size === 0) return;
    const selectedFrames = [...this.selectedIds]
      .map((id) => this.scene.get(id))
      .filter((o): o is FrameObj => o?.type === 'frame');

    if (selectedFrames.length > 0 && this.onPromptDeleteFrame) {
      this.onPromptDeleteFrame(
        () => this.executeDeleteSelection(false),
        () => this.executeDeleteSelection(true),
      );
    } else {
      this.executeDeleteSelection(false);
    }
  }

  private executeDeleteSelection(deleteContained: boolean) {
    if (this.selectedIds.size === 0) return;
    const toDelete = new Set<string>(this.selectedIds);
    if (deleteContained) {
      for (const id of this.selectedIds) {
        const o = this.scene.get(id);
        if (o && o.type === 'frame') {
          const fBox = boxOf(o as any);
          for (const other of this.scene.objects) {
            if (insideFrame(other, fBox)) {
              toDelete.add(other.id);
            }
          }
        }
      }
    }
    this.scene.remove(toDelete);
    this.selectedIds.clear();
    this.activeSelectionBox = null;
    this.onSelectionChanged(this.selectedIds);
    this.onNeedRender();
  }

  toggleLockSelection() {
    const updated = new Map<string, Obj>();
    for (const id of this.selectedIds) {
      const o = this.scene.get(id);
      if (o) updated.set(id, { ...o, locked: !o.locked });
    }
    this.scene.update(updated);
    this.onNeedRender();
  }

  duplicateSelection() {
    const toAdd: Obj[] = [];
    const newIds = new Set<string>();
    for (const id of this.selectedIds) {
      const o = this.scene.get(id);
      if (o) {
        const copy = translateObj({ ...o, id: uid() }, 30, 30);
        toAdd.push(copy);
        newIds.add(copy.id);
      }
    }
    this.scene.add(toAdd);
    this.selectedIds = newIds;
    this.activeSelectionBox = null;
    this.onSelectionChanged(this.selectedIds);
    this.onNeedRender();
  }

  // Clipboard Paste (Ctrl+V)
  private async onPaste(e: ClipboardEvent) {
    if (e.clipboardData && e.clipboardData.items) {
      for (const item of e.clipboardData.items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            const buf = await file.arrayBuffer();
            await this.insertImageBytes(new Uint8Array(buf), item.type, 'pasted_image');
            return;
          }
        }
      }
    }

    // Fallback: Read native clipboard via Tauri arboard
    try {
      const bytes = await invoke<number[]>('clipboard_read_image');
      if (bytes && bytes.length > 0) {
        await this.insertImageBytes(new Uint8Array(bytes), 'image/png', 'clipboard_image');
      }
    } catch {
      /* ignore */
    }
  }

  // Drag & drop files or web images
  private async onDrop(e: DragEvent) {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.type.startsWith('image/')) {
          const buf = await file.arrayBuffer();
          await this.insertImageBytes(new Uint8Array(buf), file.type, file.name);
        } else if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
          const buf = await file.arrayBuffer();
          await this.insertPdfBytes(new Uint8Array(buf), file.name);
        }
      }
      return;
    }

    // Browser drag (URL)
    const url = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      try {
        const bytes = await invoke<number[]>('fetch_url', { url });
        if (bytes && bytes.length > 0) {
          await this.insertImageBytes(new Uint8Array(bytes), 'image/png', 'downloaded_image');
        }
      } catch (err) {
        console.error('Failed to download dropped image:', err);
      }
    }
  }

  async insertImageBytes(bytes: Uint8Array, mime: string, name: string) {
    const asset = this.assets.add(bytes, mime, name);
    const img = await this.assets.imageAsync(asset.id);
    const nw = 'naturalWidth' in img ? img.naturalWidth : img.width;
    const nh = 'naturalHeight' in img ? img.naturalHeight : img.height;

    // Center in current view
    const vpCenterX = (-this.camera.x + this.canvas.width / 2) / this.camera.zoom;
    const vpCenterY = (-this.camera.y + this.canvas.height / 2) / this.camera.zoom;

    const maxDim = 600;
    const scale = Math.min(1, maxDim / Math.max(nw, nh));
    const w = nw * scale;
    const h = nh * scale;

    const imgObj: ImageObj = {
      id: uid(),
      type: 'image',
      asset: asset.id,
      x: vpCenterX - w / 2,
      y: vpCenterY - h / 2,
      w,
      h,
      rot: 0,
    };

    this.scene.add([imgObj]);
    this.selectedIds.clear();
    this.selectedIds.add(imgObj.id);
    this.onSelectionChanged(this.selectedIds);
    this.onNeedRender();
  }

  async insertPdfBytes(bytes: Uint8Array, name: string) {
    const asset = this.assets.add(bytes, 'application/pdf', name);
    const info = await this.assets.pageInfo(asset.id);

    let curY = (-this.camera.y + 80) / this.camera.zoom;
    const curX = (-this.camera.x + this.canvas.width / 2) / this.camera.zoom;
    const objs: PdfPageObj[] = [];

    // Place pages vertically with neat margin
    for (let i = 0; i < info.count; i++) {
      const size = await info.sizes(i);
      const w = size.w * PT;
      const h = size.h * PT;

      objs.push({
        id: uid(),
        type: 'pdfpage',
        asset: asset.id,
        page: i,
        pw: size.w,
        ph: size.h,
        x: curX - w / 2,
        y: curY,
        w,
        h,
        rot: 0,
        locked: true, // Default to locked so users can write directly on top! (Idea #8)
      });
      curY += h + 30;
    }

    this.scene.add(objs);
    this.onNeedRender();
  }
}
