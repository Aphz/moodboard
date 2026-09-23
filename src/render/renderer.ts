/**
 * Renderizador Canvas 2D del lienzo.
 *
 * Coordenadas: escena → pantalla con `sx = x * zoom + vx`, `sy = y * zoom + vy`
 * (vx, vy, zoom vienen de `scene.viewport`, en píxeles CSS). El canvas se
 * escala por devicePixelRatio para nitidez en pantallas Retina.
 */
import {
  descendantsOf,
  effectiveSize,
  itemBounds,
  renderOrder,
  subtreeBounds,
  unionRects,
  type DrawingItem,
  type ImageItem,
  type Item,
  type NoteItem,
  type Point,
  type Rect,
  type Scene,
  type Stroke,
  type Viewport
} from '../core/model';
import type { Store } from '../core/store';
import { getBitmap, isFailed } from './imageCache';
import { fontString, layoutText, type TextLine } from './text';
import { noteTextBox } from '../features/noteText';

export const HANDLE_SIZE = 14; // px CSS
export const ROTATE_HANDLE_OFFSET = 36;

export type HandleId = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w' | 'rotate';

export interface Handle {
  id: HandleId;
  x: number; // pantalla
  y: number;
}

export interface Overlay {
  /** lazo en pantalla */
  lasso: Rect | null;
  /** ítem resaltado (hover / arrastre hacia grupo) */
  hoverId: string | null;
  /** qué va a pasar al soltar, para decirlo con palabras sobre el destino */
  hoverLabel: string | null;
  /** modo recorte activo sobre este ítem */
  cropId: string | null;
  /** trazo en curso (coordenadas de escena) */
  liveStroke: { stroke: Stroke; origin: Point } | null;
  /** ocultar gizmo durante transformaciones */
  hideGizmo: boolean;
  /** el usuario está moviendo/zoomeando el lienzo: dibujar en calidad ligera */
  interacting: boolean;
}

export function sceneToScreen(v: Viewport, p: Point): Point {
  return { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y };
}

export function screenToScene(v: Viewport, p: Point): Point {
  return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom };
}

export class Renderer {
  ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  dpr = 1;
  overlay: Overlay = {
    lasso: null,
    hoverId: null,
    hoverLabel: null,
    cropId: null,
    liveStroke: null,
    hideGizmo: false,
    interacting: false
  };
  /**
   * Franjas que tapan las barras flotantes, en píxeles CSS. Las actualiza la
   * app al medirlas; sirven para no dibujar rótulos debajo de ellas ni bajo el
   * área segura de iOS.
   */
  insets = { top: 8, right: 8, bottom: 8, left: 8 };
  private raf = 0;
  /** sombras suaves bajo los ítems (se apagan durante pan/zoom y en escenas muy grandes) */
  private shadows = true;
  /** true mientras se renderiza para exportar (sin sombras ni decoraciones) */
  exporting = false;
  private dotPattern: { key: string; pattern: CanvasPattern | null } | null = null;
  private vignette: { key: string; grad: CanvasGradient } | null = null;
  private noteLayoutCache = new Map<string, { key: string; lines: TextLine[]; height: number }>();
  /**
   * Instantánea de la escena mientras se traza con el lápiz.
   *
   * Repintar todo el tablero en cada punto del trazo (imágenes, sombras,
   * trama, viñeta) come el presupuesto del fotograma y la escritura rápida se
   * siente pegajosa. Con la escena congelada en un canvas aparte, cada punto
   * cuesta un `drawImage` más el trazo.
   */
  private liveSnapshot: { canvas: HTMLCanvasElement; key: string } | null = null;

  constructor(public canvas: HTMLCanvasElement, public store: Store) {
    this.ctx = canvas.getContext('2d', { alpha: true })!;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.requestDraw();
  }

  requestDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  // ---------------------------------------------------------------------
  // dibujo principal

  /** Firma de lo que hay pintado: tamaño, encuadre y última mutación de la escena. */
  private snapshotKey(): string {
    const v = this.store.scene.viewport;
    return `${this.width}x${this.height}@${this.dpr}|${v.x},${v.y},${v.zoom}|${this.store.scene.updatedAt}|${this.store.selection.size}`;
  }

  /** Pinta el trazo en curso con la transformación de la escena. */
  private drawLiveStroke() {
    const live = this.overlay.liveStroke;
    if (!live) return;
    const { ctx } = this;
    const v = this.store.scene.viewport;
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.scale(v.zoom, v.zoom);
    ctx.translate(live.origin.x, live.origin.y);
    drawStroke(ctx, live.stroke, 1);
    ctx.restore();
  }

  draw() {
    const { ctx, store } = this;
    const scene = store.scene;
    const v = scene.viewport;

    // trazo en curso sobre una escena que no cambió: basta con volver a poner
    // la instantánea y pintar encima lo que lleva el lápiz
    if (this.overlay.liveStroke && this.liveSnapshot?.key === this.snapshotKey()) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.drawImage(this.liveSnapshot.canvas, 0, 0, this.width, this.height);
      this.drawLiveStroke();
      return;
    }
    if (!this.overlay.liveStroke) this.liveSnapshot = null;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    if (scene.settings.canvasColor !== 'transparent') {
      ctx.fillStyle = scene.settings.canvasColor;
      ctx.fillRect(0, 0, this.width, this.height);
      this.drawDots(scene);
      this.drawVignette();
    }
    if (scene.settings.grid.enabled) this.drawGrid(scene);

    const visible: Rect = { x: -v.x / v.zoom, y: -v.y / v.zoom, w: this.width / v.zoom, h: this.height / v.zoom };
    const hiddenSubtrees = new Set<string>();
    for (const it of scene.items) if (!it.visible) for (const d of descendantsOf(scene, it.id)) hiddenSubtrees.add(d.id);

    const visibleItems = renderOrder(scene).filter((it) => {
      if (!it.visible || hiddenSubtrees.has(it.id) || it.kind === 'group') return false;
      const b = itemBounds(it);
      return !(b.x + b.w < visible.x || b.x > visible.x + visible.w || b.y + b.h < visible.y || b.y > visible.y + visible.h);
    });
    this.shadows = !this.overlay.interacting && visibleItems.length <= 120;

    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.scale(v.zoom, v.zoom);
    for (const it of visibleItems) {
      this.drawItem(ctx, it, v.zoom);
    }
    ctx.restore();

    this.drawSelection(scene);
    if (this.overlay.hoverId) {
      const b = subtreeBounds(scene, this.overlay.hoverId);
      if (b) {
        const s = this.rectToScreen(b);
        // zona de destino: relleno tenue además del contorno, para que se lea
        // como «aquí cae» y no como un recuadro suelto
        ctx.fillStyle = 'rgba(255,204,0,0.12)';
        ctx.fillRect(s.x, s.y, s.w, s.h);
        ctx.strokeStyle = '#ffcc00';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(s.x, s.y, s.w, s.h);
        ctx.setLineDash([]);
        if (this.overlay.hoverLabel) this.drawDropLabel(this.overlay.hoverLabel, s);
      }
    } else if (this.overlay.hoverLabel) {
      // sin destino: el aviso va arriba al centro (por ejemplo «sacar del grupo»)
      this.drawDropLabel(this.overlay.hoverLabel, { x: 0, y: Math.max(8, this.insets.top), w: this.width, h: 0 });
    }
    if (this.overlay.lasso) {
      const l = this.overlay.lasso;
      ctx.fillStyle = 'rgba(10,132,255,0.15)';
      ctx.strokeStyle = 'rgba(10,132,255,0.9)';
      ctx.lineWidth = 1;
      ctx.fillRect(l.x, l.y, l.w, l.h);
      ctx.strokeRect(l.x, l.y, l.w, l.h);
    }
    if (this.overlay.cropId) this.drawCropOverlay(scene);

    // con el lápiz apoyado: guardar lo pintado y añadir el trazo encima
    if (this.overlay.liveStroke) {
      this.captureSnapshot();
      this.drawLiveStroke();
    }
  }

  /** Copia lo que hay en el lienzo para reutilizarlo mientras dure el trazo. */
  private captureSnapshot() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w <= 0 || h <= 0) return;
    let snap = this.liveSnapshot?.canvas;
    if (!snap || snap.width !== w || snap.height !== h) {
      snap = document.createElement('canvas');
      snap.width = w;
      snap.height = h;
    }
    const sctx = snap.getContext('2d');
    if (!sctx) return;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(this.canvas, 0, 0);
    this.liveSnapshot = { canvas: snap, key: this.snapshotKey() };
  }

  /** Trama de puntos muy sutil que da sensación de profundidad y de "mesa" infinita. */
  private drawDots(scene: Scene) {
    const { ctx } = this;
    const v = scene.viewport;
    let spacing = 48 * v.zoom;
    while (spacing < 24) spacing *= 2;
    while (spacing > 96) spacing /= 2;
    const light = isLightColor(scene.settings.canvasColor);
    const key = `${spacing.toFixed(2)}|${light}|${this.dpr}`;
    if (!this.dotPattern || this.dotPattern.key !== key) {
      const c = document.createElement('canvas');
      const size = Math.max(1, Math.round(spacing * this.dpr));
      c.width = size;
      c.height = size;
      const g = c.getContext('2d')!;
      g.fillStyle = light ? 'rgba(0,0,0,0.11)' : 'rgba(255,255,255,0.075)';
      g.beginPath();
      g.arc(size / 2, size / 2, Math.max(1, 1.1 * this.dpr), 0, Math.PI * 2);
      g.fill();
      const pattern = ctx.createPattern(c, 'repeat');
      if (pattern && 'setTransform' in pattern) pattern.setTransform(new DOMMatrix().scale(1 / this.dpr));
      this.dotPattern = { key, pattern };
    }
    if (!this.dotPattern.pattern) return;
    ctx.save();
    ctx.translate(((v.x % spacing) + spacing) % spacing, ((v.y % spacing) + spacing) % spacing);
    ctx.fillStyle = this.dotPattern.pattern;
    ctx.fillRect(-spacing, -spacing, this.width + spacing * 2, this.height + spacing * 2);
    ctx.restore();
  }

  /** Viñeta radial: aclara el centro y oscurece los bordes, como una superficie iluminada. */
  private drawVignette() {
    const { ctx } = this;
    const key = `${this.width}x${this.height}`;
    if (!this.vignette || this.vignette.key !== key) {
      const r = Math.hypot(this.width, this.height) * 0.6;
      const grad = ctx.createRadialGradient(this.width / 2, this.height * 0.42, r * 0.15, this.width / 2, this.height * 0.42, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.035)');
      grad.addColorStop(0.55, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.28)');
      this.vignette = { key, grad };
    }
    ctx.fillStyle = this.vignette.grad;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  drawGrid(scene: Scene) {
    const { ctx } = this;
    const v = scene.viewport;
    let size = scene.settings.grid.size * v.zoom;
    while (size < 12) size *= 2;
    while (size > 400) size /= 2;
    ctx.strokeStyle = scene.settings.grid.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const ox = ((v.x % size) + size) % size;
    const oy = ((v.y % size) + size) % size;
    for (let x = ox; x < this.width; x += size) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, this.height);
    }
    for (let y = oy; y < this.height; y += size) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(this.width, Math.round(y) + 0.5);
    }
    ctx.stroke();
  }

  /** Dibuja un ítem en coordenadas de escena (ctx ya transformado). */
  drawItem(ctx: CanvasRenderingContext2D, it: Item, zoom: number) {
    ctx.save();
    ctx.globalAlpha *= it.opacity;
    ctx.translate(it.x, it.y);
    ctx.rotate(it.rotation);
    ctx.scale(it.scale * (it.flipX ? -1 : 1), it.scale * (it.flipY ? -1 : 1));
    switch (it.kind) {
      case 'image':
        this.drawImage(ctx, it, zoom);
        break;
      case 'note':
        this.drawNote(ctx, it);
        break;
      case 'drawing':
        this.drawDrawing(ctx, it);
        break;
    }
    ctx.restore();
  }

  private drawImage(ctx: CanvasRenderingContext2D, it: ImageItem, zoom: number) {
    const bmp = getBitmap(it.blobId);
    let sx = 0, sy = 0, sw = it.naturalW, sh = it.naturalH;
    let w = it.w, h = it.h;
    if (it.crop) {
      sx = it.naturalW * it.crop.left;
      sy = it.naturalH * it.crop.top;
      sw = it.naturalW * (1 - it.crop.left - it.crop.right);
      sh = it.naturalH * (1 - it.crop.top - it.crop.bottom);
      w = it.w * (1 - it.crop.left - it.crop.right);
      h = it.h * (1 - it.crop.top - it.crop.bottom);
    }
    if (bmp) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = zoom * it.scale < 0.5 ? 'medium' : 'high';
      this.applyShadow(ctx, 'strong');
      try {
        ctx.drawImage(bmp, sx, sy, Math.max(1, sw), Math.max(1, sh), -w / 2, -h / 2, w, h);
      } catch {
        /* bitmap cerrado */
      }
      this.clearShadow(ctx);
      // borde interior muy sutil: separa la imagen del fondo como una lámina impresa
      if (!this.exporting) {
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth = 1 / (zoom * it.scale);
        ctx.strokeRect(-w / 2 + ctx.lineWidth / 2, -h / 2 + ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
      }
    } else {
      ctx.fillStyle = isFailed(it.blobId) ? '#5a2a2a' : '#333';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 1 / (zoom * it.scale);
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      if (isFailed(it.blobId)) {
        ctx.strokeStyle = '#c55';
        ctx.beginPath();
        ctx.moveTo(-w / 2, -h / 2);
        ctx.lineTo(w / 2, h / 2);
        ctx.moveTo(w / 2, -h / 2);
        ctx.lineTo(-w / 2, h / 2);
        ctx.stroke();
      }
    }
  }

  /** Maqueta la nota y actualiza su alto si es autoHeight. Devuelve las líneas. */
  layoutNote(ctx: CanvasRenderingContext2D, it: NoteItem): TextLine[] {
    const pad = it.fontSize * 0.6;
    const key = `${it.text}|${it.w}|${it.fontSize}|${it.fontFamily}`;
    const cached = this.noteLayoutCache.get(it.id);
    let lines: TextLine[];
    let height: number;
    if (cached && cached.key === key) {
      lines = cached.lines;
      height = cached.height;
    } else {
      lines = layoutText(it.text || ' ', it.w - pad * 2, it.fontSize, it.fontFamily, (s, f) => {
        ctx.font = f;
        return ctx.measureText(s).width;
      });
      height = Math.max(it.fontSize * 1.35 + pad * 2, lines.length * it.fontSize * 1.35 + pad * 2);
      this.noteLayoutCache.set(it.id, { key, lines, height });
    }
    if (it.autoHeight && Math.abs(it.h - height) > 0.5) it.h = height;
    return lines;
  }

  /**
   * Caja que ocupan las letras de una nota, en coordenadas locales.
   *
   * La usan los gestos para no dejar que una nota transparente se lleve los
   * toques de lo que tiene debajo. Se apoya en la maqueta que ya está
   * cacheada para dibujar, así que no mide de nuevo salvo que el texto haya
   * cambiado.
   */
  noteTextBox(it: NoteItem): Rect | null {
    const lines = this.layoutNote(this.ctx, it);
    return noteTextBox({ w: it.w, h: it.h, fontSize: it.fontSize, align: it.align, lines });
  }

  private drawNote(ctx: CanvasRenderingContext2D, it: NoteItem) {
    const lines = this.layoutNote(ctx, it);
    const pad = it.fontSize * 0.6;
    const r = Math.min(12, it.fontSize * 0.5);
    ctx.beginPath();
    roundRect(ctx, -it.w / 2, -it.h / 2, it.w, it.h, r);
    if (it.background && it.background !== 'transparent') {
      this.applyShadow(ctx, 'soft');
      ctx.fillStyle = it.background;
      ctx.fill();
      this.clearShadow(ctx);
      if (!this.exporting) {
        // brillo superior tipo tarjeta
        const g = ctx.createLinearGradient(0, -it.h / 2, 0, it.h / 2);
        g.addColorStop(0, 'rgba(255,255,255,0.10)');
        g.addColorStop(0.5, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.save();
    ctx.clip();
    ctx.fillStyle = it.color;
    ctx.textBaseline = 'alphabetic';
    const lh = it.fontSize * 1.35;
    let y = -it.h / 2 + pad + it.fontSize;
    for (const line of lines) {
      const indent = line.bullet ? it.fontSize * 1.2 : 0;
      let x = -it.w / 2 + pad + indent;
      const avail = it.w - pad * 2 - indent;
      const lw = line.width - indent;
      if (it.align === 'center') x += (avail - lw) / 2;
      else if (it.align === 'right') x += avail - lw;
      if (line.bullet) {
        ctx.beginPath();
        ctx.arc(-it.w / 2 + pad + it.fontSize * 0.45, y - it.fontSize * 0.33, it.fontSize * 0.14, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const run of line.runs) {
        ctx.font = fontString(it.fontSize, it.fontFamily, run.bold, run.italic);
        if (run.link) {
          ctx.save();
          ctx.fillStyle = '#4da3ff';
          ctx.fillText(run.text, x, y);
          const w = ctx.measureText(run.text).width;
          ctx.fillRect(x, y + 2, w, 1);
          ctx.restore();
          x += w;
        } else {
          ctx.fillText(run.text, x, y);
          x += ctx.measureText(run.text).width;
        }
      }
      y += lh;
    }
    ctx.restore();
  }

  private drawDrawing(ctx: CanvasRenderingContext2D, it: DrawingItem) {
    for (const s of it.strokes) drawStroke(ctx, s, 1);
  }

  /** Sombra proyectada (en píxeles de pantalla: no la afecta la transformación). */
  private applyShadow(ctx: CanvasRenderingContext2D, kind: 'strong' | 'soft') {
    if (!this.shadows || this.exporting) return;
    ctx.shadowColor = kind === 'strong' ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = kind === 'strong' ? 22 : 14;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = kind === 'strong' ? 8 : 4;
  }

  private clearShadow(ctx: CanvasRenderingContext2D) {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  // ---------------------------------------------------------------------
  // selección y gizmo

  rectToScreen(r: Rect): Rect {
    const v = this.store.scene.viewport;
    return { x: r.x * v.zoom + v.x, y: r.y * v.zoom + v.y, w: r.w * v.zoom, h: r.h * v.zoom };
  }

  /** Caja de selección en escena (unión de subárboles de las raíces seleccionadas). */
  selectionBounds(): Rect | null {
    const roots = this.store.selectedRoots();
    if (roots.length === 0) return null;
    const rects: Rect[] = [];
    for (const r of roots) {
      const b = subtreeBounds(this.store.scene, r.id);
      if (b) rects.push(b);
    }
    return unionRects(rects);
  }

  /** Posiciones de los tiradores (pantalla) para la selección actual. */
  handles(): Handle[] {
    const b = this.selectionBounds();
    if (!b || this.overlay.hideGizmo || this.overlay.cropId) return [];
    const s = this.rectToScreen(b);
    const roots = this.store.selectedRoots();
    if (roots.some((r) => r.locked)) return [];
    const hs: Handle[] = [
      { id: 'nw', x: s.x, y: s.y },
      { id: 'ne', x: s.x + s.w, y: s.y },
      { id: 'sw', x: s.x, y: s.y + s.h },
      { id: 'se', x: s.x + s.w, y: s.y + s.h },
      { id: 'rotate', x: s.x + s.w / 2, y: s.y - ROTATE_HANDLE_OFFSET }
    ];
    // tiradores de borde: sólo para una nota única (redimensiona ancho/alto)
    if (roots.length === 1 && roots[0].kind === 'note' && Math.abs(roots[0].rotation) < 1e-6) {
      hs.push({ id: 'e', x: s.x + s.w, y: s.y + s.h / 2 }, { id: 'w', x: s.x, y: s.y + s.h / 2 });
      if (!roots[0].autoHeight) hs.push({ id: 's', x: s.x + s.w / 2, y: s.y + s.h }, { id: 'n', x: s.x + s.w / 2, y: s.y });
    }
    return hs;
  }

  /**
   * Rótulo flotante con el nombre del grupo, encima de su caja. Va en píxeles
   * de pantalla (no escala con el zoom) y nunca se exporta.
   */
  private drawGroupLabel(name: string, s: Rect) {
    const text = (name ?? '').trim();
    if (!text || this.exporting) return;
    const { ctx } = this;
    ctx.save();
    ctx.font = '600 13px system-ui, -apple-system, "Helvetica Neue", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const padX = 10;
    const h = 24;
    const w = Math.min(ctx.measureText(text).width + padX * 2, Math.max(60, this.width - 16));
    // centrado sobre el grupo, dentro del lienzo, y por debajo si no cabe arriba
    const cx = Math.min(Math.max(s.x + s.w / 2, w / 2 + 8), Math.max(w / 2 + 8, this.width - w / 2 - 8));
    // por encima del tirador de rotación, que vive sobre el borde superior
    const y = this.labelY(s, h, ROTATE_HANDLE_OFFSET + 10);
    ctx.beginPath();
    roundRect(ctx, cx - w / 2, y, w, h, 12);
    ctx.fillStyle = 'rgba(10,132,255,0.92)';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - w / 2 + padX / 2, y, w - padX, h);
    ctx.clip();
    ctx.fillText(text, cx, y + h / 2);
    ctx.restore();
    ctx.restore();
  }

  /**
   * Dónde cabe un rótulo de alto `h` respecto de la caja `s`: encima si hay
   * sitio, y si no justo dentro, pero siempre dentro de la pantalla y fuera de
   * las barras. Sin este recorte, arrastrar dentro de una categoría más alta
   * que la vista dibujaba el rótulo fuera del lienzo (invisible).
   */
  private labelY(s: Rect, h: number, gap = 8): number {
    const min = Math.max(8, this.insets.top);
    const max = Math.max(min, this.height - h - Math.max(8, this.insets.bottom));
    const above = s.y - h - gap;
    return Math.min(Math.max(above >= min ? above : s.y + gap, min), max);
  }

  /**
   * Rótulo de lo que va a pasar al soltar, sobre la zona de destino. En
   * píxeles de pantalla, como el nombre del grupo, y nunca se exporta.
   */
  private drawDropLabel(text: string, s: Rect) {
    const label = (text ?? '').trim();
    if (!label || this.exporting) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '600 13px system-ui, -apple-system, "Helvetica Neue", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const padX = 10;
    const h = 24;
    const w = Math.min(ctx.measureText(label).width + padX * 2, Math.max(60, this.width - 16));
    const cx = Math.min(Math.max(s.x + s.w / 2, w / 2 + 8), Math.max(w / 2 + 8, this.width - w / 2 - 8));
    const y = this.labelY(s, h);
    ctx.beginPath();
    roundRect(ctx, cx - w / 2, y, w, h, 12);
    ctx.fillStyle = 'rgba(255,204,0,0.95)';
    ctx.fill();
    ctx.fillStyle = '#1a1a1a';
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - w / 2 + padX / 2, y, w - padX, h);
    ctx.clip();
    ctx.fillText(label, cx, y + h / 2);
    ctx.restore();
    ctx.restore();
  }

  private drawSelection(scene: Scene) {
    const { ctx, store } = this;
    if (store.selection.size === 0) return;
    const v = scene.viewport;
    // contorno de cada ítem seleccionado (rotado)
    for (const it of store.selectedItems()) {
      ctx.save();
      ctx.translate(it.x * v.zoom + v.x, it.y * v.zoom + v.y);
      ctx.rotate(it.rotation);
      const { w, h } = effectiveSize(it);
      let sw = w * v.zoom, sh = h * v.zoom;
      if (it.kind === 'group') {
        const b = subtreeBounds(scene, it.id);
        ctx.restore();
        if (b) {
          const s = this.rectToScreen(b);
          ctx.strokeStyle = it.locked ? '#999' : '#0a84ff';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([8, 4]);
          ctx.strokeRect(s.x, s.y, s.w, s.h);
          ctx.setLineDash([]);
          // el nombre del grupo sólo aparece al seleccionarlo: da el contexto
          // sin dejar un rótulo fijo encima del tablero
          this.drawGroupLabel(it.name, s);
        }
        continue;
      }
      ctx.strokeStyle = it.locked ? '#999' : '#0a84ff';
      ctx.lineWidth = 1.5;
      if (!it.locked) {
        ctx.shadowColor = 'rgba(10,132,255,0.55)';
        ctx.shadowBlur = 10;
      }
      ctx.strokeRect(-sw / 2, -sh / 2, sw, sh);
      ctx.restore();
    }
    // caja global + tiradores
    const b = this.selectionBounds();
    if (!b || this.overlay.hideGizmo) return;
    const s = this.rectToScreen(b);
    ctx.strokeStyle = 'rgba(10,132,255,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(s.x - 0.5, s.y - 0.5, s.w + 1, s.h + 1);
    const hs = this.handles();
    if (hs.length === 0) return;
    const rot = hs.find((h) => h.id === 'rotate');
    if (rot) {
      ctx.beginPath();
      ctx.moveTo(s.x + s.w / 2, s.y);
      ctx.lineTo(rot.x, rot.y);
      ctx.stroke();
    }
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    for (const h of hs) {
      ctx.beginPath();
      if (h.id === 'rotate') ctx.arc(h.x, h.y, HANDLE_SIZE / 2, 0, Math.PI * 2);
      else roundRect(ctx, h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE, 3);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#0a84ff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Tiradores del recorte en pantalla (esquinas + bordes) para el ítem en crop. */
  cropHandles(): Handle[] {
    const it = this.overlay.cropId ? this.store.get(this.overlay.cropId) : null;
    if (!it || it.kind !== 'image') return [];
    const r = this.cropRectScreen(it);
    return [
      { id: 'nw', x: r.x, y: r.y },
      { id: 'ne', x: r.x + r.w, y: r.y },
      { id: 'sw', x: r.x, y: r.y + r.h },
      { id: 'se', x: r.x + r.w, y: r.y + r.h },
      { id: 'n', x: r.x + r.w / 2, y: r.y },
      { id: 's', x: r.x + r.w / 2, y: r.y + r.h },
      { id: 'e', x: r.x + r.w, y: r.y + r.h / 2 },
      { id: 'w', x: r.x, y: r.y + r.h / 2 }
    ];
  }

  /** Rect de pantalla del bitmap completo (sin recorte) del ítem en modo crop, ignorando rotación. */
  fullImageRectScreen(it: ImageItem): Rect {
    const v = this.store.scene.viewport;
    const w = it.w * it.scale * v.zoom;
    const h = it.h * it.scale * v.zoom;
    // el centro del ítem es el centro del área recortada; desplazamos al centro del bitmap
    const c = it.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const cx = it.x * v.zoom + v.x;
    const cy = it.y * v.zoom + v.y;
    const fx = it.flipX ? -1 : 1;
    const fy = it.flipY ? -1 : 1;
    const offX = ((c.right - c.left) / 2) * w * fx;
    const offY = ((c.bottom - c.top) / 2) * h * fy;
    return { x: cx + offX - w / 2, y: cy + offY - h / 2, w, h };
  }

  cropRectScreen(it: ImageItem): Rect {
    const f = this.fullImageRectScreen(it);
    const c = it.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const l = it.flipX ? c.right : c.left;
    const r = it.flipX ? c.left : c.right;
    const t = it.flipY ? c.bottom : c.top;
    const b = it.flipY ? c.top : c.bottom;
    return { x: f.x + f.w * l, y: f.y + f.h * t, w: f.w * (1 - l - r), h: f.h * (1 - t - b) };
  }

  private drawCropOverlay(scene: Scene) {
    const it = this.store.get(this.overlay.cropId!);
    if (!it || it.kind !== 'image') return;
    const { ctx } = this;
    const v = scene.viewport;
    const f = this.fullImageRectScreen(it);
    const bmp = getBitmap(it.blobId);
    // imagen completa atenuada
    ctx.save();
    ctx.globalAlpha = 0.35;
    if (bmp) {
      ctx.save();
      ctx.translate(f.x + f.w / 2, f.y + f.h / 2);
      ctx.scale(it.flipX ? -1 : 1, it.flipY ? -1 : 1);
      try {
        ctx.drawImage(bmp, -f.w / 2, -f.h / 2, f.w, f.h);
      } catch {
        /* ignorar */
      }
      ctx.restore();
    }
    ctx.restore();
    const r = this.cropRectScreen(it);
    // zona recortada nítida
    if (bmp) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      ctx.translate(f.x + f.w / 2, f.y + f.h / 2);
      ctx.scale(it.flipX ? -1 : 1, it.flipY ? -1 : 1);
      try {
        ctx.drawImage(bmp, -f.w / 2, -f.h / 2, f.w, f.h);
      } catch {
        /* ignorar */
      }
      ctx.restore();
    }
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    // regla de tercios
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      ctx.moveTo(r.x + (r.w * i) / 3, r.y);
      ctx.lineTo(r.x + (r.w * i) / 3, r.y + r.h);
      ctx.moveTo(r.x, r.y + (r.h * i) / 3);
      ctx.lineTo(r.x + r.w, r.y + (r.h * i) / 3);
    }
    ctx.stroke();
    for (const h of this.cropHandles()) {
      ctx.beginPath();
      roundRect(ctx, h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE, 3);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    void v;
  }

  invalidateNoteLayout(id: string) {
    this.noteLayoutCache.delete(id);
  }
}

// -------------------------------------------------------------------------
// utilidades de dibujo

function isLightColor(hex: string): boolean {
  const m = /^#([0-9a-f]{6})/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Dibuja un trazo en coordenadas locales. */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, alpha: number) {
  const pts = s.points;
  if (pts.length === 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const a = pts[0];
  const b = pts[pts.length - 1];
  switch (s.tool) {
    case 'pen': {
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(a.x, a.y, (s.width * Math.max(0.3, a.p)) / 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      // segmentos con grosor variable por presión, suavizados con puntos medios
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1];
        const p1 = pts[i];
        const pressure = (p0.p + p1.p) / 2;
        ctx.lineWidth = Math.max(0.5, s.width * (0.35 + 0.65 * pressure));
        ctx.beginPath();
        if (i === 1) ctx.moveTo(p0.x, p0.y);
        else ctx.moveTo((pts[i - 2].x + p0.x) / 2, (pts[i - 2].y + p0.y) / 2);
        const mx = (p0.x + p1.x) / 2;
        const my = (p0.y + p1.y) / 2;
        if (i === pts.length - 1) ctx.quadraticCurveTo(p0.x, p0.y, p1.x, p1.y);
        else ctx.quadraticCurveTo(p0.x, p0.y, mx, my);
        ctx.stroke();
      }
      break;
    }
    case 'line':
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      break;
    case 'arrow': {
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const len = Math.max(10, s.width * 4);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - len * Math.cos(ang - 0.45), b.y - len * Math.sin(ang - 0.45));
      ctx.lineTo(b.x - len * Math.cos(ang + 0.45), b.y - len * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'rect':
      ctx.lineWidth = s.width;
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      break;
    case 'ellipse':
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
  }
  ctx.restore();
}

/** Caja local (sin transformar) de un conjunto de trazos, con margen por grosor. */
export function strokesBounds(strokes: Stroke[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    const m = s.width;
    for (const p of s.points) {
      x0 = Math.min(x0, p.x - m);
      y0 = Math.min(y0, p.y - m);
      x1 = Math.max(x1, p.x + m);
      y1 = Math.max(y1, p.y + m);
    }
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Renderiza ítems a un canvas nuevo (exportación). `scale` = píxeles por
 * unidad de escena. Devuelve el canvas.
 */
export function renderToCanvas(
  renderer: Renderer,
  items: Item[],
  bounds: Rect,
  scale: number,
  background: string | null
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const margin = 0;
  canvas.width = Math.max(1, Math.round((bounds.w + margin * 2) * scale));
  canvas.height = Math.max(1, Math.round((bounds.h + margin * 2) * scale));
  const ctx = canvas.getContext('2d')!;
  if (background && background !== 'transparent') {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.scale(scale, scale);
  ctx.translate(-bounds.x + margin, -bounds.y + margin);
  const order = renderOrder(renderer.store.scene).filter((i) => items.includes(i));
  renderer.exporting = true;
  try {
    for (const it of order) {
      if (!it.visible || it.kind === 'group') continue;
      renderer.drawItem(ctx, it, scale);
    }
  } finally {
    renderer.exporting = false;
  }
  return canvas;
}
