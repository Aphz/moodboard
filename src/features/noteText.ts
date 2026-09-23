/**
 * Dónde cae de verdad el texto dentro de la caja de una nota.
 *
 * Una nota con fondo tiene cuerpo: su caja es lo que se ve y tocarla en
 * cualquier punto es tocarla. Una nota **transparente** no: se ve sólo el
 * texto, pero su caja incluye el relleno y todo lo que sobra a los lados de
 * las líneas cortas. Como las notas se pintan por encima de las imágenes, esa
 * parte vacía se llevaba los toques de lo que hubiera debajo. Pasa en toda
 * nota transparente y, sobre todo, en los ornamentos: la caja de un símbolo es
 * bastante más grande que el símbolo.
 *
 * Aquí se arma la caja del bloque de texto a partir de las líneas ya medidas
 * por el renderizador. Módulo PURO: coordenadas locales del ítem, con el
 * centro de la caja en (0,0), igual que `sceneToLocal`.
 */
import type { NoteAlign, Rect } from '../core/model';

/** Una línea ya maquetada: su ancho incluye la sangría de la viñeta. */
export interface NoteLine {
  width: number;
  bullet: boolean;
}

export interface NoteTextOptions {
  /** Caja de la nota, en unidades locales. */
  w: number;
  h: number;
  fontSize: number;
  align: NoteAlign;
  lines: NoteLine[];
}

/**
 * Los mismos números que usa `drawNote` al pintar. Si allá cambian, aquí
 * también: la zona sensible tiene que calzar con lo que se ve.
 */
const PAD = 0.6; // relleno, en múltiplos del tamaño de letra
const LINE_HEIGHT = 1.35;
const INDENT = 1.2; // sangría de una línea con viñeta
const BULLET_X = 0.45; // centro del punto de la viñeta, desde el borde del relleno
const BULLET_R = 0.14;
const DESCENT = 0.3; // cuánto baja la letra por debajo de su línea base

/**
 * Caja que ocupan las letras de una nota, en coordenadas locales.
 *
 * Es la unión de lo que se pinta línea a línea: cada una empieza donde la
 * deja la alineación y mide lo suyo, así que un título centrado de una
 * palabra no reclama el ancho completo de la nota. Devuelve `null` si no hay
 * nada escrito.
 */
export function noteTextBox(o: NoteTextOptions): Rect | null {
  if (!o.lines.length || o.fontSize <= 0) return null;
  const pad = o.fontSize * PAD;
  const lh = o.fontSize * LINE_HEIGHT;
  const left = -o.w / 2 + pad;

  let x0 = Infinity;
  let x1 = -Infinity;
  for (const line of o.lines) {
    const indent = line.bullet ? o.fontSize * INDENT : 0;
    const avail = o.w - pad * 2 - indent;
    const lw = Math.max(0, line.width - indent);
    let x = left + indent;
    if (o.align === 'center') x += (avail - lw) / 2;
    else if (o.align === 'right') x += avail - lw;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x + lw);
    // el punto de la viñeta se pinta a la izquierda del texto, en la sangría
    if (line.bullet) x0 = Math.min(x0, left + o.fontSize * (BULLET_X - BULLET_R));
  }
  if (!Number.isFinite(x0) || x1 <= x0) {
    // líneas vacías (una nota con sólo saltos de línea): queda la columna del
    // relleno, suficiente para poder tocarla y editarla
    x0 = left;
    x1 = left + o.fontSize;
  }

  // vertical: de la primera línea a la última, contando lo que baja la letra
  const primeraBase = -o.h / 2 + pad + o.fontSize;
  const y0 = primeraBase - o.fontSize;
  const y1 = primeraBase + (o.lines.length - 1) * lh + o.fontSize * DESCENT;

  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
