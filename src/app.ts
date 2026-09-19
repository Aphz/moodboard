/**
 * Núcleo de la aplicación: crea store, renderizador y gestos; registra
 * todos los comandos; gestiona guardado automático, portapapeles,
 * drag & drop, teclado y la creación de notas/dibujos/recortes.
 */
import {
  createDrawingItem,
  createGroupItem,
  createNoteItem,
  createScene,
  descendantsOf,
  itemBounds,
  localToScene,
  sceneToLocal,
  subtreeBounds,
  unionRects,
  type DrawingItem,
  type ImageItem,
  type Item,
  type ItemId,
  type NoteItem,
  type Point,
  type Rect,
  type Scene,
  type Stroke
} from './core/model';
import { store, type Store } from './core/store';
import { registerCommands, runCommand, findByShortcut, keyEventToShortcut, type Command } from './core/commands';
import { appSettings, loadAppSettings, updateAppSettings, onSettingsChange } from './core/settings';
import { deleteScene, getKV, listScenes, loadScene, putBlob, requestPersistence, saveScene, setKV } from './core/persistence';
import { Renderer, renderToCanvas, screenToScene, strokesBounds } from './render/renderer';
import { onBitmapReady, ensureBitmaps } from './render/imageCache';
import { GestureController, type Tool } from './input/gestures';
import { t, setLanguage, detectLanguage } from './i18n';
import {
  alignItems,
  arrangeByColor,
  arrangeColumn,
  arrangeGrid,
  arrangeOptimal,
  arrangeRandom,
  arrangeRow,
  distributeItems,
  normalizeArea,
  normalizeSize,
  stackItems,
  type Placement,
  hueOfHex
} from './features/arrange';
import { importBlobs, importFiles, importFromUrl, entriesFromDataTransfer } from './features/importImages';
import { exportSet, renderItemsToBlob, safeFileName, shareOrDownload } from './features/exportImage';
import { copyBlobToSystemClipboard, copyItems, duplicateItems, hasInternalClip, pasteItems } from './features/clipboard';
import { exportSceneFile, importSceneFile, sceneFileName } from './features/sceneFile';
import { findDuplicateGroups, findSimilar } from './features/phash';
import { isImageFile } from './features/imageTools';
import { getBlob } from './core/persistence';
import { toast, promptDialog, confirmDialog, saveDiscardDialog, closeMenus, clearOverlays } from './ui/dialogs';
import { showCommandPalette } from './ui/commandPalette';
import { openNoteEditor } from './ui/noteEditor';
import { showSettingsDialog } from './ui/settingsDialog';
import { showScenesDialog } from './ui/scenesDialog';
import { showManageImages } from './ui/manageImages';
import { showExportDialog } from './ui/exportDialog';
import { showCommentDialog, showOpacityDialog, showPaletteDialog, showCanvasColorDialog, showShortcutsDialog } from './ui/itemDialogs';
import { showAiDescribe, runAiTagging } from './ui/aiDialogs';
import { Toolbar } from './ui/toolbar';
import { HierarchyPanel } from './ui/hierarchy';
import { SubBar } from './ui/subBar';
import { isTouchDevice } from './ui/dom';

export class App {
  store: Store = store;
  /** Ejecuta un comando por id (útil para pruebas y automatización). */
  run = runCommand;
  canvas = document.getElementById('canvas') as HTMLCanvasElement;
  renderer: Renderer;
  gestures: GestureController;
  toolbar!: Toolbar;
  hierarchy!: HierarchyPanel;
  subBar!: SubBar;
  private autosaveTimer = 0;
  private saving = false;
  private fileInput = document.getElementById('file-input') as HTMLInputElement;
  private pendingImportParent: ItemId | null = null;

  constructor() {
    this.renderer = new Renderer(this.canvas, this.store);
    this.gestures = new GestureController(this.canvas, this.store, this.renderer, {
      onContextMenu: (p, id) => this.toolbar.showContextMenu(p, id),
      onEditItem: (id) => this.editItem(id),
      onStrokeEnd: (s, o) => this.commitStroke(s, o),
      onCropChange: () => this.renderer.requestDraw(),
      onToolChange: (tool) => this.onToolChange(tool)
    });
  }

  // -----------------------------------------------------------------------
  // arranque

  async init() {
    await loadAppSettings();
    setLanguage(appSettings.language || detectLanguage());
    this.applyTheme();
    onSettingsChange(() => {
      this.applyTheme();
      this.scheduleAutosave();
    });

    this.registerAllCommands();
    this.toolbar = new Toolbar(this);
    this.hierarchy = new HierarchyPanel(this);
    this.subBar = new SubBar(this);

    this.store.subscribe((e) => {
      this.renderer.requestDraw();
      if (e.type !== 'viewport' && e.type !== 'selection') this.scheduleAutosave();
      if (e.type === 'selection' && this.gestures.tool === 'crop') {
        const id = this.renderer.overlay.cropId;
        if (id && !this.store.selection.has(id)) this.exitCrop();
      }
      this.updateEmptyHint();
    });
    onBitmapReady(() => this.renderer.requestDraw());

    new ResizeObserver(() => this.renderer.resize()).observe(this.canvas);
    this.renderer.resize();
    this.bindKeyboard();
    this.bindClipboardAndDrop();
    this.bindLifecycle();
    this.fileInput.addEventListener('change', () => this.onFileInput());

    await this.loadLastScene();
    void requestPersistence();
  }

  applyTheme() {
    const th = appSettings.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : appSettings.theme;
    document.documentElement.dataset.theme = th;
  }

  private async loadLastScene() {
    const id = await getKV<string | null>('lastSceneId', null);
    let scene: Scene | null = null;
    if (id) scene = await loadScene(id);
    if (!scene) {
      const list = await listScenes();
      if (list.length) scene = await loadScene(list[0].id);
    }
    this.store.loadScene(scene ?? createScene(t('ui_scene_untitled')));
    if (!scene) this.gestures.fitToView();
    this.updateEmptyHint();
  }

  updateEmptyHint() {
    const el = document.getElementById('empty-hint')!;
    const empty = this.store.scene.items.length === 0;
    el.hidden = !empty;
    if (empty) el.textContent = t('ui_empty_hint');
  }

  // -----------------------------------------------------------------------
  // guardado

  scheduleAutosave() {
    if (!appSettings.autosaveMs) return;
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => void this.save(true), appSettings.autosaveMs);
  }

  async makeThumbnail(): Promise<Blob | null> {
    if (!appSettings.generateThumbnails) return null;
    const items = this.store.scene.items.filter((i) => i.kind !== 'group' && i.visible);
    const b = unionRects(items.map(itemBounds));
    if (!b) return null;
    try {
      await ensureBitmaps(items.filter((i): i is ImageItem => i.kind === 'image').map((i) => i.blobId));
      const scale = Math.min(1, 320 / Math.max(b.w, b.h));
      const c = renderToCanvas(this.renderer, items, b, scale, this.store.scene.settings.canvasColor === 'transparent' ? '#1e1e1e' : this.store.scene.settings.canvasColor);
      return await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.75));
    } catch {
      return null;
    }
  }

  async save(silent = false): Promise<void> {
    if (this.saving) return;
    if (!this.store.dirty && silent) return;
    this.saving = true;
    try {
      const thumb = await this.makeThumbnail();
      await saveScene(this.store.scene, thumb);
      this.store.dirty = false;
      this.toolbar.refresh();
      if (!silent) toast(t('ui_save') + ' ✓', { ms: 1200 });
    } catch (e) {
      console.error(e);
      if (!silent) toast(String(e), { error: true });
    } finally {
      this.saving = false;
    }
  }

  /** Pregunta por cambios pendientes; devuelve false si el usuario cancela. */
  async confirmDiscard(): Promise<boolean> {
    if (!this.store.dirty) return true;
    if (appSettings.autosaveMs) {
      await this.save(true);
      return true;
    }
    const r = await saveDiscardDialog(t('ui_unsaved_changes'));
    if (r === 'cancel') return false;
    if (r === 'save') await this.save();
    return true;
  }

  async openSceneById(id: string) {
    if (!(await this.confirmDiscard())) return;
    const s = await loadScene(id);
    if (!s) return;
    this.exitModes();
    this.store.loadScene(s);
    await setKV('lastSceneId', s.id);
    this.hierarchy.refresh();
    this.toolbar.refresh();
    this.updateEmptyHint();
  }

  async newScene() {
    if (!(await this.confirmDiscard())) return;
    this.exitModes();
    this.store.loadScene(createScene(t('ui_scene_untitled')));
    this.gestures.fitToView();
    this.store.dirty = true;
    await this.save(true);
    this.hierarchy.refresh();
    this.toolbar.refresh();
  }

  async deleteSceneById(id: string) {
    await deleteScene(id);
    if (this.store.scene.id === id) {
      const list = await listScenes();
      if (list.length) await this.openSceneById(list[0].id);
      else {
        this.store.loadScene(createScene(t('ui_scene_untitled')));
        await this.save(true);
      }
    }
  }

  // -----------------------------------------------------------------------
  // helpers de escena

  viewCenter(): Point {
    return screenToScene(this.store.scene.viewport, { x: this.renderer.width / 2, y: this.renderer.height / 2 });
  }

  viewAspect(): number {
    return Math.max(0.4, Math.min(3, this.renderer.width / Math.max(1, this.renderer.height)));
  }

  roots(): Item[] {
    return this.store.selectedRoots();
  }

  /** Aplica una lista de Placement como paso de historial. */
  applyPlacements(pl: Placement[]) {
    if (pl.length === 0) return;
    this.store.commit(() => {
      const byId = new Map(pl.map((p) => [p.id, p]));
      // mover también descendientes con el mismo desplazamiento de su raíz
      for (const p of pl) {
        const it = this.store.get(p.id);
        if (!it) continue;
        const dx = p.x - it.x, dy = p.y - it.y;
        const k = p.scale !== undefined && it.scale ? p.scale / it.scale : 1;
        const desc = descendantsOf(this.store.scene, it.id);
        this.store.update([it.id, ...desc.map((d) => d.id)], (x) => {
          if (x.id === it.id) {
            x.x = p.x;
            x.y = p.y;
            if (p.scale !== undefined) x.scale = p.scale;
          } else {
            // hijos: trasladar y escalar respecto al centro de la raíz
            x.x = p.x + (x.x - it.x) * k;
            x.y = p.y + (x.y - it.y) * k;
            if (k !== 1) x.scale *= k;
          }
          void dx;
          void dy;
        });
      }
      void byId;
    });
  }

  /** Raíces seleccionadas como "ítems de arreglo" (grupos usan la caja del subárbol). */
  private arrangeInputs(): Item[] {
    const roots = this.roots().filter((r) => !r.locked);
    // para grupos, creamos un proxy con la caja del subárbol
    return roots.map((r) => {
      if (r.kind !== 'group') return r;
      const b = subtreeBounds(this.store.scene, r.id) ?? { x: r.x, y: r.y, w: 1, h: 1 };
      return { ...r, x: b.x + b.w / 2, y: b.y + b.h / 2, w: b.w, h: b.h, scale: 1, rotation: 0 } as Item;
    });
  }

  /** Si hay <2 seleccionados, organiza todo el nivel raíz. */
  private arrangeTargets(): Item[] {
    const sel = this.arrangeInputs();
    if (sel.length >= 2) return sel;
    this.store.select(this.store.scene.items.filter((i) => !i.parentId && !i.locked && i.visible).map((i) => i.id));
    return this.arrangeInputs();
  }

  private arrangeOpts() {
    return { padding: this.store.scene.settings.alignPadding, aspect: this.viewAspect(), seed: Date.now() & 0xffff };
  }

  private arrangeWith(fn: (items: Item[]) => Placement[]) {
    const items = this.arrangeTargets();
    if (items.length === 0) return;
    // los grupos-proxy tienen coordenadas distintas al ítem real: traducir el desplazamiento
    const pl = fn(items);
    const fixed = pl.map((p) => {
      const proxy = items.find((i) => i.id === p.id)!;
      const real = this.store.get(p.id)!;
      if (real.kind !== 'group') return p;
      return { ...p, x: real.x + (p.x - proxy.x), y: real.y + (p.y - proxy.y), scale: undefined };
    });
    this.applyPlacements(fixed);
  }

  // -----------------------------------------------------------------------
  // modos

  exitModes() {
    this.exitCrop();
    if (this.gestures.tool === 'draw') this.gestures.setTool('select');
    closeMenus();
  }

  private onToolChange(tool: Tool) {
    this.subBar.update(tool);
    this.toolbar.refresh();
  }

  toggleDraw() {
    this.gestures.setTool(this.gestures.tool === 'draw' ? 'select' : 'draw');
  }

  enterCrop() {
    const sel = this.store.selectedItems().filter((i): i is ImageItem => i.kind === 'image' && !i.locked);
    if (sel.length !== 1) return;
    this.store.select([sel[0].id]);
    this.renderer.overlay.cropId = sel[0].id;
    this.gestures.setTool('crop');
  }

  exitCrop() {
    if (this.gestures.tool !== 'crop') return;
    this.renderer.overlay.cropId = null;
    this.gestures.setTool('select');
  }

  resetCrop(id: ItemId) {
    this.store.commit(() =>
      this.store.update(id, (it) => {
        if (it.kind !== 'image' || !it.crop) return;
        // recolocar el centro en el centro del bitmap completo
        const c = it.crop;
        const offLocal = { x: ((c.right - c.left) / 2) * it.w, y: ((c.bottom - c.top) / 2) * it.h };
        const p = localToScene(it, offLocal);
        it.x = p.x;
        it.y = p.y;
        it.crop = null;
      })
    );
  }

  // -----------------------------------------------------------------------
  // notas y dibujos

  /** Padre automático: imagen o grupo seleccionado único. */
  private autoParentTarget(): ItemId | null {
    if (!appSettings.autoParent) return null;
    const roots = this.roots();
    if (roots.length === 1 && (roots[0].kind === 'image' || roots[0].kind === 'group')) return roots[0].id;
    return null;
  }

  createNote(at?: Point, text = '') {
    const parent = this.autoParentTarget();
    let pos = at ?? this.viewCenter();
    if (parent && !at) {
      const b = subtreeBounds(this.store.scene, parent);
      if (b) pos = { x: b.x + b.w / 2, y: b.y + b.h + 80 };
    }
    const scale = 1 / this.store.scene.viewport.zoom;
    const note = createNoteItem(text, { x: pos.x, y: pos.y, scale: Math.max(0.25, Math.min(4, scale)), parentId: parent });
    this.store.commit(() => this.store.addItem(note));
    this.store.select([note.id]);
    if (!text) this.editItem(note.id);
    return note;
  }

  editItem(id: ItemId) {
    const it = this.store.get(id);
    if (!it) return;
    if (it.kind === 'note') openNoteEditor(this, it);
    else if (it.kind === 'image') this.gestures.fitRect(itemBounds(it), 60);
    else if (it.kind === 'group') this.gestures.fitRect(subtreeBounds(this.store.scene, id), 60);
    else void showCommentDialog(this, it);
  }

  private commitStroke(stroke: Stroke, origin: Point) {
    const roots = this.roots();
    const existing = roots.length === 1 && roots[0].kind === 'drawing' && !roots[0].locked ? (roots[0] as DrawingItem) : null;
    this.store.commit(() => {
      if (existing) {
        // convertir puntos de escena a locales del dibujo existente
        const localPts = stroke.points.map((p) => {
          const l = sceneToLocal(existing, { x: origin.x + p.x, y: origin.y + p.y });
          return { x: l.x, y: l.y, p: p.p };
        });
        this.store.update(existing.id, (it) => {
          if (it.kind !== 'drawing') return;
          it.strokes.push({ ...stroke, width: stroke.width / it.scale, points: localPts });
          this.recenterDrawing(it);
        });
        return;
      }
      const parent = this.autoParentTarget();
      const d = createDrawingItem({ x: origin.x, y: origin.y, parentId: parent, opacity: this.gestures.draw.opacity });
      d.strokes.push(stroke);
      this.recenterDrawing(d);
      this.store.addItem(d);
      this.store.select([d.id]);
    });
  }

  /** Ajusta centro y tamaño del dibujo a sus trazos (coordenadas locales). */
  private recenterDrawing(it: DrawingItem) {
    const b = strokesBounds(it.strokes);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const newCenter = localToScene(it, { x: cx, y: cy });
    for (const s of it.strokes) for (const p of s.points) {
      p.x -= cx;
      p.y -= cy;
    }
    it.x = newCenter.x;
    it.y = newCenter.y;
    it.w = Math.max(1, b.w);
    it.h = Math.max(1, b.h);
  }

  // -----------------------------------------------------------------------
  // importación

  promptImport(parentId: ItemId | null = null) {
    this.pendingImportParent = parentId;
    this.fileInput.value = '';
    this.fileInput.click();
  }

  private async onFileInput() {
    const files = [...(this.fileInput.files ?? [])];
    if (!files.length) return;
    const sceneFiles = files.filter((f) => /\.moodboard$/i.test(f.name) || f.type === 'application/zip');
    for (const f of sceneFiles) await this.importSceneFromBlob(f);
    const imgs = files.filter(isImageFile);
    if (imgs.length) {
      const items = await importBlobs(this.store, imgs.map((f) => ({ blob: f, name: f.name })), this.viewCenter(), { parentId: this.pendingImportParent });
      if (items.length) this.gestures.fitSelection();
    }
    this.pendingImportParent = null;
  }

  async importSceneFromBlob(blob: Blob) {
    try {
      if (!(await this.confirmDiscard())) return;
      const scene = await importSceneFile(blob, (id, b, w, h) => putBlob(id, b, w, h));
      this.store.loadScene(scene);
      this.store.dirty = true;
      await this.save(true);
      this.gestures.fitToView();
      this.hierarchy.refresh();
      this.toolbar.refresh();
    } catch (e) {
      toast(String((e as Error).message ?? e), { error: true });
    }
  }

  async pasteFromSystem(at?: Point) {
    const pos = at ?? this.viewCenter();
    // 1) portapapeles del sistema (iOS 13.4+, requiere gesto)
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        const blobs: { blob: Blob; name: string }[] = [];
        let text = '';
        for (const ci of items) {
          const imgType = ci.types.find((tp) => tp.startsWith('image/'));
          if (imgType) blobs.push({ blob: await ci.getType(imgType), name: `pegado-${Date.now()}.png` });
          else if (ci.types.includes('text/plain')) text = await (await ci.getType('text/plain')).text();
        }
        if (blobs.length) {
          await importBlobs(this.store, blobs, pos);
          return;
        }
        if (text && /^https?:\/\/\S+$/.test(text.trim())) {
          await importFromUrl(this.store, text.trim(), pos);
          return;
        }
        if (hasInternalClip()) {
          pasteItems(this.store, pos);
          return;
        }
        if (text.trim()) {
          this.createNote(pos, text.trim());
          return;
        }
      }
    } catch {
      /* sin permiso o no soportado: caer al portapapeles interno */
    }
    if (hasInternalClip()) pasteItems(this.store, pos);
  }

  private bindClipboardAndDrop() {
    document.addEventListener('paste', async (e) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (!e.clipboardData) return;
      const { blobs, urls, text } = await entriesFromDataTransfer(e.clipboardData);
      const pos = this.viewCenter();
      if (blobs.length) {
        e.preventDefault();
        await importBlobs(this.store, blobs, pos);
      } else if (urls.length) {
        e.preventDefault();
        for (const u of urls.slice(0, 10)) await importFromUrl(this.store, u, pos);
      } else if (hasInternalClip()) {
        e.preventDefault();
        pasteItems(this.store, pos);
      } else if (text.trim()) {
        e.preventDefault();
        this.createNote(pos, text.trim());
      }
    });
    const app = document.getElementById('app')!;
    let depth = 0;
    app.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      app.classList.add('drop-active');
    });
    app.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    app.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) app.classList.remove('drop-active');
    });
    app.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      app.classList.remove('drop-active');
      if (!e.dataTransfer) return;
      const r = this.canvas.getBoundingClientRect();
      const pos = screenToScene(this.store.scene.viewport, { x: e.clientX - r.left, y: e.clientY - r.top });
      const files = [...e.dataTransfer.files];
      const sceneFiles = files.filter((f) => /\.moodboard$/i.test(f.name));
      for (const f of sceneFiles) await this.importSceneFromBlob(f);
      const { blobs, urls, text } = await entriesFromDataTransfer(e.dataTransfer);
      if (blobs.length) await importBlobs(this.store, blobs, pos);
      else if (urls.length) for (const u of urls.slice(0, 10)) await importFromUrl(this.store, u, pos);
      else if (text.trim()) this.createNote(pos, text.trim());
    });
  }

  private bindLifecycle() {
    const flush = () => {
      if (this.store.dirty) void this.save(true);
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
  }

  // -----------------------------------------------------------------------
  // teclado

  private bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      const editing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (e.key === ' ' && !editing) {
        this.gestures.spaceDown = true;
        e.preventDefault();
        return;
      }
      if (editing) return;
      if (e.key === 'Escape') {
        if (document.querySelector('#overlay-root .dialog, #overlay-root .menu, #overlay-root .cmdp')) return; // lo gestiona el diálogo
        if (this.gestures.tool !== 'select') this.exitModes();
        else this.store.clearSelection();
        return;
      }
      if (e.key.startsWith('Arrow')) {
        const roots = this.roots().filter((r) => !r.locked);
        if (roots.length) {
          e.preventDefault();
          const step = (e.shiftKey ? 10 : 1) / this.store.scene.viewport.zoom;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          const ids = roots.flatMap((r) => [r.id, ...descendantsOf(this.store.scene, r.id).map((d) => d.id)]);
          this.store.commit(() =>
            this.store.update(ids, (it) => {
              it.x += dx;
              it.y += dy;
            })
          );
          return;
        }
      }
      const sc = keyEventToShortcut(e);
      const cmd = findByShortcut(sc);
      if (cmd) {
        e.preventDefault();
        void runCommand(cmd.id);
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.key === ' ') this.gestures.spaceDown = false;
    });
  }

  // -----------------------------------------------------------------------
  // comandos

  private registerAllCommands() {
    const S = this.store;
    const hasSel = () => S.selection.size > 0;
    const hasImg = () => S.selectedItems().some((i) => i.kind === 'image');
    const oneImg = () => S.selectedItems().filter((i) => i.kind === 'image').length === 1;
    const multi = () => this.roots().length >= 2 || S.scene.items.length >= 2;
    const cmds: Command[] = [
      // archivo
      { id: 'new', title: 'cmd_new', category: 'file', icon: 'file', shortcut: 'Mod+N', run: () => this.newScene() },
      { id: 'open', title: 'cmd_open', category: 'file', icon: 'open', shortcut: 'Mod+O', run: () => showScenesDialog(this) },
      { id: 'save', title: 'cmd_save', category: 'file', icon: 'save', shortcut: 'Mod+S', run: () => this.save() },
      {
        id: 'rename_scene', title: 'cmd_rename_scene', category: 'file', icon: 'text',
        run: async () => {
          const n = await promptDialog(t('ui_name'), S.scene.name);
          if (n !== null && n.trim()) {
            S.scene.name = n.trim();
            S.touch();
            S.emit({ type: 'scene' });
            this.toolbar.refresh();
          }
        }
      },
      { id: 'import_images', title: 'cmd_import_images', category: 'file', icon: 'photo', shortcut: 'Mod+I', run: () => this.promptImport() },
      {
        id: 'import_url', title: 'cmd_import_url', category: 'file', icon: 'link',
        run: async () => {
          const u = await promptDialog(t('ui_url_prompt'), '', { type: 'url', placeholder: 'https://…' });
          if (u) await importFromUrl(S, u.trim(), this.viewCenter());
        }
      },
      { id: 'export_png', title: 'cmd_export_png', category: 'file', icon: 'export', shortcut: 'Mod+E', run: () => showExportDialog(this, 'scene') },
      { id: 'export_selection_png', title: 'cmd_export_selection_png', category: 'file', icon: 'export', shortcut: 'Mod+Shift+E', enabled: hasSel, run: () => showExportDialog(this, 'selection') },
      {
        id: 'export_scene_file', title: 'cmd_export_scene_file', category: 'file', icon: 'download',
        run: async () => {
          const tt = toast(t('ui_exporting'), { spinner: true });
          try {
            const only = S.selection.size ? new Set(this.roots().map((r) => r.id)) : undefined;
            const blob = await exportSceneFile(S.scene, getBlob, only ? { onlyItems: only } : undefined);
            await shareOrDownload(blob, sceneFileName(S.scene), S.scene.name);
          } finally {
            tt.close();
          }
        }
      },
      { id: 'import_scene_file', title: 'cmd_import_scene_file', category: 'file', icon: 'folder', run: () => this.promptImport() },
      { id: 'manage_images', title: 'cmd_manage_images', category: 'file', icon: 'image', run: () => showManageImages(this) },
      { id: 'share', title: 'cmd_share', category: 'file', icon: 'share', run: () => showExportDialog(this, 'scene') },
      // edición
      { id: 'undo', title: 'cmd_undo', category: 'edit', icon: 'undo', shortcut: 'Mod+Z', enabled: () => S.canUndo, run: () => S.undo() },
      { id: 'redo', title: 'cmd_redo', category: 'edit', icon: 'redo', shortcut: 'Mod+Shift+Z', enabled: () => S.canRedo, run: () => S.redo() },
      {
        id: 'cut', title: 'cmd_cut', category: 'edit', shortcut: 'Mod+X', enabled: hasSel,
        run: () => {
          copyItems(S, this.roots());
          S.commit(() => S.removeItems(this.roots().map((r) => r.id)));
        }
      },
      {
        id: 'copy', title: 'cmd_copy', category: 'edit', icon: 'copy', shortcut: 'Mod+C', enabled: hasSel,
        run: async () => {
          const n = copyItems(S, this.roots());
          // también como imagen al sistema (asíncrono, sin bloquear)
          void this.copySelectionAsImage(true);
          toast(`${t('ui_copied')} (${n})`, { ms: 1000 });
        }
      },
      { id: 'copy_as_image', title: 'cmd_copy_as_image', category: 'edit', icon: 'image', shortcut: 'Mod+Shift+C', enabled: hasSel, run: () => this.copySelectionAsImage(false) },
      { id: 'paste', title: 'cmd_paste', category: 'edit', icon: 'clipboard', shortcut: 'Mod+V', run: () => this.pasteFromSystem() },
      { id: 'duplicate', title: 'cmd_duplicate', category: 'edit', icon: 'duplicate', shortcut: 'Mod+D', enabled: hasSel, run: () => void duplicateItems(S, this.roots()) },
      {
        id: 'delete', title: 'cmd_delete', category: 'edit', icon: 'trash', shortcut: 'Backspace', enabled: hasSel,
        run: () => S.commit(() => S.removeItems(this.roots().filter((r) => !r.locked).map((r) => r.id)))
      },
      { id: 'delete2', title: 'cmd_delete', category: 'edit', shortcut: 'Delete', enabled: hasSel, run: () => void runCommand('delete') },
      { id: 'select_all', title: 'cmd_select_all', category: 'edit', shortcut: 'Mod+A', run: () => S.selectAll() },
      { id: 'deselect', title: 'cmd_deselect', category: 'edit', shortcut: 'Mod+Shift+A', enabled: hasSel, run: () => S.clearSelection() },
      {
        id: 'invert_selection', title: 'cmd_invert_selection', category: 'edit', shortcut: 'Mod+Shift+I',
        run: () => S.select(S.scene.items.filter((i) => !S.selection.has(i.id) && i.visible && i.kind !== 'group').map((i) => i.id))
      },
      // vista
      { id: 'zoom_in', title: 'cmd_zoom_in', category: 'view', icon: 'zoomIn', shortcut: 'Mod+=', run: () => this.gestures.zoomAt({ x: this.renderer.width / 2, y: this.renderer.height / 2 }, 1.25) },
      { id: 'zoom_in2', title: 'cmd_zoom_in', category: 'view', shortcut: 'Mod++', run: () => void runCommand('zoom_in') },
      { id: 'zoom_out', title: 'cmd_zoom_out', category: 'view', icon: 'zoomOut', shortcut: 'Mod+-', run: () => this.gestures.zoomAt({ x: this.renderer.width / 2, y: this.renderer.height / 2 }, 0.8) },
      { id: 'zoom_100', title: 'cmd_zoom_100', category: 'view', shortcut: 'Mod+0', run: () => this.gestures.zoomAt({ x: this.renderer.width / 2, y: this.renderer.height / 2 }, 1 / S.scene.viewport.zoom) },
      { id: 'zoom_fit', title: 'cmd_zoom_fit', category: 'view', icon: 'fit', shortcut: 'Mod+1', run: () => this.gestures.fitToView() },
      { id: 'zoom_selection', title: 'cmd_zoom_selection', category: 'view', icon: 'fit', shortcut: 'Mod+2', enabled: hasSel, run: () => this.gestures.fitSelection() },
      {
        id: 'toggle_grid', title: 'cmd_toggle_grid', category: 'view', icon: 'grid', shortcut: 'G',
        run: () => S.updateSettings((s) => {
          s.grid.enabled = !s.grid.enabled;
          if (s.grid.enabled) s.grid.snap = true;
        })
      },
      { id: 'toggle_snap', title: 'cmd_toggle_snap', category: 'view', shortcut: 'Shift+G', run: () => S.updateSettings((s) => (s.grid.snap = !s.grid.snap)) },
      { id: 'toggle_hierarchy', title: 'cmd_toggle_hierarchy', category: 'view', icon: 'layers', shortcut: 'H', run: () => this.hierarchy.toggle() },
      { id: 'canvas_color', title: 'cmd_canvas_color', category: 'view', icon: 'palette', run: () => showCanvasColorDialog(this) },
      { id: 'settings', title: 'cmd_settings', category: 'view', icon: 'settings', shortcut: 'Mod+,', run: () => showSettingsDialog(this) },
      { id: 'command_palette', title: 'cmd_command_palette', category: 'view', icon: 'command', shortcut: 'Mod+K', run: () => showCommandPalette(this) },
      { id: 'command_palette2', title: 'cmd_command_palette', category: 'view', shortcut: 'F3', run: () => showCommandPalette(this) },
      { id: 'shortcuts', title: 'cmd_shortcuts', category: 'view', icon: 'keyboard', shortcut: 'Mod+/', run: () => showShortcutsDialog() },
      // organizar
      { id: 'arrange_optimal', title: 'cmd_arrange_optimal', category: 'arrange', icon: 'arrange', shortcut: 'Mod+Shift+O', enabled: multi, run: () => this.arrangeWith((i) => arrangeOptimal(i, this.arrangeOpts())) },
      { id: 'arrange_grid', title: 'cmd_arrange_grid', category: 'arrange', icon: 'grid', shortcut: 'Mod+Shift+G', enabled: multi, run: () => this.arrangeWith((i) => arrangeGrid(i, this.arrangeOpts())) },
      { id: 'arrange_horizontal', title: 'cmd_arrange_horizontal', category: 'arrange', shortcut: 'Mod+Shift+H', enabled: multi, run: () => this.arrangeWith((i) => arrangeRow(i, this.arrangeOpts())) },
      { id: 'arrange_vertical', title: 'cmd_arrange_vertical', category: 'arrange', shortcut: 'Mod+Shift+V', enabled: multi, run: () => this.arrangeWith((i) => arrangeColumn(i, this.arrangeOpts())) },
      { id: 'arrange_random', title: 'cmd_arrange_random', category: 'arrange', shortcut: 'Mod+Alt+R', enabled: multi, run: () => this.arrangeWith((i) => arrangeRandom(i, this.arrangeOpts())) },
      {
        id: 'arrange_by_color', title: 'cmd_arrange_by_color', category: 'arrange', icon: 'palette', enabled: multi,
        run: () => this.arrangeWith((i) => arrangeByColor(i, this.arrangeOpts(), (it) => (it.kind === 'image' && it.palette[0] ? hueOfHex(it.palette[0]) : null)))
      },
      { id: 'normalize_size', title: 'cmd_normalize_size', category: 'arrange', enabled: multi, run: () => this.applyPlacements(normalizeSize(this.roots().filter((r) => r.kind !== 'group' && !r.locked))) },
      { id: 'normalize_area', title: 'cmd_normalize_area', category: 'arrange', enabled: multi, run: () => this.applyPlacements(normalizeArea(this.roots().filter((r) => r.kind !== 'group' && !r.locked))) },
      { id: 'align_left', title: 'cmd_align_left', category: 'arrange', icon: 'alignL', enabled: multi, run: () => this.arrangeWith((i) => alignItems(i, 'left', 0)) },
      { id: 'align_right', title: 'cmd_align_right', category: 'arrange', icon: 'alignR', enabled: multi, run: () => this.arrangeWith((i) => alignItems(i, 'right', 0)) },
      { id: 'align_top', title: 'cmd_align_top', category: 'arrange', enabled: multi, run: () => this.arrangeWith((i) => alignItems(i, 'top', 0)) },
      { id: 'align_bottom', title: 'cmd_align_bottom', category: 'arrange', enabled: multi, run: () => this.arrangeWith((i) => alignItems(i, 'bottom', 0)) },
      { id: 'align_center_h', title: 'cmd_align_center_h', category: 'arrange', icon: 'alignC', enabled: multi, run: () => this.arrangeWith((i) => alignItems(i, 'centerH', 0)) },
      { id: 'align_center_v', title: 'cmd_align_center_v', category: 'arrange', enabled: multi, run: () => this.arrangeWith((i) => alignItems(i, 'centerV', 0)) },
      { id: 'distribute_h', title: 'cmd_distribute_h', category: 'arrange', enabled: multi, run: () => this.arrangeWith((i) => distributeItems(i, 'h')) },
      { id: 'distribute_v', title: 'cmd_distribute_v', category: 'arrange', enabled: multi, run: () => this.arrangeWith((i) => distributeItems(i, 'v')) },
      { id: 'stack_h', title: 'cmd_stack_h', category: 'arrange', enabled: multi, run: () => this.arrangeWith((i) => stackItems(i, 'h', S.scene.settings.alignPadding)) },
      { id: 'stack_v', title: 'cmd_stack_v', category: 'arrange', enabled: multi, run: () => this.arrangeWith((i) => stackItems(i, 'v', S.scene.settings.alignPadding)) },
      // ítem
      { id: 'group', title: 'cmd_group', category: 'item', icon: 'group', shortcut: 'Mod+G', enabled: hasSel, run: () => this.groupSelection() },
      { id: 'ungroup', title: 'cmd_ungroup', category: 'item', icon: 'ungroup', shortcut: 'Mod+Shift+U', enabled: () => S.selectedItems().some((i) => i.kind === 'group'), run: () => this.ungroupSelection() },
      { id: 'parent', title: 'cmd_parent', category: 'item', icon: 'parent', shortcut: 'P', enabled: () => this.roots().length >= 2, run: () => this.parentSelection() },
      { id: 'unparent', title: 'cmd_unparent', category: 'item', icon: 'unparent', shortcut: 'Shift+P', enabled: () => S.selectedItems().some((i) => i.parentId), run: () => S.commit(() => S.setParent(S.selectedItems().map((i) => i.id), null)) },
      { id: 'lock', title: 'cmd_lock', category: 'item', icon: 'lock', shortcut: 'Mod+L', enabled: hasSel, run: () => S.commit(() => S.update([...S.selection], (i) => (i.locked = true))) },
      { id: 'unlock', title: 'cmd_unlock', category: 'item', icon: 'unlock', shortcut: 'Mod+Shift+L', enabled: () => S.selectedItems().some((i) => i.locked), run: () => S.commit(() => S.update([...S.selection], (i) => (i.locked = false))) },
      { id: 'hide', title: 'cmd_hide', category: 'item', icon: 'eyeOff', shortcut: 'Mod+Shift+.', enabled: hasSel, run: () => S.commit(() => { S.update([...S.selection], (i) => (i.visible = false)); S.clearSelection(); }) },
      { id: 'show_all', title: 'cmd_show_all', category: 'item', icon: 'eye', enabled: () => S.scene.items.some((i) => !i.visible), run: () => S.commit(() => S.update(S.scene.items.map((i) => i.id), (i) => (i.visible = true))) },
      { id: 'bring_front', title: 'cmd_bring_front', category: 'item', icon: 'front', shortcut: 'Mod+]', enabled: hasSel, run: () => S.commit(() => S.bringToFront(this.roots().map((r) => r.id))) },
      { id: 'send_back', title: 'cmd_send_back', category: 'item', icon: 'back', shortcut: 'Mod+[', enabled: hasSel, run: () => S.commit(() => S.sendToBack(this.roots().map((r) => r.id))) },
      { id: 'flip_h', title: 'cmd_flip_h', category: 'item', icon: 'flipH', shortcut: 'Shift+H', enabled: hasSel, run: () => S.commit(() => S.update([...S.selection], (i) => (i.flipX = !i.flipX))) },
      { id: 'flip_v', title: 'cmd_flip_v', category: 'item', icon: 'flipV', shortcut: 'Shift+V', enabled: hasSel, run: () => S.commit(() => S.update([...S.selection], (i) => (i.flipY = !i.flipY))) },
      { id: 'rotate_cw', title: 'cmd_rotate_cw', category: 'item', icon: 'rotate', shortcut: 'R', enabled: hasSel, run: () => this.rotateSelection(Math.PI / 2) },
      { id: 'rotate_ccw', title: 'cmd_rotate_ccw', category: 'item', shortcut: 'Shift+R', enabled: hasSel, run: () => this.rotateSelection(-Math.PI / 2) },
      {
        id: 'reset_transform', title: 'cmd_reset_transform', category: 'item', shortcut: 'Mod+R', enabled: hasSel,
        run: () => S.commit(() => S.update([...S.selection], (i) => { i.rotation = 0; i.flipX = false; i.flipY = false; if (i.kind === 'image') i.scale = 1; }))
      },
      { id: 'crop', title: 'cmd_crop', category: 'item', icon: 'crop', shortcut: 'C', enabled: oneImg, run: () => this.enterCrop() },
      { id: 'discard_crop', title: 'cmd_discard_crop', category: 'item', enabled: () => S.selectedItems().some((i) => i.kind === 'image' && i.crop), run: () => { for (const i of S.selectedItems()) if (i.kind === 'image' && i.crop) this.resetCrop(i.id); } },
      { id: 'replace_image', title: 'cmd_replace_image', category: 'item', icon: 'replace', enabled: oneImg, run: () => this.replaceImage() },
      { id: 'edit_item', title: 'cmd_edit_item', category: 'item', shortcut: 'Enter', enabled: () => this.roots().length === 1, run: () => this.editItem(this.roots()[0].id) },
      { id: 'comment', title: 'cmd_comment', category: 'item', icon: 'comment', shortcut: 'Mod+Shift+M', enabled: () => this.roots().length === 1, run: () => showCommentDialog(this, this.roots()[0]) },
      {
        id: 'rename', title: 'cmd_rename', category: 'item', icon: 'text', shortcut: 'F2', enabled: () => this.roots().length === 1,
        run: async () => {
          const it = this.roots()[0];
          const n = await promptDialog(t('ui_name'), it.name);
          if (n !== null) S.commit(() => S.update(it.id, (i) => (i.name = n.trim() || i.name)));
        }
      },
      { id: 'opacity', title: 'cmd_opacity', category: 'item', enabled: hasSel, run: () => showOpacityDialog(this) },
      { id: 'extract_palette', title: 'cmd_extract_palette', category: 'item', icon: 'palette', enabled: hasImg, run: () => showPaletteDialog(this) },
      { id: 'add_palette_note', title: 'cmd_add_palette_note', category: 'item', icon: 'palette', enabled: hasImg, run: () => this.addPaletteNote() },
      // herramientas
      { id: 'tool_select', title: 'cmd_tool_select', category: 'tools', icon: 'select', shortcut: 'V', run: () => this.gestures.setTool('select') },
      { id: 'tool_pan', title: 'cmd_tool_pan', category: 'tools', icon: 'hand', shortcut: 'M', run: () => this.gestures.setTool(this.gestures.tool === 'pan' ? 'select' : 'pan') },
      { id: 'tool_lasso', title: 'ui_lasso', category: 'tools', icon: 'lasso', shortcut: 'L', run: () => this.gestures.setTool(this.gestures.tool === 'lasso' ? 'select' : 'lasso') },
      { id: 'tool_note', title: 'cmd_tool_note', category: 'tools', icon: 'note', shortcut: 'N', run: () => void this.createNote() },
      { id: 'toggle_draw', title: 'cmd_toggle_draw', category: 'tools', icon: 'pen', shortcut: 'D', run: () => this.toggleDraw() },
      { id: 'tool_draw_pen', title: 'cmd_tool_draw', category: 'tools', icon: 'pen', run: () => this.setDrawTool('pen') },
      { id: 'tool_draw_line', title: 'cmd_tool_line', category: 'tools', icon: 'line', run: () => this.setDrawTool('line') },
      { id: 'tool_draw_rect', title: 'cmd_tool_rect', category: 'tools', icon: 'rect', run: () => this.setDrawTool('rect') },
      { id: 'tool_draw_ellipse', title: 'cmd_tool_ellipse', category: 'tools', icon: 'ellipse', run: () => this.setDrawTool('ellipse') },
      { id: 'tool_draw_arrow', title: 'cmd_tool_arrow', category: 'tools', icon: 'arrow', run: () => this.setDrawTool('arrow') },
      // IA / análisis
      { id: 'ai_describe', title: 'cmd_ai_describe', category: 'ai', icon: 'sparkles', run: () => showAiDescribe(this) },
      { id: 'ai_tag', title: 'cmd_ai_tag', category: 'ai', icon: 'tag', enabled: hasImg, run: () => runAiTagging(this) },
      { id: 'ai_find_similar', title: 'cmd_ai_find_similar', category: 'ai', icon: 'similar', enabled: oneImg, run: () => this.findSimilarToSelection() },
      { id: 'find_duplicates', title: 'cmd_find_duplicates', category: 'ai', icon: 'similar', run: () => this.findDuplicates() }
    ];
    registerCommands(cmds);
  }

  setDrawTool(tool: DrawingItem['strokes'][number]['tool']) {
    this.gestures.draw.tool = tool;
    if (this.gestures.tool !== 'draw') this.gestures.setTool('draw');
    this.subBar.update('draw');
  }

  // -----------------------------------------------------------------------
  // operaciones sobre ítems

  groupSelection() {
    const S = this.store;
    const roots = this.roots();
    if (roots.length === 0) return;
    S.commit(() => {
      // si hay un grupo seleccionado, los demás entran en él
      const existing = roots.find((r) => r.kind === 'group');
      if (existing && roots.length > 1) {
        S.setParent(roots.filter((r) => r.id !== existing.id).map((r) => r.id), existing.id);
        S.select([existing.id]);
        return;
      }
      const parentId = roots.every((r) => r.parentId === roots[0].parentId) ? roots[0].parentId : null;
      const b = unionRects(roots.map((r) => subtreeBounds(S.scene, r.id) ?? itemBounds(r)))!;
      const g = createGroupItem({ name: t('ui_group_default'), x: b.x + b.w / 2, y: b.y + b.h / 2, w: b.w, h: b.h, parentId });
      S.addItem(g);
      S.setParent(roots.map((r) => r.id), g.id);
      S.select([g.id]);
    });
  }

  ungroupSelection() {
    const S = this.store;
    const groups = S.selectedItems().filter((i) => i.kind === 'group');
    if (!groups.length) return;
    S.commit(() => {
      const freed: ItemId[] = [];
      for (const g of groups) {
        const kids = S.scene.items.filter((i) => i.parentId === g.id);
        S.setParent(kids.map((k) => k.id), g.parentId);
        freed.push(...kids.map((k) => k.id));
        S.removeItems([g.id]);
      }
      S.select(freed);
    });
  }

  /** Emparenta todo lo seleccionado al ítem seleccionado "principal" (el más grande de tipo imagen/grupo). */
  parentSelection() {
    const S = this.store;
    const roots = this.roots();
    if (roots.length < 2) return;
    const candidates = roots.filter((r) => r.kind === 'image' || r.kind === 'group');
    if (!candidates.length) return;
    const target = candidates.reduce((a, b) => {
      const ba = subtreeBounds(S.scene, a.id) ?? itemBounds(a);
      const bb = subtreeBounds(S.scene, b.id) ?? itemBounds(b);
      return bb.w * bb.h > ba.w * ba.h ? b : a;
    });
    S.commit(() => {
      S.setParent(roots.filter((r) => r.id !== target.id).map((r) => r.id), target.id);
      S.select([target.id]);
    });
  }

  rotateSelection(delta: number) {
    const S = this.store;
    const roots = this.roots().filter((r) => !r.locked);
    if (!roots.length) return;
    const b = unionRects(roots.map((r) => subtreeBounds(S.scene, r.id) ?? itemBounds(r)))!;
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const ids = roots.flatMap((r) => [r.id, ...descendantsOf(S.scene, r.id).map((d) => d.id)]);
    const cs = Math.cos(delta), sn = Math.sin(delta);
    S.commit(() =>
      S.update(ids, (it) => {
        const dx = it.x - c.x, dy = it.y - c.y;
        it.x = c.x + dx * cs - dy * sn;
        it.y = c.y + dx * sn + dy * cs;
        it.rotation += delta;
      })
    );
  }

  async copySelectionAsImage(silent: boolean) {
    const items = exportSet(this.store, this.roots(), true);
    const r = await renderItemsToBlob(this.renderer, items, { includeChildren: true, scale: 1, background: null, format: 'image/png' });
    if (!r) return;
    const ok = await copyBlobToSystemClipboard(r.blob);
    if (!silent) {
      if (ok) toast(t('ui_copied'), { ms: 1000 });
      else await shareOrDownload(r.blob, `${safeFileName(this.store.scene.name)}-seleccion.png`);
    }
  }

  replaceImage() {
    const it = this.store.selectedItems().find((i): i is ImageItem => i.kind === 'image');
    if (!it) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const { ingestBlob } = await import('./features/importImages');
      const img = await ingestBlob(f, f.name);
      this.store.commit(() =>
        this.store.update(it.id, (x) => {
          if (x.kind !== 'image') return;
          // mantener el tamaño en escena
          const prevW = x.w * x.scale;
          x.blobId = img.blobId;
          x.naturalW = img.w;
          x.naturalH = img.h;
          x.w = img.w;
          x.h = img.h;
          x.scale = prevW / img.w;
          x.crop = null;
          x.palette = img.palette;
          x.phash = img.phash;
          x.source = f.name;
        })
      );
    };
    input.click();
  }

  addPaletteNote() {
    const imgs = this.store.selectedItems().filter((i): i is ImageItem => i.kind === 'image');
    if (!imgs.length) return;
    const colors = [...new Set(imgs.flatMap((i) => i.palette))].slice(0, 8);
    if (!colors.length) return;
    const b = unionRects(imgs.map(itemBounds))!;
    const note = createNoteItem(colors.map((c) => `**${c}**`).join('  ·  '), {
      name: t('ui_palette'),
      x: b.x + b.w / 2,
      y: b.y + b.h + 40,
      w: Math.max(240, b.w),
      fontSize: 16,
      background: colors[0] + 'cc',
      color: '#fff',
      parentId: imgs.length === 1 ? imgs[0].id : null
    });
    this.store.commit(() => this.store.addItem(note));
    this.store.select([note.id]);
  }

  findSimilarToSelection() {
    const it = this.store.selectedItems().find((i): i is ImageItem => i.kind === 'image');
    if (!it?.phash) return;
    const cands = this.store.scene.items.filter((i): i is ImageItem => i.kind === 'image' && i.id !== it.id && !!i.phash).map((i) => ({ id: i.id, hash: i.phash! }));
    const res = findSimilar(it.phash, cands, 0.8);
    if (!res.length) {
      toast(t('ui_similar_none'));
      return;
    }
    this.store.select([it.id, ...res.map((r) => r.id)]);
    this.gestures.fitSelection();
  }

  findDuplicates() {
    const cands = this.store.scene.items.filter((i): i is ImageItem => i.kind === 'image' && !!i.phash).map((i) => ({ id: i.id, hash: i.phash! }));
    const groups = findDuplicateGroups(cands, 0.92);
    if (!groups.length) {
      toast(t('ui_duplicates_none'));
      return;
    }
    this.store.select(groups.flat());
    toast(`${t('ui_duplicates_found')}: ${groups.length}`);
    this.gestures.fitSelection();
  }

  /** Rect de la vista actual en escena. */
  viewRect(): Rect {
    const v = this.store.scene.viewport;
    return { x: -v.x / v.zoom, y: -v.y / v.zoom, w: this.renderer.width / v.zoom, h: this.renderer.height / v.zoom };
  }

  isTouch() {
    return isTouchDevice();
  }

  noteFor(id: ItemId): NoteItem | null {
    const it = this.store.get(id);
    return it && it.kind === 'note' ? it : null;
  }

  async confirm(msg: string, danger = false) {
    return confirmDialog(msg, { danger });
  }

  clearUi() {
    clearOverlays();
  }

  async importFilesAt(files: FileList | File[], at: Point) {
    return importFiles(this.store, files, at);
  }

  async setLanguage(l: 'es' | 'en') {
    await updateAppSettings({ language: l });
    setLanguage(l);
    this.toolbar.rebuild();
    this.hierarchy.refresh();
    this.updateEmptyHint();
  }
}
