/**
 * Pruebas de la caja del texto de una nota (src/features/noteText.ts): una
 * nota transparente —y todo ornamento lo es— se toca donde están las letras,
 * no en todo su rectángulo. Los números tienen que calzar con los que usa
 * `drawNote` al pintar.
 */
import { describe, expect, it } from 'vitest';
import { noteTextBox, type NoteLine } from '../src/features/noteText';

const linea = (width: number, bullet = false): NoteLine => ({ width, bullet });

/** Una nota como las que crea el diálogo de ornamentos: un símbolo suelto. */
const ornamento = { w: 120, h: 156, fontSize: 60, align: 'center' as const, lines: [linea(58)] };

describe('noteTextBox', () => {
  it('un símbolo centrado reclama su ancho, no el de la caja', () => {
    const b = noteTextBox(ornamento)!;
    expect(b.w).toBeCloseTo(58, 6);
    // centrado dentro del relleno: la caja mide 120 y el glifo 58
    expect(b.x + b.w / 2).toBeCloseTo(0, 6);
    // y deja fuera las esquinas, que es donde se perdía el toque
    expect(b.x).toBeGreaterThan(-60);
    expect(b.x + b.w).toBeLessThan(60);
  });

  it('el alto va de la primera línea a la última, no de borde a borde', () => {
    const b = noteTextBox(ornamento)!;
    expect(b.y).toBeCloseTo(-156 / 2 + 36, 6); // borde superior + relleno
    expect(b.h).toBeCloseTo(60 * 1.3, 6); // una línea: el alto de la letra
    expect(b.h).toBeLessThan(156);
  });

  it('el área muerta que se recupera es la mayor parte de la caja', () => {
    const b = noteTextBox(ornamento)!;
    const proporcion = (b.w * b.h) / (ornamento.w * ornamento.h);
    expect(proporcion).toBeLessThan(0.4); // antes era 1: toda la caja
  });

  it('alineada a la izquierda empieza en el relleno', () => {
    const b = noteTextBox({ w: 200, h: 100, fontSize: 20, align: 'left', lines: [linea(50)] })!;
    expect(b.x).toBeCloseTo(-100 + 12, 6);
    expect(b.w).toBeCloseTo(50, 6);
  });

  it('alineada a la derecha termina en el relleno', () => {
    const b = noteTextBox({ w: 200, h: 100, fontSize: 20, align: 'right', lines: [linea(50)] })!;
    expect(b.x + b.w).toBeCloseTo(100 - 12, 6);
  });

  it('justificada se comporta como la izquierda', () => {
    const izq = noteTextBox({ w: 200, h: 100, fontSize: 20, align: 'left', lines: [linea(50)] })!;
    const jus = noteTextBox({ w: 200, h: 100, fontSize: 20, align: 'justify', lines: [linea(50)] })!;
    expect(jus).toEqual(izq);
  });

  it('con varias líneas toma la más ancha y crece hacia abajo', () => {
    const b = noteTextBox({ w: 300, h: 200, fontSize: 20, align: 'left', lines: [linea(40), linea(180), linea(90)] })!;
    expect(b.w).toBeCloseTo(180, 6);
    // tres líneas: dos saltos de 1,35 más el alto de la letra
    expect(b.h).toBeCloseTo(20 * (1 + 0.3) + 2 * 20 * 1.35, 6);
  });

  it('una viñeta suma su punto por la izquierda', () => {
    const conVineta = noteTextBox({ w: 300, h: 200, fontSize: 20, align: 'left', lines: [linea(100, true)] })!;
    const sinVineta = noteTextBox({ w: 300, h: 200, fontSize: 20, align: 'left', lines: [linea(100)] })!;
    // el punto se pinta en la sangría, a la izquierda del texto
    expect(conVineta.x).toBeLessThan(sinVineta.x + 20 * 1.2);
    expect(conVineta.x).toBeCloseTo(-150 + 12 + 20 * (0.45 - 0.14), 6);
  });

  it('una nota sin texto sigue siendo tocable, para poder editarla', () => {
    const b = noteTextBox({ w: 200, h: 100, fontSize: 20, align: 'center', lines: [linea(0)] })!;
    expect(b.w).toBeGreaterThan(0);
    expect(b.h).toBeGreaterThan(0);
  });

  it('sin líneas o sin tamaño de letra no hay caja que medir', () => {
    expect(noteTextBox({ w: 200, h: 100, fontSize: 20, align: 'left', lines: [] })).toBeNull();
    expect(noteTextBox({ w: 200, h: 100, fontSize: 0, align: 'left', lines: [linea(10)] })).toBeNull();
  });

  it('la caja del texto nunca se sale de la caja de la nota', () => {
    for (const align of ['left', 'center', 'right', 'justify'] as const) {
      const b = noteTextBox({ w: 200, h: 120, fontSize: 24, align, lines: [linea(150), linea(20, true)] })!;
      expect(b.x).toBeGreaterThanOrEqual(-100);
      expect(b.x + b.w).toBeLessThanOrEqual(100);
      expect(b.y).toBeGreaterThanOrEqual(-60);
    }
  });
});
