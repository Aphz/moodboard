/**
 * Pruebas de la máscara de opacidad (src/features/alphaMask.ts): una imagen
 * con transparencia —un sujeto recortado con la función de stickers de iOS y
 * pegado aquí— se toca donde hay figura, no en todo su rectángulo.
 */
import { describe, expect, it } from 'vitest';
import { ALPHA_MIN, localToUV, makeMask, maskHit, sampleMask } from '../src/features/alphaMask';

/** Rejilla de `size²` celdas; `fn` decide el alfa de cada una. */
function grid(size: number, fn: (x: number, y: number) => number) {
  const cells = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) cells[y * size + x] = fn(x, y);
  return makeMask(cells, size);
}

/** Un sticker: un disco opaco al centro y el resto recortado. */
const sticker = grid(48, (x, y) => (Math.hypot(x - 23.5, y - 23.5) < 12 ? 255 : 0));
/** Una foto normal: sin una sola celda transparente. */
const foto = grid(48, () => 255);

describe('makeMask', () => {
  it('reconoce una imagen sin transparencia', () => {
    expect(foto.opaque).toBe(true);
    expect(sticker.opaque).toBe(false);
  });

  it('un solo pixel translúcido ya la hace no opaca', () => {
    expect(grid(4, (x, y) => (x === 0 && y === 0 ? 254 : 255)).opaque).toBe(false);
  });
});

describe('sampleMask', () => {
  it('lee la celda que toca', () => {
    expect(sampleMask(sticker, 0.5, 0.5)).toBe(255); // centro: figura
    expect(sampleMask(sticker, 0.02, 0.02)).toBe(0); // esquina: recortada
  });

  it('fuera de la imagen no hay nada', () => {
    for (const [u, v] of [[-0.1, 0.5], [1.1, 0.5], [0.5, -0.1], [0.5, 1.1]]) {
      expect(sampleMask(sticker, u!, v!)).toBe(0);
    }
  });
});

describe('maskHit', () => {
  it('una foto normal se toca en todo su rectángulo', () => {
    expect(maskHit(foto, 0.01, 0.01)).toBe(true);
    expect(maskHit(foto, 0.99, 0.99)).toBe(true);
    expect(maskHit(foto, 1.5, 0.5)).toBe(false); // fuera sigue siendo fuera
  });

  it('en un recorte, la esquina vacía deja pasar el toque', () => {
    expect(maskHit(sticker, 0.5, 0.5)).toBe(true); // el sujeto
    expect(maskHit(sticker, 0.03, 0.03)).toBe(false); // el fondo recortado
  });

  it('la holgura alcanza el borde del sujeto sin llegar a la esquina', () => {
    // justo fuera del disco (radio 12 de 48 celdas ≈ 0,25)
    const justoFuera = 0.5 + 0.27;
    expect(maskHit(sticker, justoFuera, 0.5)).toBe(false);
    expect(maskHit(sticker, justoFuera, 0.5, 0.04, 0.04)).toBe(true);
    // la esquina queda lejos incluso con holgura
    expect(maskHit(sticker, 0.03, 0.03, 0.04, 0.04)).toBe(false);
  });

  it('el borde apenas visible del sujeto cuenta como figura', () => {
    const tenue = grid(8, (x) => (x === 4 ? ALPHA_MIN : 0));
    expect(maskHit(tenue, 4.5 / 8, 0.5)).toBe(true);
    const invisible = grid(8, (x) => (x === 4 ? ALPHA_MIN - 1 : 0));
    expect(maskHit(invisible, 4.5 / 8, 0.5)).toBe(false);
  });
});

describe('localToUV', () => {
  const p = (x: number, y: number) => ({ x, y });

  it('sin recorte, el centro del ítem es el centro de la imagen', () => {
    expect(localToUV(p(0, 0), 200, 100)).toEqual({ u: 0.5, v: 0.5 });
    expect(localToUV(p(-100, -50), 200, 100)).toEqual({ u: 0, v: 0 });
    expect(localToUV(p(100, 50), 200, 100)).toEqual({ u: 1, v: 1 });
  });

  it('con recorte, devuelve la fracción de la imagen ORIGINAL', () => {
    // recortada la mitad izquierda: lo visible mide 100 y empieza en u = 0,5
    const crop = { left: 0.5, top: 0, right: 0, bottom: 0 };
    const uv = localToUV(p(-50, 0), 100, 100, crop);
    expect(uv.u).toBeCloseTo(0.5, 6);
    expect(localToUV(p(50, 0), 100, 100, crop).u).toBeCloseTo(1, 6);
    expect(localToUV(p(0, 0), 100, 100, crop).u).toBeCloseTo(0.75, 6);
  });

  it('un ítem sin tamaño no apunta a ninguna parte', () => {
    expect(localToUV(p(0, 0), 0, 100).u).toBe(-1);
  });

  it('el recorte y la máscara juntos: se toca el sujeto que quedó a la vista', () => {
    // sujeto en la mitad derecha de la imagen, y se recorta la izquierda
    const m = grid(8, (x) => (x >= 4 ? 255 : 0));
    const crop = { left: 0.5, top: 0, right: 0, bottom: 0 };
    // un cuarto a la izquierda del centro del ítem
    const dentro = localToUV({ x: -25, y: 0 }, 100, 100, crop);
    expect(dentro.u).toBeCloseTo(0.625, 6); // ya dentro del sujeto
    expect(maskHit(m, dentro.u, dentro.v)).toBe(true);
    // sin recorte, ese mismo punto local cae en la mitad vacía
    const sinRecorte = localToUV({ x: -25, y: 0 }, 100, 100);
    expect(sinRecorte.u).toBeCloseTo(0.25, 6);
    expect(maskHit(m, sinRecorte.u, sinRecorte.v)).toBe(false);
  });
});
