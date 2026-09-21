/**
 * Cálculo del encuadre del lienzo.
 *
 * Todo lo que tiene que ver con «qué parte de la escena se ve» vive aquí y es
 * PURO: recibe el tamaño del lienzo, las franjas que tapan las barras
 * flotantes y un rectángulo de escena, y devuelve un `Viewport`. Así el
 * comportamiento al rotar el dispositivo se puede probar sin navegador.
 *
 * Recordatorio del modelo: `viewport.x/y` es dónde cae el origen de la escena
 * en píxeles CSS del lienzo, y `zoom` los píxeles por unidad de escena. Un
 * punto de escena `p` se dibuja en `p * zoom + (x, y)`.
 */
import type { Rect, Viewport } from '../core/model';

/** Límites de zoom de la aplicación. */
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 40;

/** Tamaño del lienzo en píxeles CSS. */
export interface Size {
  w: number;
  h: number;
}

/** Franjas tapadas por las barras flotantes, en píxeles CSS. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Sin barras: todo el lienzo es útil. */
export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v));
}

/**
 * Parte del lienzo donde de verdad se puede dejar contenido: la que no tapan
 * las barras. Nunca devuelve menos de 40 px de lado, para que el cálculo siga
 * teniendo sentido en una ventana diminuta.
 */
export function usableArea(size: Size, insets: Insets, padding = 0): Rect {
  const p = Math.max(0, padding);
  const x = insets.left + p;
  const y = insets.top + p;
  const w = Math.max(40, size.w - insets.left - insets.right - p * 2);
  const h = Math.max(40, size.h - insets.top - insets.bottom - p * 2);
  return { x, y, w, h };
}

/**
 * Encuadre que deja `rect` completo y centrado en el área útil. Sin
 * rectángulo (tablero vacío) devuelve el origen en el centro y zoom 1.
 */
export function fitViewport(rect: Rect | null, size: Size, insets: Insets, padding = 0): Viewport {
  const area = usableArea(size, insets, padding);
  if (!rect || rect.w <= 0 || rect.h <= 0) {
    return { x: area.x + area.w / 2, y: area.y + area.h / 2, zoom: 1 };
  }
  const zoom = clamp(Math.min(area.w / rect.w, area.h / rect.h), MIN_ZOOM, MAX_ZOOM);
  return {
    zoom,
    x: area.x + area.w / 2 - (rect.x + rect.w / 2) * zoom,
    y: area.y + area.h / 2 - (rect.y + rect.h / 2) * zoom
  };
}

/**
 * Encuadre que mantiene en el centro lo que ya estaba en el centro cuando
 * cambia el tamaño del lienzo (rotar el dispositivo, Split View, la barra de
 * Safari que aparece y desaparece). El zoom no se toca.
 *
 * Sin esto, `viewport.x/y` se queda con los valores de la orientación anterior
 * y el tablero aparece corrido a una esquina.
 */
export function recenterOnResize(v: Viewport, prev: Size, next: Size): Viewport {
  if (prev.w <= 0 || prev.h <= 0) return v;
  return { ...v, x: v.x + (next.w - prev.w) / 2, y: v.y + (next.h - prev.h) / 2 };
}

/** Caja de un rectángulo de escena en píxeles del lienzo. */
function toScreen(rect: Rect, v: Viewport): Rect {
  return { x: rect.x * v.zoom + v.x, y: rect.y * v.zoom + v.y, w: rect.w * v.zoom, h: rect.h * v.zoom };
}

/**
 * Holgura al comprobar si algo se ve entero: un encuadre recién hecho deja el
 * contenido justo en el borde del área útil y el redondeo en coma flotante lo
 * dejaría «fuera» por una milésima de píxel.
 */
const EDGE_EPS = 0.5;

/** ¿Se ve `rect` entero dentro del área útil? */
export function rectFullyVisible(rect: Rect | null, v: Viewport, size: Size, insets: Insets): boolean {
  if (!rect || rect.w <= 0 || rect.h <= 0) return false;
  const area = usableArea(size, insets);
  const s = toScreen(rect, v);
  return (
    s.x >= area.x - EDGE_EPS &&
    s.y >= area.y - EDGE_EPS &&
    s.x + s.w <= area.x + area.w + EDGE_EPS &&
    s.y + s.h <= area.y + area.h + EDGE_EPS
  );
}

/** Cuánto del área útil ocupa `rect` (0..1). */
export function coverage(rect: Rect | null, v: Viewport, size: Size, insets: Insets): number {
  if (!rect || rect.w <= 0 || rect.h <= 0) return 0;
  const area = usableArea(size, insets);
  const s = toScreen(rect, v);
  return (s.w * s.h) / (area.w * area.h);
}

/** Ocupación mínima para considerar que el tablero estaba encuadrado. */
const FITTED_COVERAGE = 0.3;

/**
 * ¿Conviene volver a encuadrar tras un cambio de tamaño?
 *
 * Sí cuando se veía el tablero completo y llenando la pantalla: al rotar, lo
 * natural es seguir viéndolo completo. No cuando el usuario estaba con el zoom
 * puesto en un detalle o muy alejado, porque ahí mandar el encuadre sería
 * quitarle el sitio donde estaba trabajando; en ese caso basta con recentrar.
 */
export function shouldRefit(rect: Rect | null, v: Viewport, size: Size, insets: Insets): boolean {
  return rectFullyVisible(rect, v, size, insets) && coverage(rect, v, size, insets) >= FITTED_COVERAGE;
}
