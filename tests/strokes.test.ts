/**
 * Pruebas de la geometría de trazos (src/features/strokes.ts): un dibujo se
 * toca donde está la tinta, no en toda su caja. Es lo que permite seleccionar
 * la imagen que hay debajo de una anotación.
 */
import { describe, expect, it } from 'vitest';
import type { Stroke, StrokeTool } from '../src/core/model';
import { STROKE_SLOP, segmentDistance, strokeDistance, strokesHit } from '../src/features/strokes';

/** Trazo de prueba: puntos sueltos con presión 1 y grosor 2 (radio 1). */
function stroke(tool: StrokeTool, pts: [number, number][], width = 2): Stroke {
  return { tool, color: '#fff', width, points: pts.map(([x, y]) => ({ x, y, p: 1 })) };
}

describe('segmentDistance', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };

  it('mide la perpendicular cuando el punto cae sobre el segmento', () => {
    expect(segmentDistance({ x: 5, y: 3 }, a, b)).toBeCloseTo(3, 6);
    expect(segmentDistance({ x: 5, y: 0 }, a, b)).toBeCloseTo(0, 6);
  });

  it('mide a los extremos cuando el punto se pasa de largo', () => {
    // sin recortar la proyección, esto daría 0 y el trazo sería infinito
    expect(segmentDistance({ x: -4, y: 0 }, a, b)).toBeCloseTo(4, 6);
    expect(segmentDistance({ x: 14, y: 0 }, a, b)).toBeCloseTo(4, 6);
  });

  it('un segmento degenerado es un punto', () => {
    expect(segmentDistance({ x: 3, y: 4 }, a, a)).toBeCloseTo(5, 6);
  });
});

describe('strokeDistance', () => {
  it('el lápiz se mide contra su polilínea', () => {
    const s = stroke('pen', [[0, 0], [10, 0], [10, 10]]);
    expect(strokeDistance(s, { x: 5, y: 2 })).toBeCloseTo(2, 6);
    expect(strokeDistance(s, { x: 10, y: 5 })).toBeCloseTo(0, 6);
    // el hueco que encierra la ele no es tinta
    expect(strokeDistance(s, { x: 2, y: 8 })).toBeGreaterThan(5);
  });

  it('un lápiz de un solo punto es un punto', () => {
    expect(strokeDistance(stroke('pen', [[0, 0]]), { x: 3, y: 4 })).toBeCloseTo(5, 6);
  });

  it('el rectángulo es hueco: se toca el borde, no el centro', () => {
    const s = stroke('rect', [[-10, -10], [10, 10]]);
    expect(strokeDistance(s, { x: -10, y: 0 })).toBeCloseTo(0, 6); // sobre el lado
    expect(strokeDistance(s, { x: 0, y: 0 })).toBeCloseTo(10, 6); // centro vacío
  });

  it('la elipse también es hueca', () => {
    const s = stroke('ellipse', [[-10, -10], [10, 10]]);
    expect(strokeDistance(s, { x: 10, y: 0 })).toBeLessThan(0.1); // sobre el contorno
    expect(strokeDistance(s, { x: 0, y: 0 })).toBeCloseTo(10, 1); // centro vacío
  });

  it('línea y flecha se miden contra su segmento', () => {
    for (const tool of ['line', 'arrow'] as const) {
      const s = stroke(tool, [[0, 0], [10, 0]]);
      expect(strokeDistance(s, { x: 5, y: 1 })).toBeCloseTo(1, 6);
      expect(strokeDistance(s, { x: 5, y: 20 })).toBeCloseTo(20, 6);
    }
  });

  it('un trazo sin puntos no está en ninguna parte', () => {
    expect(strokeDistance(stroke('pen', []), { x: 0, y: 0 })).toBe(Infinity);
  });
});

describe('strokesHit', () => {
  const linea = stroke('pen', [[0, 0], [100, 0]], 4); // radio 2

  it('acierta sobre la tinta y falla lejos de ella', () => {
    expect(strokesHit([linea], { x: 50, y: 1 })).toBe(true);
    expect(strokesHit([linea], { x: 50, y: 2 })).toBe(true); // justo en el borde
    expect(strokesHit([linea], { x: 50, y: 40 })).toBe(false);
  });

  it('la holgura ensancha el blanco sin volverlo la caja entera', () => {
    expect(strokesHit([linea], { x: 50, y: 6 })).toBe(false);
    expect(strokesHit([linea], { x: 50, y: 6 }, 5)).toBe(true);
    expect(strokesHit([linea], { x: 50, y: 60 }, 5)).toBe(false);
  });

  it('basta con acertarle a uno de los trazos', () => {
    const otra = stroke('pen', [[0, 50], [100, 50]], 4);
    expect(strokesHit([linea, otra], { x: 50, y: 50 })).toBe(true);
    expect(strokesHit([linea, otra], { x: 50, y: 25 })).toBe(false);
  });

  it('un dibujo vacío no se puede tocar', () => {
    expect(strokesHit([], { x: 0, y: 0 }, 100)).toBe(false);
  });

  it('el caso que se veía en el celular: escribir sobre una imagen', () => {
    // dos palabras escritas a mano: su caja mide 200x60, pero entre las
    // líneas y en los márgenes no hay tinta y ahí debe pasar el toque
    const palabra1 = stroke('pen', [[-100, -30], [-40, -30], [-40, -10]], 3);
    const palabra2 = stroke('pen', [[20, 20], [100, 20]], 3);
    const tinta = [palabra1, palabra2];
    expect(strokesHit(tinta, { x: -70, y: -30 }, STROKE_SLOP)).toBe(true);
    expect(strokesHit(tinta, { x: 60, y: 20 }, STROKE_SLOP)).toBe(true);
    // el hueco central de la caja: la imagen de abajo tiene que recibir el toque
    expect(strokesHit(tinta, { x: -20, y: 0 }, STROKE_SLOP)).toBe(false);
    expect(strokesHit(tinta, { x: 90, y: -25 }, STROKE_SLOP)).toBe(false);
  });
});
