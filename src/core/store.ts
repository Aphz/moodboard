/**
 * Store central: estado + selección + historial de deshacer/rehacer.
 *
 * Estrategia de historial: instantáneas estructurales de `scene.items` y
 * `scene.settings` (los ítems son objetos pequeños; los bitmaps viven fuera,
 * en IndexedDB, referenciados por `blobId`). Es simple, robusto y suficiente
 * para escenas de cientos de ítems. Las operaciones continuas (arrastrar,
 * escalar) se agrupan con `beginTransaction`/`endTransaction` para que un
 * gesto completo sea un solo paso de deshacer.
 */
import {
  createScene,
  descendantsOf,
  findItem,
  nextZ,
  type Item,
  type ItemId,
  type Scene,
  type SceneSettings,
  type Viewport
} from './model';

type Snapshot = { items: Item[]; settings: SceneSettings };

export type StoreEvent =
  | { type: 'scene' } // escena reemplazada o cambio estructural
  | { type: 'items'; ids: ItemId[] } // cambio en ítems específicos
  | { type: 'selection' }
  | { type: 'viewport' }
  | { type: 'settings' }
  | { type: 'history' };

export type Listener = (e: StoreEvent) => void;

const MAX_HISTORY = 200;

export class Store {
  scene: Scene = createScene();
  selection: Set<ItemId> = new Set();
  dirty = false;

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private txDepth = 0;
  private txSnapshot: Snapshot | null = null;
  private listeners = new Set<Listener>();

  // --- suscripción -------------------------------------------------------

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: StoreEvent) {
    for (const l of this.listeners) l(e);
  }

  // --- escena ------------------------------------------------------------

  loadScene(scene: Scene) {
    this.scene = scene;
    this.selection.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.emit({ type: 'scene' });
    this.emit({ type: 'selection' });
    this.emit({ type: 'viewport' });
    this.emit({ type: 'history' });
  }

  newScene(name?: string) {
    this.loadScene(createScene(name));
  }

  // --- historial ---------------------------------------------------------

  private snapshot(): Snapshot {
    return {
      items: this.scene.items.map((i) => structuredClone(i)),
      settings: structuredClone(this.scene.settings)
    };
  }

  private restore(s: Snapshot) {
    this.scene.items = s.items.map((i) => structuredClone(i));
    this.scene.settings = structuredClone(s.settings);
    const alive = new Set(this.scene.items.map((i) => i.id));
    for (const id of [...this.selection]) if (!alive.has(id)) this.selection.delete(id);
    this.touch();
    this.emit({ type: 'scene' });
    this.emit({ type: 'selection' });
    this.emit({ type: 'history' });
  }

  /**
   * Ejecuta `fn` como un paso de historial. Anidable: sólo el nivel
   * exterior guarda la instantánea.
   */
  commit<T>(fn: () => T): T {
    this.beginTransaction();
    try {
      return fn();
    } finally {
      this.endTransaction();
    }
  }

  beginTransaction() {
    if (this.txDepth === 0) this.txSnapshot = this.snapshot();
    this.txDepth++;
  }

  endTransaction() {
    this.txDepth--;
    if (this.txDepth === 0 && this.txSnapshot) {
      this.undoStack.push(this.txSnapshot);
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
      this.txSnapshot = null;
      this.touch();
      this.emit({ type: 'history' });
    }
  }

  /** Cancela la transacción en curso restaurando el estado previo. */
  cancelTransaction() {
    if (this.txDepth > 0 && this.txSnapshot) {
      const s = this.txSnapshot;
      this.txDepth = 0;
      this.txSnapshot = null;
      this.restore(s);
    }
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
  }

  touch() {
    this.scene.updatedAt = Date.now();
    this.dirty = true;
  }

  // --- ítems -------------------------------------------------------------

  get(id: ItemId): Item | undefined {
    return findItem(this.scene, id);
  }

  addItem(item: Item): Item {
    if (item.z === 0) item.z = nextZ(this.scene, item.parentId);
    this.scene.items.push(item);
    this.touch();
    this.emit({ type: 'scene' });
    return item;
  }

  /** Muta ítems in situ y notifica. Usar dentro de `commit`. */
  update(ids: ItemId | ItemId[], fn: (it: Item) => void) {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
      const it = this.get(id);
      if (it) fn(it);
    }
    this.touch();
    this.emit({ type: 'items', ids: list });
  }

  removeItems(ids: ItemId[]) {
    const toRemove = new Set<ItemId>();
    for (const id of ids) {
      toRemove.add(id);
      for (const d of descendantsOf(this.scene, id)) toRemove.add(d.id);
    }
    this.scene.items = this.scene.items.filter((i) => !toRemove.has(i.id));
    for (const id of toRemove) this.selection.delete(id);
    this.touch();
    this.emit({ type: 'scene' });
    this.emit({ type: 'selection' });
  }

  /** Reasigna padre manteniendo la posición absoluta (las coords ya son absolutas). */
  setParent(ids: ItemId[], parentId: ItemId | null) {
    for (const id of ids) {
      const it = this.get(id);
      if (!it || id === parentId) continue;
      // evitar ciclos
      let cur = parentId;
      let cyclic = false;
      while (cur) {
        if (cur === id) {
          cyclic = true;
          break;
        }
        cur = this.get(cur)?.parentId ?? null;
      }
      if (cyclic) continue;
      it.parentId = parentId;
      it.z = nextZ(this.scene, parentId);
    }
    this.touch();
    this.emit({ type: 'scene' });
  }

  bringToFront(ids: ItemId[]) {
    for (const id of ids) {
      const it = this.get(id);
      if (it) it.z = nextZ(this.scene, it.parentId);
    }
    this.touch();
    this.emit({ type: 'scene' });
  }

  sendToBack(ids: ItemId[]) {
    for (const id of ids) {
      const it = this.get(id);
      if (!it) continue;
      let minZ = Infinity;
      for (const s of this.scene.items) if (s.parentId === it.parentId) minZ = Math.min(minZ, s.z);
      it.z = (Number.isFinite(minZ) ? minZ : 0) - 1;
    }
    this.touch();
    this.emit({ type: 'scene' });
  }

  // --- selección ---------------------------------------------------------

  select(ids: ItemId[], mode: 'replace' | 'add' | 'toggle' = 'replace') {
    if (mode === 'replace') this.selection = new Set(ids);
    else if (mode === 'add') for (const id of ids) this.selection.add(id);
    else for (const id of ids) this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id);
    this.emit({ type: 'selection' });
  }

  clearSelection() {
    if (this.selection.size === 0) return;
    this.selection.clear();
    this.emit({ type: 'selection' });
  }

  selectAll() {
    this.selection = new Set(this.scene.items.filter((i) => i.visible && !i.locked).map((i) => i.id));
    this.emit({ type: 'selection' });
  }

  selectedItems(): Item[] {
    return this.scene.items.filter((i) => this.selection.has(i.id));
  }

  /**
   * Selección "raíz": ítems seleccionados cuyo ancestro no está también
   * seleccionado. Es lo que se transforma en un arrastre (los hijos siguen).
   */
  selectedRoots(): Item[] {
    return this.selectedItems().filter((it) => {
      let cur = it.parentId;
      while (cur) {
        if (this.selection.has(cur)) return false;
        cur = this.get(cur)?.parentId ?? null;
      }
      return true;
    });
  }

  // --- viewport / settings ----------------------------------------------

  setViewport(v: Partial<Viewport>) {
    Object.assign(this.scene.viewport, v);
    this.emit({ type: 'viewport' });
  }

  updateSettings(fn: (s: SceneSettings) => void) {
    fn(this.scene.settings);
    this.touch();
    this.emit({ type: 'settings' });
  }
}

export const store = new Store();
