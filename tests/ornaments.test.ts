/**
 * Pruebas de ornamentos, simbología y conectores
 * (src/features/ornaments.ts): el mood sale del texto del tablero, los signos
 * caen en los claros sin tapar ninguna imagen y las flechas van de borde a
 * borde en el sentido correcto.
 */
import { describe, expect, it } from 'vitest';
import { rectsIntersect, type Rect } from '../src/core/model';
import {
  DEFAULT_MOOD,
  MOODS,
  MOOD_SETS,
  centerPoints,
  chainConnectors,
  cleanSymbols,
  connectorBetween,
  defaultOrnamentSize,
  inkColor,
  isOrnamentText,
  moodFromText,
  ornamentBox,
  placeOrnaments,
  symbolsForMood
} from '../src/features/ornaments';

/** Caja real de un ornamento ya colocado (la misma que ocupará la nota). */
function boxOf(o: { text: string; x: number; y: number; size: number }): Rect {
  return ornamentBox(o.text, o.size, o.x, o.y);
}

/** Tablero de prueba: tres columnas de imágenes pegadas. */
const boxes: Rect[] = [
  { x: 0, y: 0, w: 200, h: 300 },
  { x: 210, y: 0, w: 200, h: 250 },
  { x: 420, y: 0, w: 200, h: 400 },
  { x: 0, y: 310, w: 200, h: 200 },
  { x: 210, y: 260, w: 200, h: 250 }
];

describe('moodFromText', () => {
  it('reconoce el mood por las pistas del tablero', () => {
    expect(moodFromText('flores boda pastel')).toBe('romantico');
    expect(moodFromText('concreto urbano cartel')).toBe('brutalista');
    expect(moodFromText('bosque playa paisaje')).toBe('natural');
  });

  it('no distingue tildes ni mayúsculas', () => {
    expect(moodFromText('TÉCNICO, ingeniería')).toBe('tecnico');
  });

  it('sin pistas devuelve el mood por defecto', () => {
    expect(moodFromText('')).toBe(DEFAULT_MOOD);
    expect(moodFromText('xyz 123')).toBe(DEFAULT_MOOD);
  });

  it('todos los moods tienen repertorio y pistas', () => {
    for (const m of MOODS) {
      expect(MOOD_SETS[m].symbols.length).toBeGreaterThanOrEqual(5);
      expect(MOOD_SETS[m].hints.length).toBeGreaterThanOrEqual(5);
      expect(symbolsForMood(m).length).toBeGreaterThan(MOOD_SETS[m].symbols.length - 1);
    }
  });
});

describe('cleanSymbols', () => {
  it('acepta glifos y marcas cortas, y descarta el resto', () => {
    expect(cleanSymbols(['✳', ' → ', 'REF', 'una frase demasiado larga', 42, ''])).toEqual(['✳', '→', 'REF']);
  });

  it('descarta emoji: en el lienzo salen como cajas de color', () => {
    expect(isOrnamentText('🌸')).toBe(false);
    expect(isOrnamentText('✳')).toBe(true);
    expect(cleanSymbols(['🌸', '★'])).toEqual(['★']);
  });

  it('no repite signos y respeta el tope', () => {
    expect(cleanSymbols(['★', '★', '☆'], 2)).toEqual(['★', '☆']);
  });
});

describe('placeOrnaments', () => {
  const symbols = ['✳', '→', '★'];

  it('no tapa ninguna imagen', () => {
    const out = placeOrnaments(boxes, symbols, { count: 8, seed: 7 });
    expect(out.length).toBeGreaterThan(0);
    for (const o of out) {
      for (const b of boxes) expect(rectsIntersect(boxOf(o), b)).toBe(false);
    }
  });

  it('no amontona los signos entre ellos', () => {
    const out = placeOrnaments(boxes, symbols, { count: 8, seed: 7 });
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) expect(rectsIntersect(boxOf(out[i]!), boxOf(out[j]!))).toBe(false);
    }
  });

  it('usa todos los signos elegidos y respeta la cantidad pedida', () => {
    const out = placeOrnaments(boxes, symbols, { count: 3, seed: 3 });
    expect(out).toHaveLength(3);
    expect(new Set(out.map((o) => o.text))).toEqual(new Set(symbols));
  });

  it('es reproducible con la misma semilla y cambia con otra', () => {
    const a = placeOrnaments(boxes, symbols, { count: 6, seed: 11 });
    const b = placeOrnaments(boxes, symbols, { count: 6, seed: 11 });
    const c = placeOrnaments(boxes, symbols, { count: 6, seed: 12 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('sin signos, sin cajas o sin cupo no coloca nada', () => {
    expect(placeOrnaments(boxes, [], { count: 5 })).toEqual([]);
    expect(placeOrnaments([], ['★'], { count: 5 })).toEqual([]);
    expect(placeOrnaments(boxes, ['★'], { count: 0 })).toEqual([]);
  });

  it('el tamaño por defecto no compite con las imágenes', () => {
    const size = defaultOrnamentSize(boxes);
    expect(size).toBeCloseTo(40, 6); // 200 / 5
    // la caja reservada es la de la nota: ancho del texto más su relleno
    expect(ornamentBox('★', 40)).toEqual({ x: -40, y: -52, w: 80, h: 104 });
    const out = placeOrnaments(boxes, ['★'], { count: 4, seed: 1 });
    for (const o of out) expect(o.size).toBeLessThan(200);
  });
});

describe('connectorBetween', () => {
  const a: Rect = { x: 0, y: 0, w: 100, h: 100 };
  const b: Rect = { x: 300, y: 0, w: 100, h: 100 };

  it('va de borde a borde, no de centro a centro', () => {
    const c = connectorBetween(a, b)!;
    expect(c.from.x).toBeCloseTo(100, 6);
    expect(c.to.x).toBeCloseTo(300, 6);
    expect(c.from.y).toBeCloseTo(50, 6);
    expect(c.to.y).toBeCloseTo(50, 6);
  });

  it('el hueco separa la flecha de las dos cajas', () => {
    const c = connectorBetween(a, b, 10)!;
    expect(c.from.x).toBeCloseTo(110, 6);
    expect(c.to.x).toBeCloseTo(290, 6);
  });

  it('devuelve null si las cajas se tocan, se solapan o coinciden', () => {
    expect(connectorBetween(a, { x: 90, y: 0, w: 100, h: 100 })).toBeNull();
    expect(connectorBetween(a, a)).toBeNull();
    expect(connectorBetween(a, b, 200)).toBeNull();
  });

  it('si no cabe el hueco, la flecha se dibuja igual de borde a borde', () => {
    const cerca: Rect = { x: 130, y: 0, w: 100, h: 100 };
    // con hueco de 40 no hay sitio (sólo 30 libres), pero la cadena no se rinde
    expect(connectorBetween(a, cerca, 40)).toBeNull();
    const [c] = chainConnectors([a, cerca], 40);
    expect(c!.from.x).toBeCloseTo(100, 6);
    expect(c!.to.x).toBeCloseTo(130, 6);
  });

  it('encadena los pares consecutivos y salta los imposibles', () => {
    const c = { x: 600, y: 0, w: 100, h: 100 };
    expect(chainConnectors([a, b, c])).toHaveLength(2);
    expect(chainConnectors([a, a, b])).toHaveLength(1);
    expect(chainConnectors([a])).toEqual([]);
  });
});

describe('centerPoints', () => {
  it('centra los puntos y devuelve la caja del dibujo', () => {
    const r = centerPoints([
      { x: 100, y: 50 },
      { x: 300, y: 150 }
    ]);
    expect(r).toEqual({
      x: 200,
      y: 100,
      w: 200,
      h: 100,
      points: [
        { x: -100, y: -50 },
        { x: 100, y: 50 }
      ]
    });
  });

  it('sin puntos devuelve una caja mínima', () => {
    expect(centerPoints([])).toEqual({ x: 0, y: 0, w: 1, h: 1, points: [] });
  });
});

describe('inkColor', () => {
  it('escribe claro sobre fondo oscuro y oscuro sobre fondo claro', () => {
    expect(inkColor('#1e1e1e')).toBe('#f2f2f2');
    expect(inkColor('#ffffff')).toBe('#1a1a1a');
    expect(inkColor('transparent')).toBe('#f2f2f2');
  });
});
