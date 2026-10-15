import { invoke } from '@tauri-apps/api/core';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Assets } from './assets';
import type { Scene } from './scene';
import type { BoardSettings, Camera, Obj } from './types';

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
  return {
    camera: boardData.camera || { x: 0, y: 0, zoom: 1 },
    settings: boardData.settings || { pattern: 'dots', dark: false },
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
