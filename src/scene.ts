import type { Obj } from './types';

const MAX_HISTORY = 300;

/**
 * Immutable-object scene store. Every change produces a new array (objects are
 * replaced, never mutated), so undo snapshots are cheap reference copies.
 */
export class Scene {
  objects: Obj[] = [];
  private map = new Map<string, Obj>();
  private undoStack: Obj[][] = [];
  private redoStack: Obj[][] = [];
  version = 0;
  savedVersion = 0;
  private listeners: (() => void)[] = [];

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  get(id: string) {
    return this.map.get(id);
  }

  private setObjects(objs: Obj[]) {
    this.objects = objs;
    this.map = new Map(objs.map((o) => [o.id, o]));
    this.version++;
    for (const l of this.listeners) l();
  }

  /** Record `base` as an undo point and set new objects. */
  commit(objs: Obj[], base: Obj[] = this.objects) {
    if (objs === base) return;
    this.undoStack.push(base);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.setObjects(objs);
  }

  /** Change without a history entry (live drags); finish with commit(final, base). */
  transient(objs: Obj[]) {
    this.setObjects(objs);
  }

  add(objs: Obj[]) {
    if (objs.length) this.commit([...this.objects, ...objs]);
  }

  remove(ids: Set<string>) {
    if (ids.size) this.commit(this.objects.filter((o) => !ids.has(o.id)));
  }

  update(changed: Map<string, Obj>) {
    if (changed.size) this.commit(this.objects.map((o) => changed.get(o.id) ?? o));
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.objects);
    this.setObjects(prev);
    return true;
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.objects);
    this.setObjects(next);
    return true;
  }

  reset(objs: Obj[]) {
    this.undoStack = [];
    this.redoStack = [];
    this.setObjects(objs);
    this.savedVersion = this.version;
  }

  clear() {
    this.reset([]);
  }

  markSaved() {
    this.savedVersion = this.version;
  }

  get dirty() {
    return this.version !== this.savedVersion;
  }
}
