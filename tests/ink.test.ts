/**
 * Pruebas de la agrupación de trazos (src/features/ink.ts): escribir a mano
 * junta los trazos seguidos y cercanos en un solo dibujo, y un trazo lejano o
 * tardío empieza otro.
 */
import { describe, expect, it } from 'vitest';
import { INK_WINDOW_MS, continuesDrawing, pointsBounds, type InkAnchor } from '../src/features/ink';

const ancla: InkAnchor = { id: 'd1', box: { x: 0, y: 0, w: 100, h: 40 }, at: 1000 };

describe('continuesDrawing', () => {
  it('un trazo seguido y pegado continúa el dibujo', () => {
    // la «o» que sigue a la «l», 200 ms después y 10 unidades más allá
    expect(continuesDrawing(ancla, { x: 110, y: 5, w: 20, h: 30 }, 1200)).toBe(true);
  });

  it('un trazo lejano empieza otro dibujo aunque sea inmediato', () => {
    expect(continuesDrawing(ancla, { x: 900, y: 600, w: 20, h: 30 }, 1050)).toBe(false);
  });

  it('un trazo tardío empieza otro dibujo aunque sea encima', () => {
    expect(continuesDrawing(ancla, { x: 10, y: 10, w: 20, h: 20 }, 1000 + INK_WINDOW_MS + 1)).toBe(false);
  });

  it('sin dibujo anterior no hay nada que continuar', () => {
    expect(continuesDrawing(null, { x: 0, y: 0, w: 10, h: 10 }, 1000)).toBe(false);
  });

  it('el margen de «cerca» crece con el tamaño del trazo', () => {
    const lejos = { x: 200, y: 0, w: 10, h: 10 };
    // un trazo chico a 100 unidades no alcanza…
    expect(continuesDrawing(ancla, lejos, 1100)).toBe(false);
    // …pero uno grande (un subrayado largo) sí se considera parte de lo mismo
    expect(continuesDrawing(ancla, { x: 200, y: 0, w: 300, h: 10 }, 1100)).toBe(true);
  });

  it('un reloj que retrocede no cuela trazos viejos', () => {
    expect(continuesDrawing(ancla, { x: 10, y: 10, w: 10, h: 10 }, 500)).toBe(false);
  });

  it('se pueden ajustar la ventana y el margen', () => {
    const tarde = 1000 + 5000;
    expect(continuesDrawing(ancla, { x: 10, y: 10, w: 10, h: 10 }, tarde, { windowMs: 10_000 })).toBe(true);
    expect(continuesDrawing(ancla, { x: 400, y: 0, w: 10, h: 10 }, 1100, { nearby: 500 })).toBe(true);
  });
});

describe('pointsBounds', () => {
  it('encierra los puntos y suma el margen del grosor', () => {
    expect(pointsBounds([{ x: 10, y: 20 }, { x: 30, y: 60 }], 3)).toEqual({ x: 7, y: 17, w: 26, h: 46 });
  });

  it('sin puntos devuelve una caja vacía', () => {
    expect(pointsBounds([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('un solo punto da una caja del tamaño del margen', () => {
    expect(pointsBounds([{ x: 5, y: 5 }], 2)).toEqual({ x: 3, y: 3, w: 4, h: 4 });
  });
});
