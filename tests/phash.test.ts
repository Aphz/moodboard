/**
 * Pruebas del hash perceptual (dHash). Se generan imágenes sintéticas en RGBA
 * y se comparan sus hashes; no se usa canvas, así que corren en jsdom.
 */
import { describe, it, expect } from 'vitest';
import {
  dhash,
  dhashFromGray,
  grayscaleResize,
  hamming,
  similarity,
  findSimilar,
  findDuplicateGroups
} from '../src/features/phash';

const W = 64;
const H = 64;

/** Generador pseudoaleatorio determinista (para que los tests no oscilen). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Imagen RGBA a partir de una función de luminancia. */
function makeImage(w: number, h: number, f: (x: number, y: number) => number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = f(x, y);
      const o = (y * w + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return data;
}

/** Gradiente horizontal de negro a blanco. */
const gradient = makeImage(W, H, (x) => (x / (W - 1)) * 255);

/** Copia con ruido de ±5 por canal. */
function noisy(src: Uint8ClampedArray, seed = 7, amp = 5): Uint8ClampedArray {
  const rng = makeRng(seed);
  const out = new Uint8ClampedArray(src);
  for (let i = 0; i < out.length; i += 4) {
    const d = Math.round((rng() * 2 - 1) * amp);
    out[i] = Math.min(255, Math.max(0, out[i]! + d));
    out[i + 1] = out[i]!;
    out[i + 2] = out[i]!;
  }
  return out;
}

/** Copia invertida (negativo). */
function inverted(src: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = 255 - out[i]!;
    out[i + 1] = 255 - out[i + 1]!;
    out[i + 2] = 255 - out[i + 2]!;
  }
  return out;
}

describe('grayscaleResize', () => {
  it('promedia por área y conserva un color plano', () => {
    const flat = makeImage(16, 16, () => 200);
    const g = grayscaleResize(flat, 16, 16, 9, 8);
    expect(g).toHaveLength(72);
    for (const v of g) expect(v).toBeCloseTo(200, 3);
  });

  it('mantiene el sentido de un gradiente horizontal', () => {
    const g = grayscaleResize(gradient, W, H, 9, 8);
    for (let x = 0; x < 8; x++) expect(g[x]!).toBeLessThan(g[x + 1]!);
    // todas las filas son iguales en un gradiente horizontal
    for (let y = 1; y < 8; y++) expect(g[y * 9]!).toBeCloseTo(g[0]!, 3);
  });

  it('rechaza dimensiones o buffers inválidos', () => {
    expect(() => grayscaleResize(gradient, 0, H, 9, 8)).toThrow();
    expect(() => grayscaleResize(new Uint8ClampedArray(16), 64, 64, 9, 8)).toThrow();
  });
});

describe('dhash', () => {
  it('produce 16 caracteres hexadecimales', () => {
    const h = dhash(gradient, W, H);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('es determinista para la misma imagen', () => {
    expect(dhash(gradient, W, H)).toBe(dhash(gradient, W, H));
    expect(dhash(new Uint8ClampedArray(gradient), W, H)).toBe(dhash(gradient, W, H));
  });

  it('un gradiente creciente no enciende ningún bit', () => {
    // cada píxel es más oscuro que su vecino derecho → todos los bits a 0
    expect(dhash(gradient, W, H)).toBe('0000000000000000');
  });

  it('dhashFromGray compara cada píxel con su vecino derecho', () => {
    const gray = [
      9, 1, 9, 1, 9, 1, 9, 1, 9,
      9, 1, 9, 1, 9, 1, 9, 1, 9,
      9, 1, 9, 1, 9, 1, 9, 1, 9,
      9, 1, 9, 1, 9, 1, 9, 1, 9,
      9, 1, 9, 1, 9, 1, 9, 1, 9,
      9, 1, 9, 1, 9, 1, 9, 1, 9,
      9, 1, 9, 1, 9, 1, 9, 1, 9,
      9, 1, 9, 1, 9, 1, 9, 1, 9
    ];
    // patrón por fila: 1 0 1 0 1 0 1 0 → 0xaa
    expect(dhashFromGray(gray, 9, 8)).toBe('aaaaaaaaaaaaaaaa');
  });
});

describe('hamming y similarity', () => {
  it('la distancia de un hash consigo mismo es 0', () => {
    const h = dhash(gradient, W, H);
    expect(hamming(h, h)).toBe(0);
    expect(similarity(h, h)).toBe(1);
  });

  it('cuenta los bits distintos', () => {
    expect(hamming('0000000000000000', '0000000000000001')).toBe(1);
    expect(hamming('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(similarity('0000000000000000', 'ffffffffffffffff')).toBe(0);
  });

  it('exige hashes de la misma longitud', () => {
    expect(() => hamming('00', '0000')).toThrow();
  });

  it('una copia con ruido de ±5 sigue siendo muy parecida', () => {
    const a = dhash(gradient, W, H);
    const b = dhash(noisy(gradient), W, H);
    expect(similarity(a, b)).toBeGreaterThan(0.9);
  });

  it('una imagen y su negativo tienen similitud baja', () => {
    const a = dhash(gradient, W, H);
    const b = dhash(inverted(gradient), W, H);
    expect(similarity(a, b)).toBeLessThan(0.4);
  });

  it('distingue imágenes con estructura diferente', () => {
    const rng = makeRng(99);
    const ruido = makeImage(W, H, () => rng() * 255);
    const a = dhash(gradient, W, H);
    const b = dhash(ruido, W, H);
    expect(similarity(a, b)).toBeLessThan(0.85);
  });
});

describe('findSimilar', () => {
  const base = 'ffffffffffffffff';
  const candidates = [
    { id: 'igual', hash: base },
    { id: 'casi', hash: 'fffffffffffffffe' }, // 1 bit
    { id: 'lejos', hash: '0000000000000000' }, // 64 bits
    { id: 'medio', hash: 'ffffffff00000000' } // 32 bits
  ];

  it('devuelve las coincidencias por encima del umbral, ordenadas', () => {
    const r = findSimilar(base, candidates, 0.85);
    expect(r.map((m) => m.id)).toEqual(['igual', 'casi']);
    expect(r[0]!.score).toBe(1);
    expect(r[1]!.score).toBeCloseTo(1 - 1 / 64, 6);
  });

  it('con umbral bajo incluye más candidatos', () => {
    expect(findSimilar(base, candidates, 0.4).map((m) => m.id)).toEqual(['igual', 'casi', 'medio']);
  });

  it('ignora candidatos con hashes de otra longitud', () => {
    expect(findSimilar(base, [{ id: 'raro', hash: 'ff' }], 0.5)).toEqual([]);
  });
});

describe('findDuplicateGroups', () => {
  it('agrupa las imágenes mutuamente parecidas', () => {
    const groups = findDuplicateGroups(
      [
        { id: 'a1', hash: 'ffffffffffffffff' },
        { id: 'a2', hash: 'fffffffffffffffe' }, // 1 bit de a1
        { id: 'a3', hash: 'fffffffffffffffc' }, // 2 bits de a1
        { id: 'b1', hash: '0000000000000000' },
        { id: 'b2', hash: '0000000000000001' }, // 1 bit de b1
        { id: 'c1', hash: '00000000ffff0000' } // solo
      ],
      0.92
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]!.slice().sort()).toEqual(['a1', 'a2', 'a3']);
    expect(groups[1]!.slice().sort()).toEqual(['b1', 'b2']);
  });

  it('devuelve lista vacía cuando no hay duplicados', () => {
    expect(
      findDuplicateGroups([
        { id: 'x', hash: 'ffffffffffffffff' },
        { id: 'y', hash: '0000000000000000' }
      ])
    ).toEqual([]);
  });

  it('agrupa hashes idénticos procedentes de píxeles distintos pero equivalentes', () => {
    const a = dhash(gradient, W, H);
    const b = dhash(noisy(gradient, 3, 2), W, H);
    const groups = findDuplicateGroups(
      [
        { id: 'orig', hash: a },
        { id: 'copia', hash: b }
      ],
      0.92
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.slice().sort()).toEqual(['copia', 'orig']);
  });
});
