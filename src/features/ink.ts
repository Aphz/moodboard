/**
 * Tinta: cómo se agrupan los trazos sueltos en dibujos.
 *
 * Escribir a mano son muchos trazos cortos y seguidos. Si cada uno queda como
 * un ítem propio, el lienzo se llena de cajas; si todos se pegan al dibujo que
 * esté seleccionado, un trazo hecho al otro lado del tablero termina dentro de
 * la misma anotación y su caja crece sin sentido.
 *
 * La regla es la de una libreta: un trazo **continúa** el dibujo anterior si se
 * hizo poco después y cerca de él. Si no, empieza uno nuevo.
 *
 * Módulo PURO: sólo geometría y tiempos.
 */
import { rectsIntersect, type Rect } from '../core/model';

/** Último dibujo al que se añadió un trazo. */
export interface InkAnchor {
  /** Ítem `drawing` que recibió el trazo. */
  id: string;
  /** Caja del dibujo en coordenadas de escena. */
  box: Rect;
  /** Cuándo terminó ese trazo (ms). */
  at: number;
}

export interface InkOptions {
  /** Cuánto tiempo sigue «abierta» una anotación (ms). */
  windowMs?: number;
  /** Margen alrededor del dibujo que todavía cuenta como «cerca», en unidades de escena. */
  nearby?: number;
}

/** Una anotación sigue abierta un segundo y medio después del último trazo. */
export const INK_WINDOW_MS = 1500;

/** Ancho del margen «cerca» por defecto, relativo al trazo que se acaba de hacer. */
export const INK_NEARBY_FACTOR = 1.5;

/** Infla un rectángulo `m` unidades por lado. */
function inflate(r: Rect, m: number): Rect {
  return { x: r.x - m, y: r.y - m, w: r.w + m * 2, h: r.h + m * 2 };
}

/**
 * ¿El trazo nuevo continúa el dibujo anterior?
 *
 * @param anchor dibujo anterior, o `null` si no hay ninguno.
 * @param box    caja del trazo nuevo, en coordenadas de escena.
 * @param now    momento del trazo nuevo (ms).
 */
export function continuesDrawing(anchor: InkAnchor | null, box: Rect, now: number, opts: InkOptions = {}): boolean {
  if (!anchor) return false;
  const windowMs = opts.windowMs ?? INK_WINDOW_MS;
  if (now - anchor.at > windowMs || now < anchor.at) return false;
  // «cerca» se mide con el tamaño del trazo nuevo: escribir letras pequeñas
  // junta más que dibujar trazos largos
  const nearby = opts.nearby ?? Math.max(box.w, box.h) * INK_NEARBY_FACTOR;
  return rectsIntersect(inflate(anchor.box, nearby), box);
}

/** Caja de una lista de puntos en coordenadas de escena (con margen por grosor). */
export function pointsBounds(points: { x: number; y: number }[], margin = 0): Rect {
  if (!points.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0 - margin, y: y0 - margin, w: x1 - x0 + margin * 2, h: y1 - y0 + margin * 2 };
}
