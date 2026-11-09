import { invoke } from '@tauri-apps/api/core';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Assets } from './assets';
import type { Scene } from './scene';
import type { BoardSettings, Camera, DockPosition, Obj, TaskbarPrefs } from './types';

const PREFS_STORAGE_KEY = 'rustboard_taskbar_prefs';

export function defaultTaskbarPrefs(): TaskbarPrefs {
  const legacyDock = (localStorage.getItem('rustboard_dock_position') as DockPosition) || 'bottom';
  return {
    dockPosition: legacyDock,
    pens: [
      { color: '#1a202c', size: 3.5 },
      { color: '#2563eb', size: 3.5 },
      { color: '#dc2626', size: 3.5 },
      { color: '#16a34a', size: 3.5 },
    ],
    activePenIndex: 0,
    highlighter: { color: '#ffd600', size: 24 },
    eraserBaseSize: 16,
    shapeColor: '#1a202c',
    shapeSize: 4,
    dark: false,
    pattern: 'dots',
    smoothing: 'balanced',
  };
}

function normalizePrefs(raw: Partial<TaskbarPrefs> | null | undefined): TaskbarPrefs {
  const def = defaultTaskbarPrefs();
  if (!raw || typeof raw !== 'object') return def;
  const pens = Array.isArray(raw.pens) && raw.pens.length === 4
    ? raw.pens.map((p, i) => ({
        color: typeof p?.color === 'string' && p.color ? p.color : def.pens[i].color,
        size: typeof p?.size === 'number' && p.size > 0 ? p.size : def.pens[i].size,
      }))
    : def.pens;
  return {
    dockPosition:
      raw.dockPosition === 'top' || raw.dockPosition === 'left' || raw.dockPosition === 'right' || raw.dockPosition === 'bottom'
        ? raw.dockPosition
        : def.dockPosition,
    pens,
    activePenIndex:
      typeof raw.activePenIndex === 'number' && raw.activePenIndex >= 0 && raw.activePenIndex < 4
        ? raw.activePenIndex
        : 0,
    highlighter: {
      color: typeof raw.highlighter?.color === 'string' && raw.highlighter.color ? raw.highlighter.color : def.highlighter.color,
      size: typeof raw.highlighter?.size === 'number' && raw.highlighter.size > 0 ? raw.highlighter.size : def.highlighter.size,
    },
    eraserBaseSize: typeof raw.eraserBaseSize === 'number' && raw.eraserBaseSize > 0 ? raw.eraserBaseSize : def.eraserBaseSize,
    shapeColor: typeof raw.shapeColor === 'string' && raw.shapeColor ? raw.shapeColor : def.shapeColor,
    shapeSize: typeof raw.shapeSize === 'number' && raw.shapeSize > 0 ? raw.shapeSize : def.shapeSize,
    dark: typeof raw.dark === 'boolean' ? raw.dark : def.dark,
    pattern: raw.pattern ?? def.pattern,
    smoothing: raw.smoothing ?? def.smoothing,
  };
}

export function getTaskbarPrefsSync(): TaskbarPrefs {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (raw) {
      return normalizePrefs(JSON.parse(raw));
    }
  } catch {
    /* ignore */
  }
  return defaultTaskbarPrefs();
}

export async function loadTaskbarPrefs(): Promise<TaskbarPrefs> {
  try {
    const recDir = await invoke<string>('recovery_dir');
    const prefsPath = `${recDir}\\prefs.json`;
    const exists = await invoke<boolean>('file_exists', { path: prefsPath });
    if (exists) {
      const bytes = await invoke<number[]>('read_file', { path: prefsPath });
      const parsed = JSON.parse(strFromU8(new Uint8Array(bytes)));
      const prefs = normalizePrefs(parsed);
      try {
        localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
        localStorage.setItem('rustboard_dock_position', prefs.dockPosition);
      } catch {
        /* ignore */
      }
      return prefs;
    }
  } catch {
    /* ignore */
  }
  return getTaskbarPrefsSync();
}

export async function saveTaskbarPrefs(prefs: TaskbarPrefs): Promise<void> {
  const normalized = normalizePrefs(prefs);
  const jsonStr = JSON.stringify(normalized);
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, jsonStr);
    localStorage.setItem('rustboard_dock_position', normalized.dockPosition);
  } catch {
    /* ignore */
  }
  try {
    const recDir = await invoke<string>('recovery_dir');
    const prefsPath = `${recDir}\\prefs.json`;
    await invoke('write_file', strToU8(jsonStr), {
      headers: {
        'x-path': encodeURIComponent(prefsPath),
      },
    });
  } catch (e) {
    console.warn('Could not save preferences file:', e);
  }
}

export interface BoardFile {
  version: 1;
  settings: BoardSettings;
  camera: Camera;
  objects: Obj[];
}

export async function saveBoard(
  scene: Scene,
  assets: Assets,
  camera: Camera,
  settings: BoardSettings,
  path: string,
  markSaved = true,
) {
  const fileData: BoardFile = {
    version: 1,
    settings,
    camera,
    objects: scene.objects,
  };

  // Find all assets actually referenced in the scene
  const usedAssetIds = new Set<string>();
  for (const o of scene.objects) {
    if (o.type === 'image' || o.type === 'pdfpage') {
      usedAssetIds.add(o.asset);
    }
  }

  const zipFiles: Record<string, Uint8Array> = {
    'board.json': strToU8(JSON.stringify(fileData)),
  };

  for (const assetId of usedAssetIds) {
    const a = assets.get(assetId);
    if (a) {
      zipFiles[`assets/${a.id}`] = a.bytes;
      zipFiles[`assets/${a.id}.meta`] = strToU8(JSON.stringify({ mime: a.mime, name: a.name }));
    }
  }

  const zipped = zipSync(zipFiles, { level: 6 });

  // Write file via Tauri IPC
  await invoke('write_file', zipped, {
    headers: {
      'x-path': encodeURIComponent(path),
    },
  });
  if (markSaved) scene.markSaved();
}

export async function loadBoard(
  path: string,
  scene: Scene,
  assets: Assets,
): Promise<{ camera: Camera; settings: BoardSettings }> {
  const bytes = await invoke<number[]>('read_file', { path });
  const u8 = new Uint8Array(bytes);
  const unzipped = unzipSync(u8);

  const boardJsonStr = strFromU8(unzipped['board.json']);
  const boardData: BoardFile = JSON.parse(boardJsonStr);

  assets.clear();

  // Load assets
  for (const [filename, fileBytes] of Object.entries(unzipped)) {
    if (filename.startsWith('assets/') && !filename.endsWith('.meta')) {
      const assetId = filename.slice('assets/'.length);
      const metaKey = `${filename}.meta`;
      let mime = 'image/png';
      let name = 'asset';
      if (unzipped[metaKey]) {
        try {
          const meta = JSON.parse(strFromU8(unzipped[metaKey]));
          mime = meta.mime || mime;
          name = meta.name || name;
        } catch {
          /* ignore */
        }
      }
      assets.add(fileBytes, mime, name, assetId);
    }
  }

  scene.reset(boardData.objects || []);
  const savedPrefs = getTaskbarPrefsSync();
  return {
    camera: boardData.camera || { x: 0, y: 0, zoom: 1 },
    settings: {
      pattern: boardData.settings?.pattern ?? savedPrefs.pattern ?? 'dots',
      dark: boardData.settings?.dark ?? savedPrefs.dark ?? false,
      smoothing: boardData.settings?.smoothing ?? savedPrefs.smoothing ?? 'balanced',
      dockPosition: savedPrefs.dockPosition,
    },
  };
}

let autoSaveTimer: any = null;
export function scheduleAutosave(
  scene: Scene,
  assets: Assets,
  camera: Camera,
  settings: BoardSettings,
) {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    try {
      const recDir = await invoke<string>('recovery_dir');
      const recPath = `${recDir}\\autosave.rboard`;
      await saveBoard(scene, assets, camera, settings, recPath, false);
    } catch (e) {
      console.warn('Autosave error:', e);
    }
  }, 1200);
}

export async function checkCrashRecovery(): Promise<string | null> {
  try {
    const recDir = await invoke<string>('recovery_dir');
    const recPath = `${recDir}\\autosave.rboard`;
    const exists = await invoke<boolean>('file_exists', { path: recPath });
    return exists ? recPath : null;
  } catch {
    return null;
  }
}
