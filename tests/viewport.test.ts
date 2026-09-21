/**
 * Pruebas del encuadre del lienzo (src/features/viewport.ts): el tablero cabe
 * entre las barras flotantes, al rotar el dispositivo no se va a una esquina y
 * sólo se vuelve a encuadrar cuando se estaba viendo entero.
 */
import { describe, expect, it } from 'vitest';
import type { Rect } from '../src/core/model';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  NO_INSETS,
  coverage,
  fitViewport,
  recenterOnResize,
  rectFullyVisible,
  shouldRefit,
  usableArea
} from '../src/features/viewport';

/** iPhone en vertical, con barra superior y barra de herramientas. */
const PORTRAIT = { w: 390, h: 844 };
const LANDSCAPE = { w: 844, h: 390 };
const BARS = { top: 90, right: 16, bottom: 110, left: 16 };

const board: Rect = { x: -600, y: -400, w: 1200, h: 800 };

describe('usableArea', () => {
  it('descuenta las barras y el relleno pedido', () => {
    expect(usableArea(PORTRAIT, BARS)).toEqual({ x: 16, y: 90, w: 358, h: 644 });
    expect(usableArea(PORTRAIT, BARS, 20)).toEqual({ x: 36, y: 110, w: 318, h: 604 });
  });

  it('nunca devuelve un área ridícula aunque las barras no quepan', () => {
    const a = usableArea({ w: 100, h: 100 }, { top: 200, right: 200, bottom: 200, left: 200 });
    expect(a.w).toBe(40);
    expect(a.h).toBe(40);
  });
});

describe('fitViewport', () => {
  it('deja el tablero entero y centrado en el área útil', () => {
    const v = fitViewport(board, PORTRAIT, BARS);
    expect(rectFullyVisible(board, v, PORTRAIT, BARS)).toBe(true);
    const area = usableArea(PORTRAIT, BARS);
    // el centro del tablero cae en el centro del área útil, no del lienzo
    expect(v.x).toBeCloseTo(area.x + area.w / 2, 6);
    expect(v.y).toBeCloseTo(area.y + area.h / 2, 6);
  });

  it('no mete nada debajo de las barras', () => {
    const v = fitViewport(board, PORTRAIT, BARS);
    const top = board.y * v.zoom + v.y;
    const bottom = (board.y + board.h) * v.zoom + v.y;
    expect(top).toBeGreaterThanOrEqual(BARS.top);
    expect(bottom).toBeLessThanOrEqual(PORTRAIT.h - BARS.bottom);
  });

  it('respeta los límites de zoom', () => {
    const enorme: Rect = { x: 0, y: 0, w: 1e6, h: 1e6 };
    const diminuto: Rect = { x: 0, y: 0, w: 0.5, h: 0.5 };
    expect(fitViewport(enorme, PORTRAIT, NO_INSETS).zoom).toBeCloseTo(MIN_ZOOM, 6);
    expect(fitViewport(diminuto, PORTRAIT, NO_INSETS).zoom).toBeLessThanOrEqual(MAX_ZOOM);
  });

  it('sin tablero deja el origen al centro del área útil y zoom 1', () => {
    const v = fitViewport(null, PORTRAIT, NO_INSETS);
    expect(v).toEqual({ x: 195, y: 422, zoom: 1 });
    expect(fitViewport({ x: 0, y: 0, w: 0, h: 0 }, PORTRAIT, NO_INSETS).zoom).toBe(1);
  });
});

describe('recenterOnResize', () => {
  it('mantiene al centro lo que ya estaba al centro', () => {
    const v = fitViewport(board, PORTRAIT, BARS);
    const centroAntes = { x: (PORTRAIT.w / 2 - v.x) / v.zoom, y: (PORTRAIT.h / 2 - v.y) / v.zoom };
    const r = recenterOnResize(v, PORTRAIT, LANDSCAPE);
    const centroDespues = { x: (LANDSCAPE.w / 2 - r.x) / r.zoom, y: (LANDSCAPE.h / 2 - r.y) / r.zoom };
    expect(centroDespues.x).toBeCloseTo(centroAntes.x, 6);
    expect(centroDespues.y).toBeCloseTo(centroAntes.y, 6);
  });

  it('no toca el zoom ni inventa nada si el tamaño anterior era cero', () => {
    const v = { x: 10, y: 20, zoom: 2 };
    expect(recenterOnResize(v, { w: 0, h: 0 }, LANDSCAPE)).toEqual(v);
    expect(recenterOnResize(v, PORTRAIT, LANDSCAPE).zoom).toBe(2);
  });

  it('al rotar, el tablero sigue en el medio y no se va a una esquina', () => {
    const v = fitViewport(board, PORTRAIT, BARS);
    const r = recenterOnResize(v, PORTRAIT, LANDSCAPE);
    const centro = { x: (board.x + board.w / 2) * r.zoom + r.x, y: (board.y + board.h / 2) * r.zoom + r.y };
    // sigue centrado salvo el desnivel entre la barra de arriba y la de abajo
    expect(Math.abs(centro.x - LANDSCAPE.w / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(centro.y - LANDSCAPE.h / 2)).toBeLessThanOrEqual((BARS.bottom - BARS.top) / 2 + 1);
    // sin la corrección quedaría fuera: el viewport de vertical en horizontal
    const sinCorregir = { x: (board.x + board.w / 2) * v.zoom + v.x, y: (board.y + board.h / 2) * v.zoom + v.y };
    expect(sinCorregir.y).toBeGreaterThan(LANDSCAPE.h);
  });
});

describe('shouldRefit', () => {
  it('vuelve a encuadrar si se veía el tablero completo y lleno', () => {
    const v = fitViewport(board, PORTRAIT, BARS);
    expect(shouldRefit(board, v, PORTRAIT, BARS)).toBe(true);
  });

  it('no toca el encuadre si el usuario está con el zoom en un detalle', () => {
    const v = { ...fitViewport(board, PORTRAIT, BARS), zoom: 4 };
    expect(rectFullyVisible(board, v, PORTRAIT, BARS)).toBe(false);
    expect(shouldRefit(board, v, PORTRAIT, BARS)).toBe(false);
  });

  it('tampoco si el tablero se ve completo pero diminuto', () => {
    const v = { ...fitViewport(board, PORTRAIT, BARS), zoom: 0.05 };
    expect(rectFullyVisible(board, v, PORTRAIT, BARS)).toBe(true);
    expect(coverage(board, v, PORTRAIT, BARS)).toBeLessThan(0.3);
    expect(shouldRefit(board, v, PORTRAIT, BARS)).toBe(false);
  });

  it('con el tablero vacío no hay nada que encuadrar', () => {
    expect(shouldRefit(null, { x: 0, y: 0, zoom: 1 }, PORTRAIT, BARS)).toBe(false);
    expect(coverage(null, { x: 0, y: 0, zoom: 1 }, PORTRAIT, BARS)).toBe(0);
    expect(rectFullyVisible(null, { x: 0, y: 0, zoom: 1 }, PORTRAIT, BARS)).toBe(false);
  });
});
