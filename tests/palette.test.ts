/**
 * Pruebas de la extracción de paleta. Se construyen buffers RGBA sintéticos
 * (sin canvas) para poder ejecutarlas en jsdom.
 */
import { describe, it, expect } from 'vitest';
import {
  extractPalette,
  dominantColor,
  rgbToHex,
  hexToRgb,
  rgbToHsl,
  hslToRgb,
  hueOf,
  contrastText
} from '../src/features/palette';

/** Construye un buffer RGBA a partir de tramos `[color, repeticiones]`. */
function buildRgba(runs: Array<[[number, number, number], number]>): Uint8ClampedArray {
  const total = runs.reduce((n, [, c]) => n + c, 0);
  const data = new Uint8ClampedArray(total * 4);
  let o = 0;
  for (const [[r, g, b], count] of runs) {
    for (let i = 0; i < count; i++) {
      data[o++] = r;
      data[o++] = g;
      data[o++] = b;
      data[o++] = 255;
    }
  }
  return data;
}

/** Comprueba que un hex está a ±`tol` por canal del color esperado. */
function expectNear(hex: string, expected: [number, number, number], tol = 8): void {
  const c = hexToRgb(hex);
  expect(c, `hex inválido: ${hex}`).not.toBeNull();
  expect(Math.abs(c!.r - expected[0]), `canal R de ${hex}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(c!.g - expected[1]), `canal G de ${hex}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(c!.b - expected[2]), `canal B de ${hex}`).toBeLessThanOrEqual(tol);
}

const RED: [number, number, number] = [255, 0, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const GREEN: [number, number, number] = [0, 255, 0];

describe('extractPalette', () => {
  it('devuelve los colores dominantes ordenados por población', () => {
    const data = buildRgba([
      [RED, 50],
      [BLUE, 30],
      [GREEN, 20]
    ]);
    const pal = extractPalette(data, 6);
    expect(pal).toHaveLength(3);
    expectNear(pal[0]!, RED);
    expectNear(pal[1]!, BLUE);
    expectNear(pal[2]!, GREEN);
  });

  it('no depende del orden de los píxeles en el buffer', () => {
    const data = buildRgba([
      [GREEN, 20],
      [RED, 25],
      [BLUE, 30],
      [RED, 25]
    ]);
    const pal = extractPalette(data, 6);
    expect(pal).toHaveLength(3);
    expectNear(pal[0]!, RED);
    expectNear(pal[1]!, BLUE);
    expectNear(pal[2]!, GREEN);
  });

  it('es determinista', () => {
    const data = buildRgba([
      [RED, 50],
      [BLUE, 30],
      [GREEN, 20]
    ]);
    expect(extractPalette(data, 6)).toEqual(extractPalette(data, 6));
  });

  it('fusiona colores perceptualmente casi iguales', () => {
    const data = buildRgba([
      [[255, 0, 0], 40],
      [[250, 4, 3], 35],
      [[247, 2, 6], 25]
    ]);
    const pal = extractPalette(data, 6);
    expect(pal).toHaveLength(1);
    expectNear(pal[0]!, [251, 2, 3]);
  });

  it('mantiene separados colores perceptualmente distintos', () => {
    const data = buildRgba([
      [RED, 40],
      [BLUE, 35],
      [[255, 255, 255], 25]
    ]);
    const pal = extractPalette(data, 6);
    expect(pal).toHaveLength(3);
  });

  it('respeta el límite de count', () => {
    const runs: Array<[[number, number, number], number]> = [
      [[255, 0, 0], 50],
      [[0, 255, 0], 40],
      [[0, 0, 255], 30],
      [[255, 255, 0], 20],
      [[0, 255, 255], 10],
      [[255, 0, 255], 5],
      [[255, 255, 255], 3]
    ];
    expect(extractPalette(buildRgba(runs), 3)).toHaveLength(3);
  });

  it('ignora los píxeles transparentes', () => {
    const data = new Uint8ClampedArray(4 * 4);
    // 3 píxeles azules totalmente transparentes + 1 rojo opaco
    for (let i = 0; i < 3; i++) {
      data[i * 4 + 2] = 255;
      data[i * 4 + 3] = 0;
    }
    data[12] = 255;
    data[15] = 255;
    const pal = extractPalette(data, 4);
    expect(pal).toEqual(['#ff0000']);
  });

  it('devuelve lista vacía si no hay píxeles utilizables', () => {
    expect(extractPalette(new Uint8ClampedArray(0), 4)).toEqual([]);
    expect(extractPalette(new Uint8ClampedArray(16), 4)).toEqual([]);
  });
});

describe('dominantColor', () => {
  it('devuelve el color mayoritario', () => {
    const data = buildRgba([
      [BLUE, 70],
      [RED, 30]
    ]);
    expectNear(dominantColor(data), BLUE);
  });
});

describe('conversiones de color', () => {
  it('rgbToHex recorta y rellena con ceros', () => {
    expect(rgbToHex(255, 0, 0)).toBe('#ff0000');
    expect(rgbToHex(0, 0, 0)).toBe('#000000');
    expect(rgbToHex(-20, 300, 8)).toBe('#00ff08');
  });

  it('hexToRgb admite #rgb, #rrggbb y #rrggbbaa', () => {
    expect(hexToRgb('#f00')).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb('00ff00')).toEqual({ r: 0, g: 255, b: 0 });
    expect(hexToRgb('#0000ffcc')).toEqual({ r: 0, g: 0, b: 255 });
    expect(hexToRgb('no-soy-un-color')).toBeNull();
  });

  it('rgbToHsl y hslToRgb son inversas', () => {
    const hsl = rgbToHsl(20, 140, 200);
    const back = hslToRgb(hsl.h, hsl.s, hsl.l);
    expect(back).toEqual({ r: 20, g: 140, b: 200 });
  });

  it('rgbToHsl describe correctamente el gris y el rojo', () => {
    expect(rgbToHsl(128, 128, 128).s).toBe(0);
    const red = rgbToHsl(255, 0, 0);
    expect(red.h).toBeCloseTo(0, 5);
    expect(red.s).toBeCloseTo(1, 5);
  });
});

describe('hueOf', () => {
  it('devuelve el tono de colores saturados', () => {
    expect(hueOf('#ff0000')!).toBeCloseTo(0, 5);
    expect(hueOf('#00ff00')!).toBeCloseTo(120, 5);
    expect(hueOf('#0000ff')!).toBeCloseTo(240, 5);
  });

  it('devuelve null para grises y colores casi neutros', () => {
    expect(hueOf('#808080')).toBeNull();
    expect(hueOf('#ffffff')).toBeNull();
    expect(hueOf('#000000')).toBeNull();
    expect(hueOf('#7f8081')).toBeNull();
    expect(hueOf('sin-color')).toBeNull();
  });
});

describe('contrastText', () => {
  it('elige negro sobre fondos claros y blanco sobre oscuros', () => {
    expect(contrastText('#ffffff')).toBe('#000');
    expect(contrastText('#ffff00')).toBe('#000');
    expect(contrastText('#000000')).toBe('#fff');
    expect(contrastText('#1e1e1e')).toBe('#fff');
  });
});
