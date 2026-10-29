import { invoke } from '@tauri-apps/api/core';
import { Assets } from './assets';
import { checkCrashRecovery, loadBoard, scheduleAutosave } from './file_io';
import { InputManager } from './input';
import { Minimap } from './minimap';
import { RadialMenu } from './radial_menu';
import { Renderer } from './renderer';
import { Ruler } from './ruler';
import { Scene } from './scene';
import type { BoardSettings, Camera, DockPosition } from './types';
import { UIManager } from './ui';

async function bootstrap() {
  const canvas = document.getElementById('main') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d', { desynchronized: true })!;
  const overlayCanvas = document.getElementById('overlay') as HTMLCanvasElement;
  const overlayCtx = overlayCanvas.getContext('2d')!;
  const uiContainer = document.getElementById('ui') as HTMLElement;

  const savedDock = (localStorage.getItem('rustboard_dock_position') as DockPosition) || 'bottom';
  const savedScreenShare = localStorage.getItem('rustboard_screen_share') === '1';
  const settings: BoardSettings = {
    pattern: 'dots',
    dark: false,
    smoothing: 'balanced',
    dockPosition: savedDock,
    screenShareMode: savedScreenShare,
  };

  const camera: Camera = {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    zoom: 1,
  };

  let renderPending = true;
  const requestRender = () => {
    renderPending = true;
  };

  const scene = new Scene();
  const assets = new Assets(requestRender);
  const renderer = new Renderer();
  const ruler = new Ruler();
  const radial = new RadialMenu();
  const minimap = new Minimap();

  scene.onChange(() => {
    requestRender();
    scheduleAutosave(scene, assets, camera, settings);
  });

  let ui: UIManager;
  const onSelectionChanged = () => {
    requestRender();
    ui?.updateSelectionToolbar();
  };

  const input = new InputManager(
    canvas,
    scene,
    assets,
    camera,
    ruler,
    radial,
    minimap,
    requestRender,
    onSelectionChanged,
  );
  (input as any).renderer = renderer;

  ui = new UIManager(
    uiContainer,
    input,
    scene,
    assets,
    camera,
    settings,
    ruler,
    minimap,
    requestRender,
  );

  // Resize canvas according to device pixel ratio (capped in Screen Sharing Mode to reduce GPU bandwidth)
  function resizeCanvas() {
    const rawDpr = window.devicePixelRatio || 1;
    const dpr = settings.screenShareMode ? Math.min(rawDpr, 1.25) : rawDpr;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    overlayCanvas.width = Math.round(w * dpr);
    overlayCanvas.height = Math.round(h * dpr);
    overlayCanvas.style.width = `${w}px`;
    overlayCanvas.style.height = `${h}px`;
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    renderer.invalidateCache();
    requestRender();
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Animation Loop
  let lastZoom = -1;
  function tick() {
    if (renderer.laserPoints.length > 0) {
      renderer.pruneLaser();
      renderPending = true;
    }

    if (renderPending) {
      renderPending = false;
      renderer.render(
        ctx,
        camera,
        scene.objects,
        input.selectedIds,
        settings,
        assets,
        ruler,
        radial,
        minimap,
        input.activeDraft,
        input.lassoPoly,
        input.eraserState,
        input.activeSelectionBox,
        scene.version,
        assets.version,
        input.activeTransformIds,
        input.transformSessionId,
        overlayCtx,
      );
      if (Math.abs(camera.zoom - lastZoom) > 0.001) {
        lastZoom = camera.zoom;
        ui.updateZoomDisplay();
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // Startup checks: file association (.rboard or .pdf) or crash recovery
  try {
    const startupFile = await invoke<string | null>('get_startup_file');
    if (startupFile) {
      if (startupFile.toLowerCase().endsWith('.rboard')) {
        const res = await loadBoard(startupFile, scene, assets);
        Object.assign(camera, res.camera);
        Object.assign(settings, res.settings);
        document.body.classList.toggle('dark', settings.dark);
        ui.applyDockPosition();
        ui.applyScreenShareMode();
        requestRender();
      } else if (startupFile.toLowerCase().endsWith('.pdf')) {
        const bytes = await invoke<number[]>('read_file', { path: startupFile });
        const name = startupFile.split(/[\\/]/).pop() || 'startup.pdf';
        await input.insertPdfBytes(new Uint8Array(bytes), name);
      }
    } else {
      // Check for recovery file
      const rec = await checkCrashRecovery();
      if (rec) {
        ui.showStartupDialog(
          async () => {
            try {
              const res = await loadBoard(rec, scene, assets);
              Object.assign(camera, res.camera);
              Object.assign(settings, res.settings);
              document.body.classList.toggle('dark', settings.dark);
              ui.applyDockPosition();
              ui.applyScreenShareMode();
              requestRender();
            } catch {
              /* recovery failed, start fresh */
            }
          },
          () => {
            ui.newBoard();
          },
        );
      }
    }
  } catch (err) {
    console.warn('Startup check failed:', err);
  }

  // Intercept window close to prompt save/export if unsaved changes exist
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const appWindow = getCurrentWindow();
    await appWindow.onCloseRequested(async (event) => {
      if (scene.dirty && scene.objects.length > 0) {
        event.preventDefault();
        ui.showExitPrompt(
          async () => {
            const saved = await ui.handleSave();
            if (saved) {
              await appWindow.destroy();
            }
          },
          async () => {
            await appWindow.destroy();
          },
        );
      }
    });
  } catch (err) {
    window.addEventListener('beforeunload', (e) => {
      if (scene.dirty && scene.objects.length > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }
}

bootstrap();
