import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { uid } from './types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type PDFDoc = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;

export interface Asset {
  id: string;
  mime: string;
  name: string;
  bytes: Uint8Array;
}

type Img = ImageBitmap | HTMLImageElement;

interface PageEntry {
  canvas: HTMLCanvasElement;
  scale: number;
  used: number;
}

const PAGE_PIXEL_BUDGET = 90e6; // ~360 MB of page bitmaps
const SCALE_BUCKETS = [0.75, 1.5, 2.5, 4, 6];

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export class Assets {
  map = new Map<string, Asset>();
  private images = new Map<string, Img>();
  private loading = new Set<string>();
  private pdfDocs = new Map<string, Promise<PDFDoc>>();
  private pages = new Map<string, PageEntry>();
  private queue = new Map<string, number>();
  private working = false;
  private dataUrls = new Map<string, string>();

  constructor(private onUpdate: () => void) {}

  add(bytes: Uint8Array, mime: string, name: string, id = uid()): Asset {
    // de-duplicate identical payloads
    for (const a of this.map.values()) {
      if (a.bytes.length === bytes.length && a.mime === mime && equalBytes(a.bytes, bytes)) return a;
    }
    const a = { id, mime, name, bytes };
    this.map.set(id, a);
    return a;
  }

  get(id: string) {
    return this.map.get(id);
  }

  clear() {
    this.map.clear();
    this.images.forEach((i) => 'close' in i && i.close());
    this.images.clear();
    this.loading.clear();
    this.pdfDocs.forEach((p) => p.then((d) => d.destroy()).catch(() => {}));
    this.pdfDocs.clear();
    this.pages.clear();
    this.queue.clear();
    this.dataUrls.clear();
  }

  /** Remove assets that are not referenced anymore (call before saving). */
  used(ids: Set<string>): Asset[] {
    return [...this.map.values()].filter((a) => ids.has(a.id));
  }

  // ---------- images ----------
  image(id: string): Img | undefined {
    const img = this.images.get(id);
    if (img) return img;
    if (!this.loading.has(id)) {
      const a = this.map.get(id);
      if (a) {
        this.loading.add(id);
        decodeImage(a)
          .then((im) => {
            this.images.set(id, im);
            this.onUpdate();
          })
          .catch((e) => console.error('image decode failed', e))
          .finally(() => this.loading.delete(id));
      }
    }
    return undefined;
  }

  async imageAsync(id: string): Promise<Img> {
    const ex = this.images.get(id);
    if (ex) return ex;
    const a = this.map.get(id);
    if (!a) throw new Error('missing asset');
    const im = await decodeImage(a);
    this.images.set(id, im);
    return im;
  }

  dataUrl(id: string): string {
    let u = this.dataUrls.get(id);
    if (!u) {
      const a = this.map.get(id)!;
      u = `data:${a.mime};base64,${bytesToBase64(a.bytes)}`;
      this.dataUrls.set(id, u);
    }
    return u;
  }

  // ---------- PDFs ----------
  pdf(id: string): Promise<PDFDoc> {
    let p = this.pdfDocs.get(id);
    if (!p) {
      const a = this.map.get(id);
      if (!a) return Promise.reject(new Error('missing pdf asset'));
      p = pdfjs.getDocument({ data: a.bytes.slice(), isEvalSupported: false }).promise;
      this.pdfDocs.set(id, p);
    }
    return p;
  }

  /**
   * Returns the best available bitmap for a PDF page and schedules a sharper
   * re-render if the requested scale is higher than what is cached.
   */
  pageBitmap(asset: string, page: number, wantScale: number): PageEntry | undefined {
    const key = `${asset}:${page}`;
    const e = this.pages.get(key);
    const bucket = SCALE_BUCKETS.find((b) => b >= wantScale) ?? SCALE_BUCKETS[SCALE_BUCKETS.length - 1];
    if (e) e.used = performance.now();
    if (!e || e.scale < bucket) {
      const q = this.queue.get(key);
      if (q === undefined || q < bucket) {
        this.queue.set(key, bucket);
        this.pump();
      }
    }
    return e;
  }

  private async pump() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.size) {
        // newest request first
        const [key, scale] = [...this.queue.entries()].pop()!;
        this.queue.delete(key);
        const [asset, pageStr] = key.split(':');
        const ex = this.pages.get(key);
        if (ex && ex.scale >= scale) continue;
        try {
          const canvas = await this.renderPage(asset, +pageStr, scale);
          this.pages.set(key, { canvas, scale, used: performance.now() });
          this.evict();
          this.onUpdate();
        } catch (err) {
          console.error('pdf render failed', err);
        }
      }
    } finally {
      this.working = false;
    }
  }

  private evict() {
    let total = 0;
    const entries = [...this.pages.entries()].sort((a, b) => b[1].used - a[1].used);
    for (const [k, e] of entries) {
      total += e.canvas.width * e.canvas.height;
      if (total > PAGE_PIXEL_BUDGET) {
        e.canvas.width = e.canvas.height = 0;
        this.pages.delete(k);
      }
    }
  }

  async renderPage(asset: string, page: number, scale: number): Promise<HTMLCanvasElement> {
    const doc = await this.pdf(asset);
    const p = await doc.getPage(page + 1);
    let vp = p.getViewport({ scale });
    const maxPx = 24e6;
    if (vp.width * vp.height > maxPx) vp = p.getViewport({ scale: scale * Math.sqrt(maxPx / (vp.width * vp.height)) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await p.render({ canvasContext: ctx, viewport: vp }).promise;
    return canvas;
  }

  async pageInfo(asset: string): Promise<{ count: number; sizes: (page: number) => Promise<{ w: number; h: number }> }> {
    const doc = await this.pdf(asset);
    return {
      count: doc.numPages,
      sizes: async (page: number) => {
        const p = await doc.getPage(page + 1);
        const vp = p.getViewport({ scale: 1 });
        return { w: vp.width, h: vp.height };
      },
    };
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  // sample compare first then full
  for (let i = 0; i < a.length; i += 997) if (a[i] !== b[i]) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function decodeImage(a: Asset): Promise<Img> {
  const blob = new Blob([a.bytes as BlobPart], { type: a.mime });
  if (a.mime !== 'image/svg+xml') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall through */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function imgSize(i: Img): { w: number; h: number } {
  return 'naturalWidth' in i ? { w: i.naturalWidth || 300, h: i.naturalHeight || 200 } : { w: i.width, h: i.height };
}
