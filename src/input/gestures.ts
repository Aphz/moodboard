/**
 * Controlador de gestos sobre el lienzo (Pointer Events).
 *
 * Táctil:  1 dedo en vacío = mover lienzo · 1 dedo en ítem = arrastrar
 *          2 dedos = zoom/pan del lienzo (o escalar/rotar la selección si
 *          el gesto empieza sobre un ítem seleccionado)
 *          tocar = seleccionar · mantener = menú contextual · doble toque = editar
 * Lápiz:   en modo dibujo traza con presión; el dedo sigue moviendo el lienzo.
 * Ratón:   arrastre en vacío = lazo · rueda = pan · ⌘/ctrl+rueda = zoom
 *          botón central o Espacio+arrastre = pan · clic derecho = menú.
 */
import {
  descendantsOf,
  hitTest,
  itemBounds,
  renderOrder,
  rectContains,
  rectsIntersect,
  subtreeBounds,
  unionRects,
  type Item,
  type ItemId,
  type Point,
  type Rect,
  type Stroke,
  type StrokeTool
} from '../core/model';
import type { Store } from '../core/store';
import { appSettings } from '../core/settings';
import { HANDLE_SIZE, screenToScene, type HandleId, type Renderer } from '../render/renderer';
import { snapToGrid } from '../features/arrange';
import { MAX_ZOOM, MIN_ZOOM, fitViewport, type Insets } from '../features/viewport';

export type Tool = 'select' | 'pan' | 'lasso' | 'draw' | 'crop';

export interface DrawSettings {
  tool: StrokeTool;
  color: string;
  width: number;
  opacity: number;
}

export interface GestureCallbacks {
  onContextMenu(screen: Point, itemId: ItemId | null): void;
  onEditItem(id: ItemId): void;
  onStrokeEnd(stroke: Stroke, originScene: Point): void;
  onCropChange(): void;
  onToolChange(tool: Tool): void;
}

type PointerInfo = { id: number; x: number; y: number; sx: number; sy: number; type: string; t: number };

type Mode =
  | { kind: 'none' }
  | { kind: 'pending'; target: ItemId | null; timer: number }
  | { kind: 'pan' }
  | { kind: 'lasso'; start: Point; additive: boolean }
  | { kind: 'move'; ids: ItemId[]; start: Map<ItemId, Point>; startBounds: Rect; hover: ItemId | null }
  | { kind: 'handle'; handle: HandleId; ids: ItemId[]; start: Map<ItemId, { x: number; y: number; scale: number; rotation: number; w: number; h: number }>; pivot: Point; startDist: number; startAngle: number; bounds: Rect }
  | { kind: 'pinch'; startZoom: number; startView: Point; startCenter: Point; startDist: number }
  | { kind: 'pinchItems'; ids: ItemId[]; start: Map<ItemId, { x: number; y: number; scale: number; rotation: number }>; startCenter: Point; startDist: number; startAngle: number; lastCenter: Point }
  | { kind: 'draw'; stroke: Stroke; origin: Point; pointerId: number }
  | { kind: 'crop'; handle: HandleId | 'move'; start: { left: number; top: number; right: number; bottom: number }; startP: Point };

const TAP_MOVE_TOUCH = 10;
const TAP_MOVE_MOUSE = 4;
const LONG_PRESS_MS = 480;
const DOUBLE_TAP_MS = 320;


export class GestureController {
  tool: Tool = 'select';
  /** selección múltiple persistente (botón de la barra) */
  multiSelect = false;
  draw: DrawSettings = { tool: 'pen', color: '#ff3b30', width: 6, opacity: 1 };
  cropAspectLock = false;
  spaceDown = false;

  private pointers = new Map<number, PointerInfo>();
  private mode: Mode = { kind: 'none' };
  private lastTap: { t: number; x: number; y: number; id: ItemId | null } | null = null;
  private inTx = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private store: Store,
    private renderer: Renderer,
    private cb: GestureCallbacks
  ) {
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onCancel);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('dblclick', (e) => e.preventDefault());
    // Safari: gestos nativos de pinch (evitar zoom de página)
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) canvas.addEventListener(ev, (e) => e.preventDefault());
  }

  setTool(t: Tool) {
    if (this.tool === t) return;
    if (this.tool === 'crop' && t !== 'crop') this.renderer.overlay.cropId = null;
    this.tool = t;
    this.cb.onToolChange(t);
    this.renderer.requestDraw();
  }

  get busy() {
    return this.mode.kind !== 'none' && this.mode.kind !== 'pending';
  }

  // ---------------------------------------------------------------------
  // utilidades

  private local(e: PointerEvent | WheelEvent | MouseEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Ítem más alto bajo el punto (escena). Devuelve el ítem "seleccionable" (grupo raíz si aplica). */
  hitItem(scene: Point, opts: { ignore?: Set<ItemId>; raw?: boolean } = {}): Item | null {
    const s = this.store.scene;
    const order = renderOrder(s);
    const hiddenSub = new Set<ItemId>();
    for (const it of s.items) if (!it.visible) for (const d of descendantsOf(s, it.id)) hiddenSub.add(d.id);
    for (let i = order.length - 1; i >= 0; i--) {
      const it = order[i];
      if (it.kind === 'group' || !it.visible || hiddenSub.has(it.id) || opts.ignore?.has(it.id)) continue;
      if (!hitTest(it, scene)) continue;
      if (opts.raw) return it;
      return this.selectableFor(it);
    }
    return null;
  }

  /**
   * Regla de selección profunda: si el ítem está dentro de un grupo, se
   * selecciona el grupo de nivel más alto que no esté ya seleccionado
   * (o cuyo padre no esté seleccionado). Tocar dentro de un grupo ya
   * seleccionado selecciona el ítem interior.
   */
  private selectableFor(it: Item): Item {
    const chain: Item[] = [];
    let cur: Item | undefined = it;
    while (cur) {
      chain.push(cur);
      cur = cur.parentId ? this.store.get(cur.parentId) : undefined;
    }
    // chain[0] = ítem, chain[n-1] = ancestro raíz
    const groups = chain.filter((c) => c.kind === 'group');
    if (groups.length === 0) return it;
    // el grupo más alto cuyo ancestro no esté seleccionado y que no esté seleccionado él mismo
    for (let i = chain.length - 1; i >= 1; i--) {
      const g = chain[i];
      if (g.kind !== 'group') continue;
      if (this.store.selection.has(g.id)) continue; // ya seleccionado → bajar un nivel
      return g;
    }
    return it;
  }

  private handleAt(p: Point): HandleId | null {
    const r = HANDLE_SIZE * 1.4;
    for (const h of this.renderer.handles()) if (Math.hypot(h.x - p.x, h.y - p.y) <= r) return h.id;
    return null;
  }

  private cropHandleAt(p: Point): HandleId | null {
    const r = HANDLE_SIZE * 1.4;
    for (const h of this.renderer.cropHandles()) if (Math.hypot(h.x - p.x, h.y - p.y) <= r) return h.id;
    return null;
  }

  private beginTx() {
    if (!this.inTx) {
      this.store.beginTransaction();
      this.inTx = true;
    }
  }

  private endTx() {
    if (this.inTx) {
      this.store.endTransaction();
      this.inTx = false;
    }
  }

  private cancelTx() {
    if (this.inTx) {
      this.store.cancelTransaction();
      this.inTx = false;
    }
  }

  /** Vuelve al estado inactivo limpiando cualquier resto visual de la interacción. */
  private idle() {
    this.mode = { kind: 'none' };
    this.renderer.overlay.hideGizmo = false;
    this.renderer.overlay.lasso = null;
    this.renderer.overlay.hoverId = null;
    this.renderer.overlay.liveStroke = null;
    this.renderer.overlay.interacting = false;
  }

  private movedIdsFor(roots: Item[]): ItemId[] {
    const ids = new Set<ItemId>();
    for (const r of roots) {
      if (r.locked) continue;
      ids.add(r.id);
      for (const d of descendantsOf(this.store.scene, r.id)) ids.add(d.id);
    }
    return [...ids];
  }


  // ---------------------------------------------------------------------
  // eventos

  private onDown = (e: PointerEvent) => {
    if (e.button > 2) return;
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.local(e);
    const info: PointerInfo = { id: e.pointerId, x: p.x, y: p.y, sx: p.x, sy: p.y, type: e.pointerType, t: performance.now() };
    this.pointers.set(e.pointerId, info);
    (document.activeElement as HTMLElement | null)?.blur?.();

    if (this.pointers.size === 2) {
      this.startTwoFinger();
      return;
    }
    if (this.pointers.size > 2) return;

    const scene = screenToScene(this.store.scene.viewport, p);
    const isMouse = e.pointerType === 'mouse';

    // clic derecho / botón central
    if (isMouse && e.button === 2) {
      const hit = this.hitItem(scene);
      if (hit && !this.store.selection.has(hit.id)) this.store.select([hit.id]);
      this.cb.onContextMenu(p, hit?.id ?? null);
      this.pointers.delete(e.pointerId);
      return;
    }
    if ((isMouse && e.button === 1) || this.spaceDown || this.tool === 'pan') {
      this.mode = { kind: 'pan' };
      return;
    }

    // modo recorte
    if (this.tool === 'crop' && this.renderer.overlay.cropId) {
      const it = this.store.get(this.renderer.overlay.cropId);
      if (it && it.kind === 'image') {
        const h = this.cropHandleAt(p);
        const c = it.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
        if (h) {
          this.beginTx();
          this.mode = { kind: 'crop', handle: h, start: { ...c }, startP: p };
          return;
        }
        if (rectContains(this.renderer.cropRectScreen(it), p)) {
          this.beginTx();
          this.mode = { kind: 'crop', handle: 'move', start: { ...c }, startP: p };
          return;
        }
      }
      this.mode = { kind: 'pan' };
      return;
    }

    // modo dibujo
    if (this.tool === 'draw') {
      const fingerPans = e.pointerType === 'touch' && appSettings.pencilOnlyDraw;
      if (!fingerPans) {
        this.startStroke(e, scene);
        return;
      }
      this.mode = { kind: 'pan' };
      return;
    }

    // tiradores
    const h = this.handleAt(p);
    if (h) {
      this.startHandle(h, p);
      return;
    }

    // ítem o vacío → pendiente hasta saber si es toque, arrastre o pulsación larga
    const hit = this.hitItem(scene);
    const timer = window.setTimeout(() => {
      if (this.mode.kind !== 'pending') return;
      this.mode = { kind: 'none' };
      if (hit && !this.store.selection.has(hit.id)) this.store.select([hit.id]);
      if (navigator.vibrate) navigator.vibrate(8);
      this.cb.onContextMenu(p, hit?.id ?? null);
    }, LONG_PRESS_MS);
    this.mode = { kind: 'pending', target: hit?.id ?? null, timer };
  };

  private onMove = (e: PointerEvent) => {
    const info = this.pointers.get(e.pointerId);
    if (!info) return;
    const p = this.local(e);
    const prev = { x: info.x, y: info.y };
    info.x = p.x;
    info.y = p.y;
    const m = this.mode;
    const v = this.store.scene.viewport;

    switch (m.kind) {
      case 'pending': {
        const thr = info.type === 'mouse' ? TAP_MOVE_MOUSE : TAP_MOVE_TOUCH;
        if (Math.hypot(p.x - info.sx, p.y - info.sy) < thr) return;
        clearTimeout(m.timer);
        this.startDrag(m.target, info, e);
        // reprocesar este movimiento con el modo nuevo
        info.x = prev.x;
        info.y = prev.y;
        this.onMove(e);
        return;
      }
      case 'pan':
        this.renderer.overlay.interacting = true;
        this.store.setViewport({ x: v.x + (p.x - prev.x), y: v.y + (p.y - prev.y) });
        break;
      case 'lasso': {
        const x = Math.min(m.start.x, p.x), y = Math.min(m.start.y, p.y);
        this.renderer.overlay.lasso = { x, y, w: Math.abs(p.x - m.start.x), h: Math.abs(p.y - m.start.y) };
        break;
      }
      case 'move':
        this.updateMove(m, info);
        break;
      case 'handle':
        this.updateHandle(m, p, e);
        break;
      case 'pinch':
      case 'pinchItems':
        this.updateTwoFinger();
        break;
      case 'draw': {
        if (e.pointerId !== m.pointerId) return;
        const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
        for (const ce of events.length ? events : [e]) {
          const lp = this.local(ce);
          const sp = screenToScene(v, lp);
          const pr = appSettings.pencilPressure && ce.pointerType === 'pen' ? Math.max(0.05, ce.pressure || 0.5) : 0.6;
          const pt = { x: sp.x - m.origin.x, y: sp.y - m.origin.y, p: pr };
          if (m.stroke.tool === 'pen') {
            const last = m.stroke.points[m.stroke.points.length - 1];
            if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) > 0.5 / v.zoom) m.stroke.points.push(pt);
          } else {
            m.stroke.points = [m.stroke.points[0], pt];
          }
        }
        break;
      }
      case 'crop':
        this.updateCrop(m, p, e);
        break;
      default:
        return;
    }
    this.renderer.requestDraw();
  };

  private onUp = (e: PointerEvent) => {
    const info = this.pointers.get(e.pointerId);
    if (!info) return;
    this.pointers.delete(e.pointerId);
    const p = this.local(e);
    const m = this.mode;

    switch (m.kind) {
      case 'pending': {
        clearTimeout(m.timer);
        this.mode = { kind: 'none' };
        this.tap(m.target, p, e);
        break;
      }
      case 'lasso': {
        const l = this.renderer.overlay.lasso;
        this.renderer.overlay.lasso = null;
        if (l && (l.w > 2 || l.h > 2)) {
          const v = this.store.scene.viewport;
          const sr: Rect = { x: (l.x - v.x) / v.zoom, y: (l.y - v.y) / v.zoom, w: l.w / v.zoom, h: l.h / v.zoom };
          const ids: ItemId[] = [];
          for (const it of this.store.scene.items) {
            if (it.kind === 'group' || !it.visible) continue;
            if (rectsIntersect(sr, itemBounds(it))) ids.push(this.selectableFor(it).id);
          }
          this.store.select([...new Set(ids)], m.additive ? 'add' : 'replace');
        }
        this.idle();
        // el lazo es de un solo uso: al terminar vuelve a la herramienta de selección
        if (this.tool === 'lasso') this.setTool('select');
        break;
      }
      case 'move': {
        this.finishMove(m);
        this.idle();
        break;
      }
      case 'handle':
        this.endTx();
        this.idle();
        break;
      case 'pinch':
        if (this.pointers.size === 1) {
          this.mode = { kind: 'pan' };
          this.renderer.overlay.hideGizmo = false;
        } else if (this.pointers.size === 0) this.idle();
        break;
      case 'pinchItems':
        if (this.pointers.size < 2) {
          this.endTx();
          this.pointers.clear();
          this.idle();
        }
        break;
      case 'draw':
        if (e.pointerId === m.pointerId) {
          this.idle();
          if (m.stroke.points.length > 0) this.cb.onStrokeEnd(m.stroke, m.origin);
        }
        break;
      case 'crop':
        this.endTx();
        this.cb.onCropChange();
        this.idle();
        break;
      case 'pan':
        if (this.pointers.size === 0) this.idle();
        break;
    }
    this.renderer.requestDraw();
  };

  private onCancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    const m = this.mode;
    if (m.kind === 'pending') clearTimeout(m.timer);
    if (m.kind === 'draw') this.renderer.overlay.liveStroke = null;
    if (m.kind === 'move' || m.kind === 'handle' || m.kind === 'pinchItems' || m.kind === 'crop') this.cancelTx();
    if (this.pointers.size === 0) this.idle();
    else {
      this.renderer.overlay.lasso = null;
      this.renderer.overlay.hoverId = null;
      this.renderer.overlay.hideGizmo = false;
    }
    this.renderer.requestDraw();
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.local(e);
    const v = this.store.scene.viewport;
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01));
      this.zoomAt(p, factor);
    } else {
      const k = e.deltaMode === 1 ? 20 : 1;
      this.store.setViewport({ x: v.x - e.deltaX * k, y: v.y - e.deltaY * k });
    }
    this.renderer.requestDraw();
  };

  // ---------------------------------------------------------------------
  // toque / doble toque

  private tap(target: ItemId | null, p: Point, e: PointerEvent) {
    const now = performance.now();
    const additive = this.multiSelect || e.shiftKey || e.metaKey || e.ctrlKey;
    const isDouble =
      this.lastTap && now - this.lastTap.t < DOUBLE_TAP_MS && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < 24 && this.lastTap.id === target;
    this.lastTap = { t: now, x: p.x, y: p.y, id: target };
    if (isDouble) {
      this.lastTap = null;
      if (target) {
        this.store.select([target]);
        this.cb.onEditItem(target);
      } else {
        // doble toque en vacío: ajustar todo a la vista
        this.fitToView();
      }
      return;
    }
    if (target) {
      // grupos: si ya estaba seleccionado el grupo, el segundo toque baja al ítem interno
      this.store.select([target], additive ? 'toggle' : 'replace');
    } else if (!additive) {
      this.store.clearSelection();
    }
  }

  // ---------------------------------------------------------------------
  // arrastre de ítems / lazo / pan

  private startDrag(target: ItemId | null, info: PointerInfo, e: PointerEvent) {
    const additive = this.multiSelect || e.shiftKey || e.metaKey || e.ctrlKey;
    if (target) {
      const it = this.store.get(target);
      if (!it) {
        this.mode = { kind: 'pan' };
        return;
      }
      if (!this.store.selection.has(target)) this.store.select([target], additive ? 'add' : 'replace');
      const roots = this.store.selectedRoots();
      const ids = this.movedIdsFor(roots);
      if (ids.length === 0) {
        this.mode = { kind: 'pan' };
        return;
      }
      const start = new Map<ItemId, Point>();
      for (const id of ids) {
        const x = this.store.get(id)!;
        start.set(id, { x: x.x, y: x.y });
      }
      const rects: Rect[] = [];
      for (const r of roots) {
        const b = subtreeBounds(this.store.scene, r.id);
        if (b) rects.push(b);
      }
      this.beginTx();
      this.store.bringToFront(roots.map((r) => r.id));
      this.mode = { kind: 'move', ids, start, startBounds: unionRects(rects) ?? { x: 0, y: 0, w: 0, h: 0 }, hover: null };
      return;
    }
    const wantLasso = this.tool === 'lasso' || (info.type === 'mouse' && this.tool === 'select');
    if (wantLasso) {
      this.mode = { kind: 'lasso', start: { x: info.sx, y: info.sy }, additive };
      if (!additive) this.store.clearSelection();
    } else this.mode = { kind: 'pan' };
  }

  private updateMove(m: Extract<Mode, { kind: 'move' }>, info: PointerInfo) {
    const v = this.store.scene.viewport;
    let dx = (info.x - info.sx) / v.zoom;
    let dy = (info.y - info.sy) / v.zoom;
    const g = this.store.scene.settings.grid;
    if (g.enabled && g.snap) {
      const tx = snapToGrid(m.startBounds.x + dx, g.size);
      const ty = snapToGrid(m.startBounds.y + dy, g.size);
      dx = tx - m.startBounds.x;
      dy = ty - m.startBounds.y;
    }
    this.store.update(m.ids, (it) => {
      const s = m.start.get(it.id)!;
      it.x = s.x + dx;
      it.y = s.y + dy;
    });
    // destino de emparentado (grupo o imagen) bajo el puntero
    const scene = screenToScene(v, { x: info.x, y: info.y });
    const moved = new Set(m.ids);
    const target = this.dropTargetAt(scene, moved);
    m.hover = target?.id ?? null;
    this.renderer.overlay.hoverId = m.hover;
  }

  /** Grupo (por caja) o imagen (por impacto) bajo el punto que pueda recibir los ítems movidos. */
  private dropTargetAt(scene: Point, moved: Set<ItemId>): Item | null {
    if (!appSettings.dropIntoGroups) return null;
    const raw = this.hitItem(scene, { ignore: moved, raw: true });
    if (raw) {
      // sube hasta el grupo contenedor más externo que no esté siendo movido
      let cur: Item | undefined = raw;
      let best: Item | null = raw.kind === 'image' ? raw : null;
      while (cur?.parentId) {
        const parent = this.store.get(cur.parentId);
        if (!parent || moved.has(parent.id)) break;
        if (parent.kind === 'group') best = parent;
        cur = parent;
      }
      return best;
    }
    // grupos vacíos de impacto: por caja del subárbol
    for (const g of this.store.scene.items) {
      if (g.kind !== 'group' || moved.has(g.id) || !g.visible) continue;
      const b = subtreeBounds(this.store.scene, g.id);
      if (b && rectContains(b, scene)) return g;
    }
    return null;
  }

  private finishMove(m: Extract<Mode, { kind: 'move' }>) {
    this.renderer.overlay.hoverId = null;
    const roots = this.store.selectedRoots().filter((r) => !r.locked);
    if (m.hover) {
      const target = this.store.get(m.hover);
      if (target) {
        const movable = roots.filter((r) => r.id !== target.id);
        // imágenes sólo se sueltan dentro de grupos; notas/dibujos también sobre imágenes
        const accepted = movable.filter((r) => target.kind === 'group' || (target.kind === 'image' && r.kind !== 'image' && r.kind !== 'group'));
        if (accepted.length) this.store.setParent(accepted.map((r) => r.id), target.id);
      }
    } else {
      // sacar del grupo si se soltó fuera de su caja
      for (const r of roots) {
        if (!r.parentId) continue;
        const parent = this.store.get(r.parentId);
        if (!parent || parent.kind !== 'group') continue;
        const others = descendantsOf(this.store.scene, parent.id).filter((d) => !m.ids.includes(d.id) && d.kind !== 'group');
        const box = unionRects(others.map(itemBounds));
        const mine = subtreeBounds(this.store.scene, r.id);
        if (box && mine && !rectsIntersect(box, mine)) this.store.setParent([r.id], parent.parentId);
        if (!box) {
          /* grupo quedaría vacío: mantener */
        }
      }
    }
    this.endTx();
  }

  // ---------------------------------------------------------------------
  // tiradores (escala / rotación / redimensionar nota)

  private startHandle(h: HandleId, p: Point) {
    const b = this.renderer.selectionBounds()!;
    const roots = this.store.selectedRoots().filter((r) => !r.locked);
    const ids = this.movedIdsFor(roots);
    const start = new Map<ItemId, { x: number; y: number; scale: number; rotation: number; w: number; h: number }>();
    for (const id of ids) {
      const it = this.store.get(id)!;
      start.set(id, { x: it.x, y: it.y, scale: it.scale, rotation: it.rotation, w: it.w, h: it.h });
    }
    const center = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    let pivot = center;
    if (h === 'nw') pivot = { x: b.x + b.w, y: b.y + b.h };
    else if (h === 'ne') pivot = { x: b.x, y: b.y + b.h };
    else if (h === 'sw') pivot = { x: b.x + b.w, y: b.y };
    else if (h === 'se') pivot = { x: b.x, y: b.y };
    else if (h === 'e') pivot = { x: b.x, y: center.y };
    else if (h === 'w') pivot = { x: b.x + b.w, y: center.y };
    else if (h === 'n') pivot = { x: center.x, y: b.y + b.h };
    else if (h === 's') pivot = { x: center.x, y: b.y };
    const sp = screenToScene(this.store.scene.viewport, p);
    this.beginTx();
    this.renderer.overlay.hideGizmo = true;
    this.mode = {
      kind: 'handle',
      handle: h,
      ids,
      start,
      pivot,
      startDist: Math.max(1e-6, Math.hypot(sp.x - pivot.x, sp.y - pivot.y)),
      startAngle: Math.atan2(sp.y - center.y, sp.x - center.x),
      bounds: b
    };
  }

  private updateHandle(m: Extract<Mode, { kind: 'handle' }>, p: Point, e: PointerEvent) {
    const sp = screenToScene(this.store.scene.viewport, p);
    const center = { x: m.bounds.x + m.bounds.w / 2, y: m.bounds.y + m.bounds.h / 2 };
    if (m.handle === 'rotate') {
      let d = Math.atan2(sp.y - center.y, sp.x - center.x) - m.startAngle;
      if (e.shiftKey) d = Math.round(d / (Math.PI / 12)) * (Math.PI / 12);
      const c = Math.cos(d), s = Math.sin(d);
      this.store.update(m.ids, (it) => {
        const st = m.start.get(it.id)!;
        const dx = st.x - center.x, dy = st.y - center.y;
        it.x = center.x + dx * c - dy * s;
        it.y = center.y + dx * s + dy * c;
        it.rotation = st.rotation + d;
      });
      return;
    }
    if (m.handle === 'e' || m.handle === 'w' || m.handle === 'n' || m.handle === 's') {
      // redimensionar nota única (sin rotación)
      const id = m.ids[0];
      const st = m.start.get(id)!;
      this.store.update(id, (it) => {
        if (it.kind !== 'note') return;
        if (m.handle === 'e' || m.handle === 'w') {
          const newW = Math.max(60, Math.abs(sp.x - m.pivot.x) / st.scale);
          it.w = newW;
          it.x = m.pivot.x + ((m.handle === 'e' ? 1 : -1) * newW * st.scale) / 2;
          this.renderer.invalidateNoteLayout(it.id);
        } else {
          const newH = Math.max(40, Math.abs(sp.y - m.pivot.y) / st.scale);
          it.h = newH;
          it.autoHeight = false;
          it.y = m.pivot.y + ((m.handle === 's' ? 1 : -1) * newH * st.scale) / 2;
        }
      });
      return;
    }
    // esquinas: escala uniforme respecto al pivote (Alt = respecto al centro)
    const pivot = e.altKey ? center : m.pivot;
    const d0 = e.altKey ? Math.hypot(m.bounds.w, m.bounds.h) / 2 : m.startDist;
    let k = Math.hypot(sp.x - pivot.x, sp.y - pivot.y) / Math.max(1e-6, d0);
    k = Math.max(0.02, k);
    this.store.update(m.ids, (it) => {
      const st = m.start.get(it.id)!;
      it.x = pivot.x + (st.x - pivot.x) * k;
      it.y = pivot.y + (st.y - pivot.y) * k;
      it.scale = st.scale * k;
    });
  }

  // ---------------------------------------------------------------------
  // dos dedos

  private twoPoints(): [PointerInfo, PointerInfo] {
    const arr = [...this.pointers.values()];
    return [arr[0], arr[1]];
  }

  private startTwoFinger() {
    const m = this.mode;
    if (m.kind === 'pending') clearTimeout(m.timer);
    if (m.kind === 'draw') this.renderer.overlay.liveStroke = null;
    this.renderer.overlay.lasso = null;
    const [a, b] = this.twoPoints();
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const v = this.store.scene.viewport;

    // ¿gesto sobre la selección? (arrastre en curso o pendiente sobre un ítem seleccionado)
    const onSelection =
      (m.kind === 'move') || (m.kind === 'pending' && m.target !== null && this.store.selection.has(m.target));
    if (onSelection && this.tool !== 'draw' && this.tool !== 'crop') {
      if (m.kind === 'move') {
        // deshacer el desplazamiento parcial para partir limpio
        this.store.update(m.ids, (it) => {
          const s = m.start.get(it.id)!;
          it.x = s.x;
          it.y = s.y;
        });
        this.renderer.overlay.hoverId = null;
      }
      const roots = this.store.selectedRoots();
      const ids = this.movedIdsFor(roots);
      const start = new Map<ItemId, { x: number; y: number; scale: number; rotation: number }>();
      for (const id of ids) {
        const it = this.store.get(id)!;
        start.set(id, { x: it.x, y: it.y, scale: it.scale, rotation: it.rotation });
      }
      this.beginTx();
      this.renderer.overlay.hideGizmo = true;
      this.mode = {
        kind: 'pinchItems',
        ids,
        start,
        startCenter: screenToScene(v, center),
        startDist: dist,
        startAngle: Math.atan2(b.y - a.y, b.x - a.x),
        lastCenter: center
      };
      return;
    }
    if (m.kind === 'move' || m.kind === 'handle') this.cancelTx();
    this.renderer.overlay.hideGizmo = false;
    this.renderer.overlay.interacting = true;
    this.mode = { kind: 'pinch', startZoom: v.zoom, startView: { x: v.x, y: v.y }, startCenter: center, startDist: dist };
  }

  private updateTwoFinger() {
    if (this.pointers.size < 2) return;
    const [a, b] = this.twoPoints();
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const m = this.mode;
    if (m.kind === 'pinch') {
      const zoom = clamp(m.startZoom * (dist / m.startDist), MIN_ZOOM, MAX_ZOOM);
      // mantener el punto de escena bajo el centro inicial pegado al centro actual
      const sc = { x: (m.startCenter.x - m.startView.x) / m.startZoom, y: (m.startCenter.y - m.startView.y) / m.startZoom };
      this.store.setViewport({ zoom, x: center.x - sc.x * zoom, y: center.y - sc.y * zoom });
    } else if (m.kind === 'pinchItems') {
      const v = this.store.scene.viewport;
      const k = dist / m.startDist;
      const ang = Math.atan2(b.y - a.y, b.x - a.x) - m.startAngle;
      const c = Math.cos(ang), s = Math.sin(ang);
      const nowCenter = screenToScene(v, center);
      const pv = m.startCenter;
      this.store.update(m.ids, (it) => {
        const st = m.start.get(it.id)!;
        const dx = (st.x - pv.x) * k, dy = (st.y - pv.y) * k;
        it.x = nowCenter.x + dx * c - dy * s;
        it.y = nowCenter.y + dx * s + dy * c;
        it.scale = st.scale * k;
        it.rotation = st.rotation + ang;
      });
    }
  }

  // ---------------------------------------------------------------------
  // dibujo

  private startStroke(e: PointerEvent, scene: Point) {
    const pr = appSettings.pencilPressure && e.pointerType === 'pen' ? Math.max(0.05, e.pressure || 0.5) : 0.6;
    const stroke: Stroke = { tool: this.draw.tool, color: this.draw.color, width: this.draw.width, points: [{ x: 0, y: 0, p: pr }] };
    this.mode = { kind: 'draw', stroke, origin: scene, pointerId: e.pointerId };
    this.renderer.overlay.liveStroke = { stroke, origin: scene };
  }

  // ---------------------------------------------------------------------
  // recorte

  private updateCrop(m: Extract<Mode, { kind: 'crop' }>, p: Point, e: PointerEvent) {
    const it = this.store.get(this.renderer.overlay.cropId!);
    if (!it || it.kind !== 'image') return;
    const f = this.renderer.fullImageRectScreen(it);
    const fx = it.flipX, fy = it.flipY;
    // fracciones en espacio de pantalla (sin voltear)
    const s = m.start;
    let L = fx ? s.right : s.left, R = fx ? s.left : s.right, T = fy ? s.bottom : s.top, B = fy ? s.top : s.bottom;
    const dx = (p.x - m.startP.x) / f.w;
    const dy = (p.y - m.startP.y) / f.h;
    const minSize = 0.02;
    if (m.handle === 'move') {
      const w = 1 - L - R, h = 1 - T - B;
      L = clamp(L + dx, 0, 1 - w);
      T = clamp(T + dy, 0, 1 - h);
      R = 1 - w - L;
      B = 1 - h - T;
    } else {
      const h = m.handle;
      if (h.includes('w')) L = clamp(L + dx, 0, 1 - R - minSize);
      if (h.includes('e')) R = clamp(R - dx, 0, 1 - L - minSize);
      if (h.includes('n')) T = clamp(T + dy, 0, 1 - B - minSize);
      if (h.includes('s')) B = clamp(B - dy, 0, 1 - T - minSize);
      if (this.cropAspectLock || e.shiftKey) {
        // mantener la proporción del recorte inicial ajustando el eje no arrastrado
        const w0 = 1 - (fx ? s.right : s.left) - (fx ? s.left : s.right);
        const h0 = 1 - (fy ? s.bottom : s.top) - (fy ? s.top : s.bottom);
        const ratio = (w0 * f.w) / Math.max(1e-6, h0 * f.h); // px
        const w = 1 - L - R;
        const hh = (w * f.w) / ratio / f.h;
        if (h === 'n' || h === 's') {
          const hcur = 1 - T - B;
          const wNew = (hcur * f.h * ratio) / f.w;
          if (h.includes('w') || !h.includes('e')) R = clamp(1 - L - wNew, 0, 1);
          else L = clamp(1 - R - wNew, 0, 1);
        } else if (h.includes('n')) T = clamp(1 - B - hh, 0, 1);
        else B = clamp(1 - T - hh, 0, 1);
      }
    }
    const crop = { left: fx ? R : L, right: fx ? L : R, top: fy ? B : T, bottom: fy ? T : B };
    // mantener el bitmap fijo en pantalla: el centro del ítem se desplaza al centro del nuevo recorte
    const fullCx = f.x + f.w / 2, fullCy = f.y + f.h / 2;
    const v = this.store.scene.viewport;
    const ncx = fullCx + ((L - R) / 2) * f.w;
    const ncy = fullCy + ((T - B) / 2) * f.h;
    this.store.update(it.id, (x) => {
      if (x.kind !== 'image') return;
      x.crop = crop;
      x.x = (ncx - v.x) / v.zoom;
      x.y = (ncy - v.y) / v.zoom;
    });
  }

  // ---------------------------------------------------------------------
  // vista

  zoomAt(p: Point, factor: number) {
    const v = this.store.scene.viewport;
    const zoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const k = zoom / v.zoom;
    this.store.setViewport({ zoom, x: p.x - (p.x - v.x) * k, y: p.y - (p.y - v.y) * k });
    this.renderer.requestDraw();
  }

  /** Tamaño del lienzo en píxeles CSS. */
  viewSize(): { w: number; h: number } {
    return { w: this.renderer.width, h: this.renderer.height };
  }

  /**
   * Franjas que tapan las barras flotantes (superior, herramientas, subbarra y
   * panel de jerarquía). Se miden del DOM, así que valen igual en iPhone, en
   * iPad y con el área segura de la pantalla.
   */
  viewInsets(): Insets {
    const base = 16;
    const ins: Insets = { top: base, right: base, bottom: base, left: base };
    const c = this.canvas.getBoundingClientRect();
    for (const sel of ['#top-bar', '#toolbar', '#sub-bar', '#hierarchy']) {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      // barra horizontal (ancha y baja) o panel lateral
      if (r.width >= r.height) {
        if (r.top + r.height / 2 < c.top + c.height / 2) ins.top = Math.max(ins.top, r.bottom - c.top + 8);
        else ins.bottom = Math.max(ins.bottom, c.bottom - r.top + 8);
      } else {
        if (r.left + r.width / 2 < c.left + c.width / 2) ins.left = Math.max(ins.left, r.right - c.left + 8);
        else ins.right = Math.max(ins.right, c.right - r.left + 8);
      }
    }
    return ins;
  }

  fitRect(r: Rect | null, padding = 0) {
    this.store.setViewport(fitViewport(r, this.viewSize(), this.viewInsets(), padding));
    this.renderer.requestDraw();
  }

  /** Caja de todo lo visible del tablero (sin grupos, que no pintan nada). */
  contentBounds(): Rect | null {
    return unionRects(this.store.scene.items.filter((i) => i.kind !== 'group' && i.visible).map(itemBounds));
  }

  fitToView() {
    this.fitRect(this.contentBounds());
  }

  fitSelection() {
    this.fitRect(this.renderer.selectionBounds());
  }
}

function clamp(v: number, a: number, b: number) {
  return Math.min(b, Math.max(a, v));
}
