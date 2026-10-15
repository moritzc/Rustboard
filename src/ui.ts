import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { Assets } from './assets';
import { exportAnnotatedPdfRoundTrip, exportPdf, exportToSvg } from './export';
import { loadBoard, saveBoard } from './file_io';
import type { InputManager } from './input';
import type { Minimap } from './minimap';
import { bboxOf, selectionFrame, textHeight } from './objects';
import type { Ruler } from './ruler';
import type { Scene } from './scene';
import type { BoardSettings, Camera, FrameObj, LineDash, ShapeKind, ShapeTool, TextObj, Tool } from './types';
import { uid } from './types';
import { layoutText } from './textlayout';

function escapeXml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class UIManager {
  private currentFilePath: string | null = null;

  constructor(
    private container: HTMLElement,
    private input: InputManager,
    private scene: Scene,
    private assets: Assets,
    private camera: Camera,
    private settings: BoardSettings,
    private ruler: Ruler,
    private minimap: Minimap,
    private onNeedRender: () => void,
  ) {
    this.renderUI();
  }

  renderUI() {
    this.container.innerHTML = `
      <!-- Top Left Bar -->
      <div class="floating-panel top-bar">
        <span class="title">Rustboard</span>
        <div class="divider"></div>
        <button class="tool-btn" id="btn-new" title="New Board">
          <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
        </button>
        <button class="tool-btn" id="btn-open" title="Open .rboard">
          <svg viewBox="0 0 24 24"><path d="M4 19V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>
        </button>
        <button class="tool-btn" id="btn-save" title="Save .rboard (Ctrl+S)">
          <svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
        </button>
        <div class="divider"></div>
        <button class="tool-btn" id="btn-undo" title="Undo (Ctrl+Z)">
          <svg viewBox="0 0 24 24"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
        </button>
        <button class="tool-btn" id="btn-redo" title="Redo (Ctrl+Y)">
          <svg viewBox="0 0 24 24"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>
        </button>
      </div>

      <!-- Top Right Bar -->
      <div class="floating-panel top-tools">
        <button class="tool-btn" id="btn-frames" title="Frames / Pages navigator">
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>
        </button>
        <button class="tool-btn" id="btn-export" title="Export (PDF / SVG / PNG)">
          <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button class="tool-btn" id="btn-settings" title="Board Settings">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>

      <!-- Pen Tray (Centered Bottom) -->
      <div class="floating-panel pen-tray">
        <button class="tool-btn active" data-tool="pen" data-color="#1a202c" title="Black Pen">
          <svg viewBox="0 0 24 24"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>
          <div class="pen-indicator" style="background: #1a202c;"></div>
        </button>
        <button class="tool-btn" data-tool="pen" data-color="#2563eb" title="Blue Pen">
          <svg viewBox="0 0 24 24"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>
          <div class="pen-indicator" style="background: #2563eb;"></div>
        </button>
        <button class="tool-btn" data-tool="pen" data-color="#dc2626" title="Red Pen">
          <svg viewBox="0 0 24 24"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>
          <div class="pen-indicator" style="background: #dc2626;"></div>
        </button>
        <button class="tool-btn" data-tool="pen" data-color="#16a34a" title="Green Pen">
          <svg viewBox="0 0 24 24"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>
          <div class="pen-indicator" style="background: #16a34a;"></div>
        </button>
        <button class="tool-btn" data-tool="highlighter" title="Highlighter (Click again for options)">
          <svg viewBox="0 0 24 24"><path d="m9 11-6 6v3h3l6-6"/><path d="m22 2-7.5 7.5L12 7l7.5-7.5z"/></svg>
          <div class="pen-indicator" style="background: #ffd600;"></div>
        </button>
        <button class="tool-btn" data-tool="eraser" title="Eraser (Click again for size)">
          <svg viewBox="0 0 24 24"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>
        </button>
        <div class="divider"></div>
        <!-- Select & Lasso Tool with proper marquee & lasso icon -->
        <button class="tool-btn" data-tool="select" id="btn-select" title="Select & Lasso (Draw loop or click items)">
          <svg viewBox="0 0 24 24">
            <path d="M4 4h3v2H6v1h-2V4zm7 0h2v2h-2V4zm5 0h3v3h-2V6h-1V4zM4 9h2v2H4V9zm14 0h2v2h-2V9zM4 14h2v2H4v-2zm14 0h2v2h-2v-2zM4 17h2v1h1v2H4v-3zm7 1h2v2h-2v-2zm5 0h1v-1h2v3h-3v-2z"/>
            <polygon points="9,9 19,13 14,15 12,20" fill="currentColor"/>
          </svg>
        </button>
        <!-- Dedicated Shape Button with Popover -->
        <button class="tool-btn" data-tool="shape" id="btn-shape" title="Shapes (Square, Circle, Triangle, Line, Arrows...)">
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1"/><circle cx="16.5" cy="7.5" r="4"/><polygon points="12,21 17,13 7,13"/></svg>
        </button>
        <!-- Typed Text Tool -->
        <button class="tool-btn" data-tool="text" id="btn-tool-text" title="Typed Text (T) - Bold, Italic & Font Size">
          <svg viewBox="0 0 24 24"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>
        </button>
        <button class="tool-btn" id="btn-ruler" title="Ruler / Protractor">
          <svg viewBox="0 0 24 24"><path d="M21.3 8.7 8.7 21.3c-1 1-2.5 1-3.4 0l-2.6-2.6c-1-1-1-2.5 0-3.4L15.3 2.7c1-1 2.5-1 3.4 0l2.6 2.6c1 1 1 2.5 0 3.4Z"/><path d="m14.5 5.5 2 2"/><path d="m11.5 8.5 2 2"/><path d="m8.5 11.5 2 2"/><path d="m5.5 14.5 2 2"/></svg>
        </button>
        <button class="tool-btn" data-tool="laser" title="Laser Pointer">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>
        </button>
        <button class="tool-btn" data-tool="frame" title="Frame / Page">
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 4"/></svg>
        </button>
        <div class="divider"></div>
        <button class="tool-btn" id="btn-insert-img" title="Insert Image">
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        </button>
        <button class="tool-btn" id="btn-insert-pdf" title="Insert PDF">
          <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        </button>
      </div>

      <!-- Floating Selection Toolbar (Trash, Duplicate, Lock, plus Text Formatting) -->
      <div class="floating-panel selection-toolbar" id="selection-toolbar" style="display: none;">
        <button class="tool-btn btn-danger" id="btn-sel-delete" title="Delete selected (Delete / Backspace)">
          <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        </button>
        <div class="divider"></div>
        <button class="tool-btn" id="btn-sel-dup" title="Duplicate (Ctrl+D)">
          <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="tool-btn" id="btn-sel-lock" title="Lock / Unlock (Ctrl+L)">
          <svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </button>
        <!-- Text Specific formatting controls (shown when a text object is selected) -->
        <div class="text-format-group" id="sel-text-format" style="display: none; align-items: center; gap: 4px;">
          <div class="divider"></div>
          <button class="tool-btn format-btn" id="btn-sel-bold" title="Toggle Bold" style="font-weight: 800; font-size: 15px;">B</button>
          <button class="tool-btn format-btn" id="btn-sel-italic" title="Toggle Italic" style="font-style: italic; font-weight: 600; font-size: 15px;">I</button>
          <button class="tool-btn format-btn" id="btn-sel-font-down" title="Decrease Font Size" style="font-size: 13px; font-weight: 700;">A-</button>
          <span id="sel-font-size-val" style="font-size: 12px; font-weight: 600; min-width: 28px; text-align: center;">24</span>
          <button class="tool-btn format-btn" id="btn-sel-font-up" title="Increase Font Size" style="font-size: 13px; font-weight: 700;">A+</button>
          <button class="tool-btn format-btn" id="btn-sel-edit-text" title="Edit Text Content">
            <svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
        </div>
      </div>

      <!-- Bottom Right Zoom Controls -->
      <div class="floating-panel zoom-controls">
        <button class="tool-btn" id="btn-zoom-out" title="Zoom Out">
          <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <span class="zoom-text" id="zoom-val">100%</span>
        <button class="tool-btn" id="btn-zoom-in" title="Zoom In">
          <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="tool-btn" id="btn-zoom-fit" title="Zoom to Fit">
          <svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
        </button>
      </div>
    `;

    this.bindUIEvents();
    this.updateZoomDisplay();
  }

  private bindUIEvents() {
    // Pen Tray Tool selection
    const buttons = this.container.querySelectorAll<HTMLButtonElement>('[data-tool]');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool as Tool;
        const wasActive = btn.classList.contains('active');
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        if (btn.dataset.color) {
          this.input.penConfig.color = btn.dataset.color;
        }
        this.input.setTool(tool);
        if (tool === 'shape') {
          this.toggleShapePopover(btn);
        } else if (tool === 'eraser' && wasActive) {
          this.toggleEraserPopover(btn);
        } else if (wasActive && (tool === 'pen' || tool === 'highlighter')) {
          this.togglePenPopover(btn);
        }
      });
      if (btn.dataset.tool === 'eraser') {
        btn.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.toggleEraserPopover(btn);
        });
      }
    });

    // Wire input callbacks
    this.input.onToolChanged = (tool) => {
      buttons.forEach((b) => {
        if (b.dataset.tool !== tool) {
          b.classList.remove('active');
        } else if (tool === 'pen') {
          const curColor = (this.input.penConfig.color || '').toLowerCase();
          const btnColor = (b.dataset.color || '').toLowerCase();
          b.classList.toggle('active', btnColor === curColor);
        } else {
          b.classList.add('active');
        }
      });
      if (tool === 'pen') {
        const hasActivePen = Array.from(buttons).some(
          (b) => b.dataset.tool === 'pen' && b.classList.contains('active'),
        );
        if (!hasActivePen) {
          const firstPen = this.container.querySelector<HTMLButtonElement>('[data-tool="pen"]');
          firstPen?.classList.add('active');
        }
      }
      this.updateSelectionToolbar();
    };

    this.input.onEditText = (obj, isNew) => {
      this.openInlineTextEditor(obj, isNew);
    };

    this.input.onPromptDeleteFrame = (onOnly, onAll) => {
      this.showFrameDeleteDialog(onOnly, onAll);
    };

    // New Board button
    this.container.querySelector('#btn-new')?.addEventListener('click', () => {
      if (this.scene.dirty && this.scene.objects.length > 0) {
        this.showConfirmDialog(
          'Start Fresh?',
          'You have unsaved changes on the current board. Starting fresh will discard any unsaved work.',
          'Start Fresh',
          () => this.newBoard(),
        );
      } else {
        this.newBoard();
      }
    });

    // Selection Toolbar events (Trash, Duplicate, Lock)
    this.container.querySelector('#btn-sel-delete')?.addEventListener('click', () => {
      this.input.deleteSelection();
      this.updateSelectionToolbar();
    });
    this.container.querySelector('#btn-sel-dup')?.addEventListener('click', () => {
      this.input.duplicateSelection();
      this.updateSelectionToolbar();
    });
    this.container.querySelector('#btn-sel-lock')?.addEventListener('click', () => {
      this.input.toggleLockSelection();
      this.updateSelectionToolbar();
    });

    // Selection Toolbar Text Formatting
    this.container.querySelector('#btn-sel-bold')?.addEventListener('click', () => {
      this.toggleSelectedTextBold();
    });
    this.container.querySelector('#btn-sel-italic')?.addEventListener('click', () => {
      this.toggleSelectedTextItalic();
    });
    this.container.querySelector('#btn-sel-font-down')?.addEventListener('click', () => {
      this.changeSelectedTextFontSize(-4);
    });
    this.container.querySelector('#btn-sel-font-up')?.addEventListener('click', () => {
      this.changeSelectedTextFontSize(4);
    });
    this.container.querySelector('#btn-sel-edit-text')?.addEventListener('click', () => {
      const selectedObj = this.getSingleSelectedText();
      if (selectedObj) {
        this.openInlineTextEditor(selectedObj, false);
      }
    });

    // Ruler toggle
    const btnRuler = this.container.querySelector('#btn-ruler');
    btnRuler?.addEventListener('click', () => {
      this.ruler.toggle();
      btnRuler.classList.toggle('active', this.ruler.state.enabled);
      this.onNeedRender();
    });

    // Undo / Redo
    this.container.querySelector('#btn-undo')?.addEventListener('click', () => {
      this.scene.undo();
      this.onNeedRender();
    });
    this.container.querySelector('#btn-redo')?.addEventListener('click', () => {
      this.scene.redo();
      this.onNeedRender();
    });

    // Zoom buttons
    this.container.querySelector('#btn-zoom-in')?.addEventListener('click', () => {
      this.zoomBy(1.2);
    });
    this.container.querySelector('#btn-zoom-out')?.addEventListener('click', () => {
      this.zoomBy(0.8);
    });
    this.container.querySelector('#zoom-val')?.addEventListener('click', () => {
      this.camera.zoom = 1;
      this.updateZoomDisplay();
      this.onNeedRender();
    });
    this.container.querySelector('#btn-zoom-fit')?.addEventListener('click', () => {
      this.zoomToFit();
    });

    // File Operations
    this.container.querySelector('#btn-save')?.addEventListener('click', () => this.handleSave());
    this.container.querySelector('#btn-open')?.addEventListener('click', () => this.handleOpen());

    // Insert Image
    this.container.querySelector('#btn-insert-img')?.addEventListener('click', async () => {
      const selected = await open({
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'svg'] }],
      });
      if (selected && typeof selected === 'string') {
        const bytes = await invoke<number[]>('read_file', { path: selected });
        const name = selected.split(/[\\/]/).pop() || 'image';
        await this.input.insertImageBytes(new Uint8Array(bytes), 'image/png', name);
      }
    });

    // Insert PDF
    this.container.querySelector('#btn-insert-pdf')?.addEventListener('click', async () => {
      const selected = await open({
        filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
      });
      if (selected && typeof selected === 'string') {
        const bytes = await invoke<number[]>('read_file', { path: selected });
        const name = selected.split(/[\\/]/).pop() || 'document.pdf';
        await this.input.insertPdfBytes(new Uint8Array(bytes), name);
      }
    });

    // Export Dialog
    this.container.querySelector('#btn-export')?.addEventListener('click', () => this.showExportDialog());

    // Settings Dialog
    this.container.querySelector('#btn-settings')?.addEventListener('click', () => this.showSettingsDialog());

    // Frames list
    this.container.querySelector('#btn-frames')?.addEventListener('click', () => this.showFramesDialog());
  }

  updateZoomDisplay() {
    const el = this.container.querySelector('#zoom-val');
    if (el) el.textContent = `${Math.round(this.camera.zoom * 100)}%`;
    this.updateSelectionToolbar();
  }

  private zoomBy(factor: number) {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const newZoom = Math.max(0.08, Math.min(15, this.camera.zoom * factor));
    this.camera.x = cx - (cx - this.camera.x) * (newZoom / this.camera.zoom);
    this.camera.y = cy - (cy - this.camera.y) * (newZoom / this.camera.zoom);
    this.camera.zoom = newZoom;
    this.updateZoomDisplay();
    this.onNeedRender();
  }

  private zoomToFit() {
    if (this.scene.objects.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of this.scene.objects) {
      const b = bboxOf(o);
      if (b[0] < minX) minX = b[0];
      if (b[1] < minY) minY = b[1];
      if (b[2] > maxX) maxX = b[2];
      if (b[3] > maxY) maxY = b[3];
    }
    const pad = 60;
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2;
    const scale = Math.min((window.innerWidth - 100) / w, (window.innerHeight - 100) / h);
    this.camera.zoom = Math.max(0.1, Math.min(3, scale));
    this.camera.x = window.innerWidth / 2 - ((minX + maxX) / 2) * this.camera.zoom;
    this.camera.y = window.innerHeight / 2 - ((minY + maxY) / 2) * this.camera.zoom;
    this.updateZoomDisplay();
    this.onNeedRender();
  }

  async handleSave(): Promise<boolean> {
    if (!this.currentFilePath) {
      const selected = await save({
        filters: [{ name: 'Rustboard Board', extensions: ['rboard'] }],
        defaultPath: 'Board.rboard',
      });
      if (selected && typeof selected === 'string') {
        this.currentFilePath = selected;
      } else {
        return false;
      }
    }
    await saveBoard(this.scene, this.assets, this.camera, this.settings, this.currentFilePath);
    return true;
  }

  private async handleOpen() {
    const selected = await open({
      filters: [{ name: 'Rustboard Board', extensions: ['rboard'] }],
    });
    if (selected && typeof selected === 'string') {
      const res = await loadBoard(selected, this.scene, this.assets);
      this.currentFilePath = selected;
      this.input.selectedIds.clear();
      this.input.activeSelectionBox = null;
      Object.assign(this.camera, res.camera);
      Object.assign(this.settings, res.settings);
      document.body.classList.toggle('dark', this.settings.dark);
      this.updateZoomDisplay();
      this.onNeedRender();
    }
  }

  private showExportDialog() {
    const frames = this.scene.objects.filter((o): o is FrameObj => o.type === 'frame');
    const pdfPages = this.scene.objects.filter((o) => o.type === 'pdfpage');

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-box">
        <div class="modal-header">
          <div class="modal-title">Export Whiteboard</div>
          <button class="modal-close">&times;</button>
        </div>
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 16px;">
          Choose your export format. All PDF and SVG exports are 100% true vector graphics.
        </p>

        ${frames.length > 0 ? `
          <button class="modal-btn btn-primary" id="exp-pdf-frames">
            Export Frame Pages as Vector PDF (${frames.length} Pages)
          </button>
          <button class="modal-btn btn-secondary" id="exp-pdf-entire">
            Export Entire Board as Vector PDF (Hide frame borders)
          </button>
        ` : `
          <button class="modal-btn btn-primary" id="exp-pdf-entire">
            Export Entire Board as Vector PDF
          </button>
        `}

        ${
          pdfPages.length > 0
            ? `<button class="modal-btn btn-secondary" id="exp-roundtrip">
                 PDF Round-Trip (Stamp annotations on original PDF)
               </button>`
            : ''
        }

        <button class="modal-btn btn-secondary" id="exp-svg">
          Export as Vector SVG
        </button>

        <button class="modal-btn btn-secondary" id="exp-clip">
          Copy Board to Clipboard (PNG)
        </button>
      </div>
    `;

    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.modal-close')?.addEventListener('click', close);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });

    // Vector PDF (Frames)
    modal.querySelector('#exp-pdf-frames')?.addEventListener('click', async () => {
      close();
      const path = await save({
        filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
        defaultPath: 'Rustboard_Pages.pdf',
      });
      if (path && typeof path === 'string') {
        await exportPdf(this.scene.objects, this.assets, path, frames, this.settings.dark);
      }
    });

    // Vector PDF (Entire Board)
    modal.querySelector('#exp-pdf-entire')?.addEventListener('click', async () => {
      close();
      const path = await save({
        filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
        defaultPath: 'Rustboard_Board.pdf',
      });
      if (path && typeof path === 'string') {
        await exportPdf(this.scene.objects, this.assets, path, null, this.settings.dark);
      }
    });

    // PDF Round-trip (Idea #5)
    modal.querySelector('#exp-roundtrip')?.addEventListener('click', async () => {
      close();
      const firstPdf = pdfPages[0] as any;
      const path = await save({
        filters: [{ name: 'Annotated PDF', extensions: ['pdf'] }],
        defaultPath: 'Annotated.pdf',
      });
      if (path && typeof path === 'string') {
        await exportAnnotatedPdfRoundTrip(this.scene.objects, this.assets, firstPdf.asset, path);
      }
    });

    // Vector SVG
    modal.querySelector('#exp-svg')?.addEventListener('click', async () => {
      close();
      const path = await save({
        filters: [{ name: 'SVG Image', extensions: ['svg'] }],
        defaultPath: 'Rustboard.svg',
      });
      if (path && typeof path === 'string') {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const o of this.scene.objects) {
          const b = bboxOf(o);
          if (b[0] < minX) minX = b[0];
          if (b[1] < minY) minY = b[1];
          if (b[2] > maxX) maxX = b[2];
          if (b[3] > maxY) maxY = b[3];
        }
        if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 800; maxY = 600; }
        const svg = exportToSvg(this.scene.objects, this.assets, [minX - 20, minY - 20, maxX + 20, maxY + 20], this.settings.dark);
        await invoke('write_file', new TextEncoder().encode(svg), {
          headers: { 'x-path': encodeURIComponent(path) },
        });
      }
    });

    // Copy to clipboard PNG
    modal.querySelector('#exp-clip')?.addEventListener('click', async () => {
      close();
      const cvs = document.createElement('canvas');
      cvs.width = window.innerWidth * 1.5;
      cvs.height = window.innerHeight * 1.5;
      const ctx = cvs.getContext('2d')!;
      // Render snapshot
      const blob = await new Promise<Blob | null>((res) => cvs.toBlob(res, 'image/png'));
      if (blob) {
        const buf = await blob.arrayBuffer();
        await invoke('clipboard_write_image', new Uint8Array(buf));
      }
    });
  }

  private showSettingsDialog() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-box">
        <div class="modal-header">
          <div class="modal-title">Board Settings</div>
          <button class="modal-close">&times;</button>
        </div>

        <div class="option-group">
          <div class="option-label">Canvas Background Pattern</div>
          <div class="pill-row">
            <div class="pill ${this.settings.pattern === 'dots' ? 'selected' : ''}" data-pat="dots">Dots</div>
            <div class="pill ${this.settings.pattern === 'grid' ? 'selected' : ''}" data-pat="grid">Grid</div>
            <div class="pill ${this.settings.pattern === 'lines' ? 'selected' : ''}" data-pat="lines">Lines</div>
            <div class="pill ${this.settings.pattern === 'none' ? 'selected' : ''}" data-pat="none">Blank</div>
          </div>
        </div>

        <div class="option-group">
          <div class="option-label">Theme</div>
          <div class="pill-row">
            <div class="pill ${!this.settings.dark ? 'selected' : ''}" id="th-light">Light Board</div>
            <div class="pill ${this.settings.dark ? 'selected' : ''}" id="th-dark">Dark Board</div>
          </div>
        </div>

        <div class="option-group">
          <div class="option-label">Inking Smoothing & Stabilization</div>
          <div class="pill-row">
            <div class="pill ${(!this.settings.smoothing || this.settings.smoothing === 'balanced') ? 'selected' : ''}" data-smooth="balanced">Balanced</div>
            <div class="pill ${this.settings.smoothing === 'raw' ? 'selected' : ''}" data-smooth="raw">Low / Direct</div>
            <div class="pill ${this.settings.smoothing === 'smooth' ? 'selected' : ''}" data-smooth="smooth">High / Stabilized</div>
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
            Balanced gives natural handwriting. Low reduces input latency. High stabilizes jitter for neat lettering.
          </div>
        </div>

        <div class="option-group">
          <div class="option-label">Behaviors & Overlays</div>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer;">
            <input type="checkbox" id="chk-minimap" ${this.minimap.visible ? 'checked' : ''}/>
            Show Minimap
          </label>
        </div>

        <div style="margin-top: 24px; padding-top: 14px; border-top: 1px solid var(--panel-border); text-align: center; font-size: 13px; color: var(--text-muted); font-weight: 500;">
          Rustboard was made for Tini ❤️
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('.modal-close')?.addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    modal.querySelectorAll<HTMLDivElement>('[data-pat]').forEach((p) => {
      p.addEventListener('click', () => {
        this.settings.pattern = p.dataset.pat as any;
        modal.querySelectorAll('[data-pat]').forEach((x) => x.classList.remove('selected'));
        p.classList.add('selected');
        this.onNeedRender();
      });
    });

    modal.querySelectorAll<HTMLDivElement>('[data-smooth]').forEach((p) => {
      p.addEventListener('click', () => {
        this.settings.smoothing = p.dataset.smooth as any;
        modal.querySelectorAll('[data-smooth]').forEach((x) => x.classList.remove('selected'));
        p.classList.add('selected');
        this.onNeedRender();
      });
    });

    modal.querySelector('#th-light')?.addEventListener('click', () => {
      this.settings.dark = false;
      document.body.classList.remove('dark');
      this.onNeedRender();
      close();
    });
    modal.querySelector('#th-dark')?.addEventListener('click', () => {
      this.settings.dark = true;
      document.body.classList.add('dark');
      this.onNeedRender();
      close();
    });

    modal.querySelector('#chk-minimap')?.addEventListener('change', (e: any) => {
      this.minimap.visible = e.target.checked;
      this.onNeedRender();
    });
  }

  private reorderFrames(fromIdx: number, toIdx: number) {
    const frames = this.scene.objects.filter((o): o is FrameObj => o.type === 'frame');
    if (fromIdx < 0 || fromIdx >= frames.length || toIdx < 0 || toIdx >= frames.length) return;
    const [moved] = frames.splice(fromIdx, 1);
    frames.splice(toIdx, 0, moved);

    let framePointer = 0;
    const nextObjects = this.scene.objects.map((o) => {
      if (o.type === 'frame') {
        return frames[framePointer++];
      }
      return o;
    });
    this.scene.commit(nextObjects);
    this.onNeedRender();
  }

  private showFramesDialog() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = '<div class="modal-box"></div>';
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });

    const renderContent = () => {
      const frames = this.scene.objects.filter((o): o is FrameObj => o.type === 'frame');
      const box = modal.querySelector('.modal-box')!;
      box.innerHTML = `
        <div class="modal-header">
          <div class="modal-title">Frames & Pages (${frames.length})</div>
          <button class="modal-close">&times;</button>
        </div>

        ${
          frames.length === 0
            ? '<p style="font-size: 13px; color: var(--text-muted);">No frames created yet. Select the Frame tool from the pen tray to draw page regions on the board.</p>'
            : `<p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">Re-order pages using &#9650; / &#9660; to set the page order for PDF export, or click Jump to navigate.</p>
               <div style="max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;">
                 ${frames
                   .map(
                     (f, i) => `
                   <div class="pill" style="text-align: left; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px;">
                     <span style="font-weight: 700; font-size: 12px; min-width: 22px; color: var(--text-muted);">#${i + 1}</span>
                     <input type="text" class="frame-name-input" data-frame-id="${f.id}" value="${escapeXml(f.name || `Page ${i + 1}`)}" style="flex: 1; border: 1px solid var(--panel-border); border-radius: 6px; padding: 4px 8px; font-size: 13px; background: transparent; color: var(--text-main);">
                     <button class="chip-btn" data-move-up="${i}" ${i === 0 ? 'disabled style="opacity: 0.3; cursor: not-allowed;"' : ''} title="Move page up">&#9650;</button>
                     <button class="chip-btn" data-move-down="${i}" ${i === frames.length - 1 ? 'disabled style="opacity: 0.3; cursor: not-allowed;"' : ''} title="Move page down">&#9660;</button>
                     <button class="chip-btn btn-primary" data-jump-to="${f.id}" title="Jump to frame">Jump &rarr;</button>
                   </div>
                 `,
                   )
                   .join('')}
               </div>`
        }
      `;

      box.querySelector('.modal-close')?.addEventListener('click', close);

      box.querySelectorAll<HTMLButtonElement>('[data-move-up]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.moveUp);
          this.reorderFrames(idx, idx - 1);
          renderContent();
        });
      });

      box.querySelectorAll<HTMLButtonElement>('[data-move-down]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.moveDown);
          this.reorderFrames(idx, idx + 1);
          renderContent();
        });
      });

      box.querySelectorAll<HTMLInputElement>('.frame-name-input').forEach((inp) => {
        inp.addEventListener('change', () => {
          const id = inp.dataset.frameId!;
          const f = this.scene.get(id) as FrameObj;
          if (f) {
            this.scene.update(new Map([[id, { ...f, name: inp.value.trim() || f.name }]]));
            this.onNeedRender();
          }
        });
      });

      box.querySelectorAll<HTMLButtonElement>('[data-jump-to]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.jumpTo!;
          const f = this.scene.get(id) as FrameObj;
          if (f) {
            this.camera.x = window.innerWidth / 2 - (f.x + f.w / 2) * this.camera.zoom;
            this.camera.y = window.innerHeight / 2 - (f.y + f.h / 2) * this.camera.zoom;
            this.onNeedRender();
          }
          close();
        });
      });
    };

    renderContent();
  }

  private togglePenPopover(anchorBtn?: HTMLElement) {
    const existing = this.container.querySelector('.pen-popover');
    if (existing) {
      existing.remove();
      return;
    }
    const isHl = this.input.currentTool === 'highlighter';
    const cfg = isHl ? this.input.highlighterConfig : this.input.penConfig;

    const popover = document.createElement('div');
    popover.className = 'pen-popover';
    popover.innerHTML = `
      <div class="pen-popover-title">
        <span>${isHl ? 'Highlighter' : 'Pen'} Settings</span>
        <span style="font-weight: 500; text-transform: none; color: var(--text-main); font-size: 13px;" id="pop-title-val">${cfg.size} px</span>
      </div>

      <!-- Size Preview & Slider -->
      <div class="size-preview-wrap">
        <div class="size-preview-circle">
          <div class="size-preview-dot" id="pop-dot" style="width: ${Math.min(28, Math.max(3, cfg.size))}px; height: ${Math.min(28, Math.max(3, cfg.size))}px; background: ${cfg.color};"></div>
        </div>
        <input type="range" class="pen-size-slider" id="pop-slider" min="1" max="${isHl ? 60 : 36}" step="0.5" value="${cfg.size}">
      </div>

      <!-- Presets -->
      <div class="size-presets">
        ${(isHl ? [12, 20, 28, 38] : [1.5, 3.5, 7, 14, 24]).map((s) => `
          <button class="size-chip ${cfg.size === s ? 'selected' : ''}" data-size="${s}">${s}px</button>
        `).join('')}
      </div>

      <!-- Palette -->
      <div class="color-palette">
        ${['#1a202c', '#4a5568', '#2563eb', '#06b6d4', '#dc2626', '#ea580c', '#16a34a', '#8b5cf6', '#ec4899', '#ffd600'].map((c) => `
          <div class="color-swatch ${cfg.color === c ? 'selected' : ''}" data-c="${c}" style="background: ${c};"></div>
        `).join('')}
        <input type="color" class="custom-color-input" id="pop-custom-color" value="${cfg.color}" title="Custom Color">
      </div>
    `;

    this.container.appendChild(popover);

    const slider = popover.querySelector<HTMLInputElement>('#pop-slider')!;
    const dot = popover.querySelector<HTMLDivElement>('#pop-dot')!;
    const titleVal = popover.querySelector<HTMLSpanElement>('#pop-title-val')!;

    const updateSize = (newSize: number) => {
      cfg.size = newSize;
      slider.value = String(newSize);
      if (titleVal) titleVal.textContent = `${newSize} px`;
      if (dot) {
        dot.style.width = `${Math.min(28, Math.max(3, newSize))}px`;
        dot.style.height = `${Math.min(28, Math.max(3, newSize))}px`;
      }
      popover.querySelectorAll('.size-chip').forEach((ch: any) => {
        ch.classList.toggle('selected', Number(ch.dataset.size) === newSize);
      });
    };

    slider.addEventListener('input', (e: any) => {
      updateSize(Number(e.target.value));
    });

    popover.querySelectorAll<HTMLButtonElement>('.size-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        updateSize(Number(btn.dataset.size));
      });
    });

    popover.querySelectorAll<HTMLDivElement>('.color-swatch').forEach((sw) => {
      sw.addEventListener('click', () => {
        const c = sw.dataset.c!;
        cfg.color = c;
        if (dot) dot.style.background = c;
        popover.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
        sw.classList.add('selected');
        this.updateActivePenIndicatorColor(c);
      });
    });

    const customColorInput = popover.querySelector<HTMLInputElement>('#pop-custom-color')!;
    customColorInput.addEventListener('input', (e: any) => {
      const c = e.target.value;
      cfg.color = c;
      if (dot) dot.style.background = c;
      popover.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
      this.updateActivePenIndicatorColor(c);
    });

    // Close when clicking outside
    const onOutside = (e: MouseEvent) => {
      if (!popover.contains(e.target as Node) && !anchorBtn?.contains(e.target as Node)) {
        popover.remove();
        window.removeEventListener('pointerdown', onOutside);
      }
    };
    setTimeout(() => window.addEventListener('pointerdown', onOutside), 10);
  }

  private updateActivePenIndicatorColor(color: string) {
    const activeBtn = this.container.querySelector('.pen-tray .tool-btn.active');
    const indicator = activeBtn?.querySelector<HTMLDivElement>('.pen-indicator');
    if (indicator) indicator.style.background = color;
  }

  newBoard() {
    this.scene.clear();
    this.assets.clear();
    this.input.selectedIds.clear();
    this.input.activeSelectionBox = null;
    this.currentFilePath = null;
    this.camera.x = window.innerWidth / 2;
    this.camera.y = window.innerHeight / 2;
    this.camera.zoom = 1;
    this.updateZoomDisplay();
    this.updateSelectionToolbar();
    this.onNeedRender();
  }

  updateSelectionToolbar() {
    const bar = this.container.querySelector<HTMLElement>('#selection-toolbar');
    if (!bar) return;
    if (this.input.selectedIds.size === 0) {
      bar.style.display = 'none';
      return;
    }
    const sf = selectionFrame(this.scene.objects, this.input.selectedIds);
    if (!sf) {
      bar.style.display = 'none';
      return;
    }

    const b = sf.box;
    const topOffset = (sf.canRotate ? 44 : 20) / this.camera.zoom;
    const wx = b.x + b.w / 2;
    const wy = b.y - topOffset;

    const sx = wx * this.camera.zoom + this.camera.x;
    const sy = wy * this.camera.zoom + this.camera.y;

    bar.style.display = 'flex';
    const clampedX = Math.max(90, Math.min(window.innerWidth - 90, sx));
    const clampedY = Math.max(70, Math.min(window.innerHeight - 90, sy));
    bar.style.left = `${clampedX}px`;
    bar.style.top = `${clampedY}px`;
    bar.style.transform = 'translate(-50%, -100%)';

    const btnLock = bar.querySelector<HTMLElement>('#btn-sel-lock');
    if (btnLock) {
      btnLock.classList.toggle('active', sf.locked);
      btnLock.setAttribute('title', sf.locked ? 'Unlock (Ctrl+L)' : 'Lock (Ctrl+L)');
    }

    const textFormatGroup = bar.querySelector<HTMLElement>('#sel-text-format');
    const singleText = this.getSingleSelectedText();
    if (textFormatGroup) {
      if (singleText) {
        textFormatGroup.style.display = 'flex';
        const boldBtn = textFormatGroup.querySelector<HTMLElement>('#btn-sel-bold');
        const italicBtn = textFormatGroup.querySelector<HTMLElement>('#btn-sel-italic');
        const sizeVal = textFormatGroup.querySelector<HTMLElement>('#sel-font-size-val');
        if (boldBtn) boldBtn.classList.toggle('active', !!singleText.bold);
        if (italicBtn) italicBtn.classList.toggle('active', !!singleText.italic);
        if (sizeVal) sizeVal.textContent = String(singleText.fontSize || 24);
      } else {
        textFormatGroup.style.display = 'none';
      }
    }
  }

  private getSingleSelectedText(): TextObj | null {
    if (this.input.selectedIds.size !== 1) return null;
    const [id] = this.input.selectedIds;
    const obj = this.scene.get(id);
    if (obj && obj.type === 'text') return obj as TextObj;
    return null;
  }

  private toggleSelectedTextBold() {
    const t = this.getSingleSelectedText();
    if (!t) return;
    const bold = !t.bold;
    const updated: TextObj = { ...t, bold };
    updated.h = textHeight(updated);
    this.scene.update(new Map([[t.id, updated]]));
    this.input.textConfig.bold = bold;
    this.updateSelectionToolbar();
    this.onNeedRender();
  }

  private toggleSelectedTextItalic() {
    const t = this.getSingleSelectedText();
    if (!t) return;
    const italic = !t.italic;
    const updated: TextObj = { ...t, italic };
    updated.h = textHeight(updated);
    this.scene.update(new Map([[t.id, updated]]));
    this.input.textConfig.italic = italic;
    this.updateSelectionToolbar();
    this.onNeedRender();
  }

  private changeSelectedTextFontSize(delta: number) {
    const t = this.getSingleSelectedText();
    if (!t) return;
    const nextSize = Math.max(12, Math.min(120, (t.fontSize || 24) + delta));
    const updated: TextObj = { ...t, fontSize: nextSize };
    updated.h = textHeight(updated);
    this.scene.update(new Map([[t.id, updated]]));
    this.input.textConfig.fontSize = nextSize;
    this.updateSelectionToolbar();
    this.onNeedRender();
  }

  openInlineTextEditor(obj: TextObj, isNew: boolean) {
    this.container.querySelector('.inline-text-editor-wrap')?.remove();

    const wrap = document.createElement('div');
    wrap.className = 'inline-text-editor-wrap';

    const sx = obj.x * this.camera.zoom + this.camera.x;
    const sy = obj.y * this.camera.zoom + this.camera.y;

    wrap.style.left = `${Math.max(16, Math.min(window.innerWidth - 320, sx))}px`;
    wrap.style.top = `${Math.max(50, Math.min(window.innerHeight - 180, sy - 46))}px`;

    let curBold = !!obj.bold;
    let curItalic = !!obj.italic;
    let curSize = obj.fontSize || 24;
    let curColor = obj.color || (this.settings.dark ? '#f8fafc' : '#1a202c');

    wrap.innerHTML = `
      <div class="inline-text-toolbar">
        <button class="tool-btn format-btn ${curBold ? 'active' : ''}" id="inline-bold" title="Toggle Bold"><b>B</b></button>
        <button class="tool-btn format-btn ${curItalic ? 'active' : ''}" id="inline-italic" title="Toggle Italic"><i>I</i></button>
        <button class="tool-btn format-btn" id="inline-size-down" title="Smaller Font Size">A-</button>
        <span id="inline-size-val" style="font-size: 12px; font-weight: 600; min-width: 28px; text-align: center;">${curSize}</span>
        <button class="tool-btn format-btn" id="inline-size-up" title="Larger Font Size">A+</button>
        <input type="color" class="custom-color-input" id="inline-color" value="${curColor}" title="Text Color" style="width: 26px; height: 26px; border: none; cursor: pointer; border-radius: 4px; padding: 0;">
        <button class="tool-btn format-btn" id="inline-done" title="Finish Editing (Esc or Enter)" style="width: auto; padding: 0 10px; background: var(--accent); color: white;">Done</button>
      </div>
      <textarea class="inline-text-textarea" placeholder="Type text here...">${escapeXml(obj.text || '')}</textarea>
    `;

    this.container.appendChild(wrap);

    const textarea = wrap.querySelector<HTMLTextAreaElement>('.inline-text-textarea')!;
    const boldBtn = wrap.querySelector<HTMLButtonElement>('#inline-bold')!;
    const italicBtn = wrap.querySelector<HTMLButtonElement>('#inline-italic')!;
    const sizeDown = wrap.querySelector<HTMLButtonElement>('#inline-size-down')!;
    const sizeUp = wrap.querySelector<HTMLButtonElement>('#inline-size-up')!;
    const sizeVal = wrap.querySelector<HTMLSpanElement>('#inline-size-val')!;
    const colorInp = wrap.querySelector<HTMLInputElement>('#inline-color')!;
    const doneBtn = wrap.querySelector<HTMLButtonElement>('#inline-done')!;

    const applyStylesToTextarea = () => {
      textarea.style.fontSize = `${Math.max(12, curSize * this.camera.zoom)}px`;
      textarea.style.fontWeight = curBold ? 'bold' : 'normal';
      textarea.style.fontStyle = curItalic ? 'italic' : 'normal';
      textarea.style.color = curColor;
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.max(48, textarea.scrollHeight)}px`;
    };

    applyStylesToTextarea();

    boldBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      curBold = !curBold;
      boldBtn.classList.toggle('active', curBold);
      applyStylesToTextarea();
    });

    italicBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      curItalic = !curItalic;
      italicBtn.classList.toggle('active', curItalic);
      applyStylesToTextarea();
    });

    sizeDown.addEventListener('click', (e) => {
      e.stopPropagation();
      curSize = Math.max(12, curSize - 4);
      sizeVal.textContent = String(curSize);
      applyStylesToTextarea();
    });

    sizeUp.addEventListener('click', (e) => {
      e.stopPropagation();
      curSize = Math.min(120, curSize + 4);
      sizeVal.textContent = String(curSize);
      applyStylesToTextarea();
    });

    colorInp.addEventListener('input', () => {
      curColor = colorInp.value;
      applyStylesToTextarea();
    });

    textarea.addEventListener('input', applyStylesToTextarea);

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      window.removeEventListener('pointerdown', onOutside);
      const textVal = textarea.value.trim();
      wrap.remove();

      if (!textVal) {
        if (!isNew) {
          this.scene.remove(new Set([obj.id]));
        }
        this.input.clearSelection();
      } else {
        const measuredW = Math.max(80, textarea.offsetWidth / this.camera.zoom);
        const updated: TextObj = {
          ...obj,
          text: textarea.value,
          bold: curBold,
          italic: curItalic,
          fontSize: curSize,
          color: curColor,
          w: measuredW,
        };
        updated.h = textHeight(updated);
        if (isNew) {
          this.scene.add([updated]);
        } else {
          this.scene.update(new Map([[obj.id, updated]]));
        }
        this.input.textConfig = { fontSize: curSize, bold: curBold, italic: curItalic };
        this.input.selectedIds = new Set([obj.id]);
        this.updateSelectionToolbar();
      }
      this.onNeedRender();
    };

    doneBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      commit();
    });

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        commit();
      }
    });

    const onOutside = (e: MouseEvent) => {
      if (!wrap.contains(e.target as Node)) {
        commit();
      }
    };
    setTimeout(() => window.addEventListener('pointerdown', onOutside), 10);

    textarea.focus();
    if (isNew) {
      textarea.select();
    }
  }

  showFrameDeleteDialog(onDeleteFrameOnly: () => void, onDeleteFrameAndContent: () => void) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-box" style="max-width: 440px;">
        <div class="modal-header">
          <div class="modal-title">Delete Frame</div>
          <button class="modal-close">&times;</button>
        </div>
        <p style="font-size: 14px; color: var(--text-muted); margin-bottom: 20px; line-height: 1.5;">
          Do you want to delete only the frame boundary, or also all drawings and objects contained inside it?
        </p>
        <div style="display: flex; flex-direction: column; gap: 10px;">
          <button class="modal-btn btn-primary" id="btn-del-frame-only" style="padding: 11px;">
            Delete Frame Only (Keep Content)
          </button>
          <button class="modal-btn btn-danger" id="btn-del-frame-all" style="padding: 11px;">
            Delete Frame &amp; All Contained Content
          </button>
          <button class="modal-btn btn-secondary" id="btn-del-cancel" style="padding: 10px;">
            Cancel
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.modal-close')?.addEventListener('click', close);
    modal.querySelector('#btn-del-cancel')?.addEventListener('click', close);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });

    modal.querySelector('#btn-del-frame-only')?.addEventListener('click', () => {
      close();
      onDeleteFrameOnly();
    });

    modal.querySelector('#btn-del-frame-all')?.addEventListener('click', () => {
      close();
      onDeleteFrameAndContent();
    });
  }

  private toggleEraserPopover(anchorBtn?: HTMLElement) {
    const existing = this.container.querySelector('.eraser-popover');
    if (existing) {
      existing.remove();
      return;
    }
    this.container.querySelector('.pen-popover')?.remove();
    this.container.querySelector('.shape-popover')?.remove();

    const currentSize = this.input.eraserBaseSize || 16;
    const popover = document.createElement('div');
    popover.className = 'pen-popover eraser-popover';
    popover.innerHTML = `
      <div class="pen-popover-title">
        <span>Eraser Scale</span>
        <span style="font-weight: 500; text-transform: none; color: var(--text-main); font-size: 13px;" id="eraser-pop-title-val">${currentSize} px</span>
      </div>

      <!-- Size Preview & Slider -->
      <div class="size-preview-wrap">
        <div class="size-preview-circle">
          <div class="size-preview-dot" id="eraser-pop-dot" style="width: ${Math.min(30, Math.max(6, currentSize))}px; height: ${Math.min(30, Math.max(6, currentSize))}px; background: var(--text-muted); border: 2px dashed var(--accent); border-radius: 50%;"></div>
        </div>
        <input type="range" class="pen-size-slider" id="eraser-pop-slider" min="6" max="64" step="1" value="${currentSize}">
      </div>

      <!-- Presets -->
      <div class="size-presets">
        ${[8, 12, 16, 24, 36, 52].map((s) => `
          <button class="size-chip ${currentSize === s ? 'selected' : ''}" data-size="${s}">${s}px</button>
        `).join('')}
      </div>
    `;

    this.container.appendChild(popover);

    const slider = popover.querySelector<HTMLInputElement>('#eraser-pop-slider')!;
    const dot = popover.querySelector<HTMLDivElement>('#eraser-pop-dot')!;
    const titleVal = popover.querySelector<HTMLSpanElement>('#eraser-pop-title-val')!;

    const updateSize = (newSize: number) => {
      this.input.eraserBaseSize = newSize;
      slider.value = String(newSize);
      if (titleVal) titleVal.textContent = `${newSize} px`;
      if (dot) {
        dot.style.width = `${Math.min(30, Math.max(6, newSize))}px`;
        dot.style.height = `${Math.min(30, Math.max(6, newSize))}px`;
      }
      popover.querySelectorAll('.size-chip').forEach((ch: any) => {
        ch.classList.toggle('selected', Number(ch.dataset.size) === newSize);
      });
    };

    slider.addEventListener('input', (e: any) => {
      updateSize(Number(e.target.value));
    });

    popover.querySelectorAll<HTMLButtonElement>('.size-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        updateSize(Number(btn.dataset.size));
      });
    });

    // Close when clicking outside
    const onOutside = (e: MouseEvent) => {
      if (!popover.contains(e.target as Node) && !anchorBtn?.contains(e.target as Node)) {
        popover.remove();
        window.removeEventListener('pointerdown', onOutside);
      }
    };
    setTimeout(() => window.addEventListener('pointerdown', onOutside), 10);
  }

  showConfirmDialog(title: string, message: string, confirmLabel: string, onConfirm: () => void) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-box">
        <div class="modal-header">
          <div class="modal-title">${title}</div>
          <button class="modal-close">&times;</button>
        </div>
        <p style="font-size: 14px; color: var(--text-muted); margin-bottom: 20px; line-height: 1.5;">
          ${message}
        </p>
        <div style="display: flex; gap: 10px; justify-content: flex-end;">
          <button class="modal-btn btn-secondary" id="confirm-cancel" style="padding: 9px 18px;">
            Cancel
          </button>
          <button class="modal-btn btn-primary" id="confirm-ok" style="padding: 9px 18px;">
            ${confirmLabel}
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('.modal-close')?.addEventListener('click', close);
    modal.querySelector('#confirm-cancel')?.addEventListener('click', close);
    modal.querySelector('#confirm-ok')?.addEventListener('click', () => {
      close();
      onConfirm();
    });
  }

  showStartupDialog(onRestore: () => void, onFresh: () => void) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay startup-modal';
    modal.innerHTML = `
      <div class="modal-box" style="max-width: 420px;">
        <div class="modal-header">
          <div class="modal-title">Welcome to Rustboard</div>
        </div>
        <p style="font-size: 14px; color: var(--text-muted); margin-bottom: 22px; line-height: 1.5;">
          A previous whiteboard session was saved. Would you like to restore where you left off or start with a fresh blank canvas?
        </p>
        <div style="display: flex; flex-direction: column; gap: 10px;">
          <button class="modal-btn btn-primary" id="start-restore" style="padding: 12px; font-size: 14px;">
            Restore Previous Board
          </button>
          <button class="modal-btn btn-secondary" id="start-fresh" style="padding: 12px; font-size: 14px;">
            Start Fresh Canvas
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('#start-restore')?.addEventListener('click', () => {
      modal.remove();
      onRestore();
    });

    modal.querySelector('#start-fresh')?.addEventListener('click', () => {
      modal.remove();
      onFresh();
    });
  }

  showExitPrompt(onSaveAndExit: () => Promise<void>, onExitWithoutSaving: () => void) {
    if (document.querySelector('.exit-modal')) return;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay exit-modal';
    modal.innerHTML = `
      <div class="modal-box" style="max-width: 420px;">
        <div class="modal-header">
          <div class="modal-title">Unsaved Changes</div>
          <button class="modal-close">&times;</button>
        </div>
        <p style="font-size: 14px; color: var(--text-muted); margin-bottom: 20px; line-height: 1.5;">
          You have unsaved changes on your board. Would you like to save or export before exiting?
        </p>
        <div style="display: flex; flex-direction: column; gap: 10px;">
          <button class="modal-btn btn-primary" id="btn-exit-save" style="padding: 11px;">
            Save & Exit
          </button>
          <button class="modal-btn btn-danger" id="btn-exit-discard" style="padding: 11px;">
            Exit Without Saving
          </button>
          <button class="modal-btn btn-secondary" id="btn-exit-cancel" style="padding: 11px;">
            Cancel
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.modal-close')?.addEventListener('click', close);
    modal.querySelector('#btn-exit-cancel')?.addEventListener('click', close);

    modal.querySelector('#btn-exit-save')?.addEventListener('click', async () => {
      close();
      await onSaveAndExit();
    });

    modal.querySelector('#btn-exit-discard')?.addEventListener('click', () => {
      close();
      onExitWithoutSaving();
    });
  }

  private toggleShapePopover(anchorBtn?: HTMLElement) {
    const existing = this.container.querySelector('.shape-popover');
    if (existing) {
      existing.remove();
      return;
    }
    this.container.querySelector('.pen-popover')?.remove();

    const shapeNames: Record<ShapeTool, string> = {
      square: 'Square (1:1)',
      rect: 'Rectangle',
      circle: 'Circle (1:1)',
      ellipse: 'Ellipse',
      triangle: 'Triangle',
      diamond: 'Diamond',
      line: 'Straight Line',
    };

    const popover = document.createElement('div');
    popover.className = 'pen-popover shape-popover';
    popover.innerHTML = `
      <div class="pen-popover-title">
        <span>Shape Tool</span>
        <span style="font-weight: 500; text-transform: none; color: var(--text-main); font-size: 13px;" id="shape-name-val">${shapeNames[this.input.shapeTool]}</span>
      </div>

      <!-- Shape Selection Grid -->
      <div class="shape-grid">
        <button class="shape-opt-btn ${this.input.shapeTool === 'rect' ? 'selected' : ''}" data-shape="rect" title="Rectangle">
          <svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2"/></svg>
          <span>Rect</span>
        </button>
        <button class="shape-opt-btn ${this.input.shapeTool === 'square' ? 'selected' : ''}" data-shape="square" title="Square (1:1)">
          <svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
          <span>Square</span>
        </button>
        <button class="shape-opt-btn ${this.input.shapeTool === 'circle' ? 'selected' : ''}" data-shape="circle" title="Circle (1:1)">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>
          <span>Circle</span>
        </button>
        <button class="shape-opt-btn ${this.input.shapeTool === 'ellipse' ? 'selected' : ''}" data-shape="ellipse" title="Ellipse">
          <svg viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="10" ry="6"/></svg>
          <span>Ellipse</span>
        </button>
        <button class="shape-opt-btn ${this.input.shapeTool === 'triangle' ? 'selected' : ''}" data-shape="triangle" title="Triangle">
          <svg viewBox="0 0 24 24"><polygon points="12,3 21,20 3,20"/></svg>
          <span>Triangle</span>
        </button>
        <button class="shape-opt-btn ${this.input.shapeTool === 'diamond' ? 'selected' : ''}" data-shape="diamond" title="Diamond">
          <svg viewBox="0 0 24 24"><polygon points="12,3 21,12 12,21 3,12"/></svg>
          <span>Diamond</span>
        </button>
        <button class="shape-opt-btn ${this.input.shapeTool === 'line' ? 'selected' : ''}" data-shape="line" title="Straight Line">
          <svg viewBox="0 0 24 24"><line x1="4" y1="20" x2="20" y2="4"/></svg>
          <span>Line</span>
        </button>
      </div>

      <!-- Line Arrowhead Options -->
      <div class="shape-options-row" id="arrow-options-row" style="${this.input.shapeTool === 'line' ? '' : 'display: none;'}">
        <div class="sub-label">Arrows:</div>
        <div class="style-toggle-group">
          <button class="chip-btn ${!this.input.shapeArrowStart && !this.input.shapeArrowEnd ? 'selected' : ''}" data-arrow="none" title="No arrow">None</button>
          <button class="chip-btn ${!this.input.shapeArrowStart && this.input.shapeArrowEnd ? 'selected' : ''}" data-arrow="end" title="Arrow at end">End &rarr;</button>
          <button class="chip-btn ${this.input.shapeArrowStart && this.input.shapeArrowEnd ? 'selected' : ''}" data-arrow="both" title="Arrows at both ends">&larr; Both &rarr;</button>
          <button class="chip-btn ${this.input.shapeArrowStart && !this.input.shapeArrowEnd ? 'selected' : ''}" data-arrow="start" title="Arrow at start">&larr; Start</button>
        </div>
      </div>

      <!-- Line Dash Style -->
      <div class="shape-options-row">
        <div class="sub-label">Line Style:</div>
        <div class="style-toggle-group">
          <button class="chip-btn ${this.input.shapeLineDash === 'solid' ? 'selected' : ''}" data-dash="solid" title="Solid Line">&horbar; Solid</button>
          <button class="chip-btn ${this.input.shapeLineDash === 'dashed' ? 'selected' : ''}" data-dash="dashed" title="Dashed Line">- - Dashed</button>
          <button class="chip-btn ${this.input.shapeLineDash === 'dotted' ? 'selected' : ''}" data-dash="dotted" title="Dotted Line">&middot; &middot; Dotted</button>
        </div>
      </div>

      <!-- Fill Toggle (Closed shapes) -->
      <div class="shape-options-row" id="fill-options-row" style="${this.input.shapeTool === 'line' ? 'display: none;' : ''}">
        <div class="sub-label">Fill:</div>
        <div class="style-toggle-group">
          <button class="chip-btn ${!this.input.fillShape ? 'selected' : ''}" id="btn-fill-none">Outline Only</button>
          <button class="chip-btn ${this.input.fillShape ? 'selected' : ''}" id="btn-fill-semi">Tinted Fill</button>
        </div>
      </div>

      <!-- Size Preview & Slider -->
      <div class="size-preview-wrap">
        <div class="size-preview-circle">
          <div class="size-preview-dot" id="shape-dot" style="width: ${Math.min(26, Math.max(3, this.input.penConfig.size))}px; height: ${Math.min(26, Math.max(3, this.input.penConfig.size))}px; background: ${this.input.penConfig.color};"></div>
        </div>
        <input type="range" class="pen-size-slider" id="shape-slider" min="1" max="28" step="0.5" value="${this.input.penConfig.size}">
        <span style="font-size: 12px; min-width: 38px; text-align: right;" id="shape-slider-val">${this.input.penConfig.size} px</span>
      </div>

      <!-- Presets -->
      <div class="size-presets">
        ${[2, 4, 8, 14].map((s) => `
          <button class="size-chip ${this.input.penConfig.size === s ? 'selected' : ''}" data-size="${s}">${s}px</button>
        `).join('')}
      </div>

      <!-- Palette -->
      <div class="color-palette">
        ${['#1a202c', '#4a5568', '#2563eb', '#06b6d4', '#dc2626', '#ea580c', '#16a34a', '#8b5cf6', '#ec4899', '#ffd600'].map((c) => `
          <div class="color-swatch ${this.input.penConfig.color === c ? 'selected' : ''}" data-c="${c}" style="background: ${c};"></div>
        `).join('')}
        <input type="color" class="custom-color-input" id="shape-custom-color" value="${this.input.penConfig.color}" title="Custom Color">
      </div>
    `;

    this.container.appendChild(popover);

    const nameVal = popover.querySelector<HTMLSpanElement>('#shape-name-val')!;
    const arrowRow = popover.querySelector<HTMLElement>('#arrow-options-row')!;
    const fillRow = popover.querySelector<HTMLElement>('#fill-options-row')!;
    const slider = popover.querySelector<HTMLInputElement>('#shape-slider')!;
    const sliderVal = popover.querySelector<HTMLSpanElement>('#shape-slider-val')!;
    const dot = popover.querySelector<HTMLDivElement>('#shape-dot')!;

    // Shape selection
    popover.querySelectorAll<HTMLButtonElement>('.shape-opt-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sh = btn.dataset.shape as ShapeTool;
        this.input.shapeTool = sh;
        nameVal.textContent = shapeNames[sh];
        popover.querySelectorAll('.shape-opt-btn').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        const isLine = sh === 'line';
        arrowRow.style.display = isLine ? 'flex' : 'none';
        fillRow.style.display = isLine ? 'none' : 'flex';
      });
    });

    // Arrow options
    popover.querySelectorAll<HTMLButtonElement>('[data-arrow]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const arr = btn.dataset.arrow;
        if (arr === 'none') {
          this.input.shapeArrowStart = false;
          this.input.shapeArrowEnd = false;
        } else if (arr === 'end') {
          this.input.shapeArrowStart = false;
          this.input.shapeArrowEnd = true;
        } else if (arr === 'both') {
          this.input.shapeArrowStart = true;
          this.input.shapeArrowEnd = true;
        } else if (arr === 'start') {
          this.input.shapeArrowStart = true;
          this.input.shapeArrowEnd = false;
        }
        popover.querySelectorAll('[data-arrow]').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });

    // Dash options
    popover.querySelectorAll<HTMLButtonElement>('[data-dash]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const d = btn.dataset.dash as LineDash;
        this.input.shapeLineDash = d;
        popover.querySelectorAll('[data-dash]').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });

    // Fill options
    const btnFillNone = popover.querySelector('#btn-fill-none');
    const btnFillSemi = popover.querySelector('#btn-fill-semi');
    btnFillNone?.addEventListener('click', () => {
      this.input.fillShape = false;
      btnFillNone.classList.add('selected');
      btnFillSemi?.classList.remove('selected');
    });
    btnFillSemi?.addEventListener('click', () => {
      this.input.fillShape = true;
      btnFillSemi.classList.add('selected');
      btnFillNone?.classList.remove('selected');
    });

    // Size slider & chips
    const setSize = (sz: number) => {
      this.input.penConfig.size = sz;
      slider.value = String(sz);
      sliderVal.textContent = `${sz} px`;
      dot.style.width = `${Math.min(26, Math.max(3, sz))}px`;
      dot.style.height = `${Math.min(26, Math.max(3, sz))}px`;
      popover.querySelectorAll('.size-chip').forEach((c: any) => {
        c.classList.toggle('selected', Number(c.dataset.size) === sz);
      });
    };
    slider.addEventListener('input', (e: any) => setSize(Number(e.target.value)));
    popover.querySelectorAll<HTMLButtonElement>('.size-chip').forEach((btn) => {
      btn.addEventListener('click', () => setSize(Number(btn.dataset.size)));
    });

    // Color palette
    popover.querySelectorAll<HTMLDivElement>('.color-swatch').forEach((sw) => {
      sw.addEventListener('click', () => {
        const c = sw.dataset.c!;
        this.input.penConfig.color = c;
        dot.style.background = c;
        popover.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
        sw.classList.add('selected');
        this.updateActivePenIndicatorColor(c);
      });
    });
    const customColor = popover.querySelector<HTMLInputElement>('#shape-custom-color')!;
    customColor.addEventListener('input', (e: any) => {
      const c = e.target.value;
      this.input.penConfig.color = c;
      dot.style.background = c;
      popover.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
      this.updateActivePenIndicatorColor(c);
    });

    // Close when clicking outside
    const onOutside = (e: MouseEvent) => {
      if (!popover.contains(e.target as Node) && !anchorBtn?.contains(e.target as Node)) {
        popover.remove();
        window.removeEventListener('pointerdown', onOutside);
      }
    };
    setTimeout(() => window.addEventListener('pointerdown', onOutside), 10);
  }
}
