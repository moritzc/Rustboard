export type Tool =
  | 'select'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'shape'
  | 'text'
  | 'sticky'
  | 'frame'
  | 'laser'
  | 'fading';

export type ShapeKind = 'rect' | 'ellipse' | 'triangle' | 'diamond' | 'line' | 'arrow' | 'polygon';
/** What the shape tool draws (square / circle are aspect-locked rect / ellipse). */
export type ShapeTool = 'square' | 'rect' | 'circle' | 'ellipse' | 'triangle' | 'diamond' | 'line';
export type LineDash = 'solid' | 'dashed' | 'dotted';
export type SelectMode = 'lasso' | 'rect';
export type FontKey = 'sans' | 'hand' | 'serif' | 'mono';
export type Pattern = 'none' | 'dots' | 'grid' | 'lines';
export type InkingSmoothing = 'raw' | 'balanced' | 'smooth';

interface Base {
  id: string;
  locked?: boolean;
}

/** Freehand ink. pts = [x, y, pressure, x, y, pressure, ...] in world units. */
export interface StrokeObj extends Base {
  type: 'stroke';
  pts: number[];
  color: string;
  size: number;
  highlighter?: boolean;
  /** simulate pressure (mouse / touch input) */
  sim?: boolean;
}

/** Box geometry: (x,y) = top-left of the unrotated box, rotation around its centre. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

export interface ShapeObj extends Base, Box {
  type: 'shape';
  kind: ShapeKind;
  /** line/arrow: [x1,y1,x2,y2]; polygon: [x,y,...] (world coords). Box unused for those. */
  pts?: number[];
  color: string;
  width: number;
  fill?: string | null;
  /** stroke style (default solid) */
  dash?: LineDash;
  /** arrowheads for line shapes (kind 'arrow' implies arrowEnd) */
  arrowStart?: boolean;
  arrowEnd?: boolean;
}

export interface TextObj extends Base, Box {
  type: 'text';
  text: string;
  fontSize: number;
  color: string;
  font: FontKey;
  bold?: boolean;
  italic?: boolean;
}

export interface StickyObj extends Base, Box {
  type: 'sticky';
  text: string;
  color: string;
  fontSize: number;
}

export interface ImageObj extends Base, Box {
  type: 'image';
  asset: string;
  /** normalised crop rect of the source image */
  crop?: { x: number; y: number; w: number; h: number };
}

export interface PdfPageObj extends Base, Box {
  type: 'pdfpage';
  asset: string;
  page: number;
  /** displayed page size in PDF points (rotation + crop box applied) */
  pw: number;
  ph: number;
}

export interface FrameObj extends Base, Box {
  type: 'frame';
  name: string;
}

export type Obj = StrokeObj | ShapeObj | TextObj | StickyObj | ImageObj | PdfPageObj | FrameObj;
export type BoxObj = Exclude<Obj, StrokeObj>;

export interface BoardSettings {
  pattern: Pattern;
  dark: boolean;
  smoothing?: InkingSmoothing;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export const isPtsShape = (o: Obj): o is ShapeObj =>
  o.type === 'shape' && (o.kind === 'line' || o.kind === 'arrow' || o.kind === 'polygon');

let idCounter = 0;
export function uid(): string {
  idCounter = (idCounter + 1) % 1e6;
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + idCounter.toString(36);
}

/** World units per PDF point (1pt = 1/72in, world unit = CSS px = 1/96in). */
export const PT = 96 / 72;
