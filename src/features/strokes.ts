/**
 * Geometría de trazos: dónde está de verdad la tinta dentro de un dibujo.
 *
 * Un `drawing` se guarda como una caja rectangular que envuelve sus trazos,
 * pero la tinta ocupa una parte mínima de esa caja. Si el toque se resuelve
 * con la caja —y los dibujos se pintan siempre por encima de las imágenes—,
 * cualquier anotación tapa todo lo que tenga debajo: se vuelve imposible
 * seleccionar la imagen que uno acaba de anotar.
 *
 * Aquí se mide la distancia real del punto a cada trazo. Módulo PURO:
 * coordenadas locales del ítem, sin DOM ni store.
 */
import type { Stroke } from '../core/model';

export interface Point {
  x: number;
  y: number;
}

/** Cuánto se acepta fallar el trazo, en píxeles de pantalla. */
export const STROKE_SLOP = 8;

/** Puntos con los que se aproxima una elipse. */
const ELLIPSE_STEPS = 64;

/** Distancia de `p` al segmento `a`–`b`. */
export function segmentDistance(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  // proyección del punto sobre la recta, recortada al segmento
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}

/** Distancia de `p` a una polilínea abierta. */
function polylineDistance(p: Point, pts: Point[]): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    best = Math.min(best, segmentDistance(p, pts[i - 1]!, pts[i]!));
    if (best === 0) break;
  }
  return best;
}

/** Los cuatro lados de un rectángulo definido por dos esquinas. */
function rectOutline(a: Point, b: Point): Point[] {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
    { x: x0, y: y0 }
  ];
}

/** Contorno de una elipse inscrita en la caja `a`–`b`, muestreado. */
function ellipseOutline(a: Point, b: Point): Point[] {
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2;
  const ry = Math.abs(b.y - a.y) / 2;
  const pts: Point[] = [];
  for (let i = 0; i <= ELLIPSE_STEPS; i++) {
    const t = (i / ELLIPSE_STEPS) * Math.PI * 2;
    pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return pts;
}

/**
 * Distancia de `p` a la tinta de un trazo, en coordenadas locales del ítem.
 *
 * Cada herramienta se mide contra lo que de verdad se dibuja: el lápiz contra
 * sus puntos, la línea y la flecha contra su segmento, el rectángulo contra
 * sus cuatro lados y la elipse contra su contorno. Las formas son huecas —se
 * dibujan con `stroke`, no con `fill`—, así que tocar su interior no las toca
 * a ellas.
 */
export function strokeDistance(s: Stroke, p: Point): number {
  const pts = s.points;
  if (pts.length === 0) return Infinity;
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  switch (s.tool) {
    case 'pen':
      return polylineDistance(p, pts);
    case 'line':
    case 'arrow':
      // la punta de la flecha cabe dentro de la holgura del propio segmento
      return segmentDistance(p, a, b);
    case 'rect':
      return polylineDistance(p, rectOutline(a, b));
    case 'ellipse':
      return polylineDistance(p, ellipseOutline(a, b));
    default:
      return polylineDistance(p, pts);
  }
}

/**
 * ¿Cae `p` sobre la tinta de alguno de los trazos?
 *
 * @param p    punto en coordenadas locales del ítem.
 * @param slop holgura extra, en las mismas unidades locales, para que el dedo
 *             no tenga que acertar el trazo al píxel. Al grosor del trazo se
 *             le suma esta holgura.
 */
export function strokesHit(strokes: Stroke[], p: Point, slop = 0): boolean {
  for (const s of strokes) {
    if (strokeDistance(s, p) <= s.width / 2 + slop) return true;
  }
  return false;
}
