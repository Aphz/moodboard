/**
 * Pruebas de la regla de selección con grupos (src/features/selection.ts):
 * tocar una imagen dentro de un grupo la selecciona a ella, y volver a tocarla
 * sube al grupo. Es lo que permite mover una sola imagen de categoría.
 */
import { describe, expect, it } from 'vitest';
import { createGroupItem, createImageItem, createNoteItem, type Item, type ItemId } from '../src/core/model';
import { acceptsDrop, ancestorChain, dropTarget, remainingBounds, selectionCycle } from '../src/features/selection';

/** Escena de prueba: un grupo «Poses» dentro de un grupo «Tablero». */
const tablero = createGroupItem({ id: 'g_tablero', name: 'Tablero' });
const poses = createGroupItem({ id: 'g_poses', name: 'Poses', parentId: 'g_tablero' });
const foto = createImageItem('b1', 200, 300, { id: 'im_foto', name: 'foto', parentId: 'g_poses' });
const suelta = createImageItem('b2', 200, 300, { id: 'im_suelta', name: 'suelta' });
const nota = createNoteItem('hola', { id: 'n_1', parentId: 'im_foto' });

const items: Item[] = [tablero, poses, foto, suelta, nota];
const byId = new Map(items.map((i) => [i.id, i]));
const get = (id: ItemId) => byId.get(id);

const chainOf = (it: Item) => ancestorChain(it, get);

describe('ancestorChain', () => {
  it('va del ítem hacia la raíz', () => {
    expect(chainOf(foto).map((i) => i.id)).toEqual(['im_foto', 'g_poses', 'g_tablero']);
    expect(chainOf(suelta).map((i) => i.id)).toEqual(['im_suelta']);
    expect(chainOf(nota).map((i) => i.id)).toEqual(['n_1', 'im_foto', 'g_poses', 'g_tablero']);
  });

  it('no se cuelga si un archivo trae un ciclo', () => {
    const a = createGroupItem({ id: 'a', parentId: 'b' });
    const b = createGroupItem({ id: 'b', parentId: 'a' });
    const local = new Map([
      ['a', a as Item],
      ['b', b as Item]
    ]);
    expect(ancestorChain(a, (id) => local.get(id)).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('corta si falta el padre', () => {
    const huerfano = createImageItem('b3', 10, 10, { id: 'im_x', parentId: 'no_existe' });
    expect(chainOf(huerfano).map((i) => i.id)).toEqual(['im_x']);
  });
});

describe('selectionCycle', () => {
  /** Simula toques repetidos en el mismo sitio sobre la misma hoja. */
  function toques(it: Item, n: number): (string | undefined)[] {
    const chain = chainOf(it);
    const out: (string | undefined)[] = [];
    let last: ItemId | null = null;
    for (let i = 0; i < n; i++) {
      const picked = selectionCycle(chain, last);
      out.push(picked?.id);
      last = picked?.id ?? null;
    }
    return out;
  }

  it('el primer toque selecciona la imagen, no el grupo', () => {
    expect(selectionCycle(chainOf(foto), null)?.id).toBe('im_foto');
  });

  it('repetir el toque sube por la rama y vuelve a la hoja', () => {
    // imagen → su categoría → el grupo de más afuera → imagen otra vez
    expect(toques(foto, 4)).toEqual(['im_foto', 'g_poses', 'g_tablero', 'im_foto']);
  });

  it('una imagen sin grupo se selecciona ella misma siempre', () => {
    expect(toques(suelta, 3)).toEqual(['im_suelta', 'im_suelta', 'im_suelta']);
  });

  it('un toque en otra rama empieza de nuevo por la hoja', () => {
    expect(selectionCycle(chainOf(foto), 'im_suelta')?.id).toBe('im_foto');
  });

  it('una nota colgada de una imagen sube al grupo, no a la imagen', () => {
    expect(toques(nota, 3)).toEqual(['n_1', 'g_poses', 'g_tablero']);
  });

  it('sin cadena no hay nada que seleccionar', () => {
    expect(selectionCycle([], null)).toBeNull();
  });
});

describe('acceptsDrop', () => {
  it('a un grupo entra lo que no esté ya dentro', () => {
    expect(acceptsDrop(poses, suelta)).toBe(true);
    expect(acceptsDrop(poses, foto)).toBe(false); // ya es hija de «Poses»
    expect(acceptsDrop(poses, poses)).toBe(false);
  });

  it('sobre una imagen sólo se cuelgan notas y dibujos', () => {
    expect(acceptsDrop(suelta, nota)).toBe(true);
    expect(acceptsDrop(suelta, foto)).toBe(false); // imagen sobre imagen, no
    expect(acceptsDrop(suelta, poses)).toBe(false);
  });
});

describe('dropTarget', () => {
  it('soltar sobre una imagen de un grupo mete en ese grupo, no en el de más afuera', () => {
    expect(dropTarget(chainOf(foto), new Set())?.id).toBe('g_poses');
  });

  it('una imagen sin grupo sirve de percha para notas y dibujos', () => {
    expect(dropTarget(chainOf(suelta), new Set())?.id).toBe('im_suelta');
  });

  it('nada que cuelgue de lo que se mueve sirve de destino', () => {
    // arrastrando «Poses» completo, ni él ni lo que hay dentro son destino
    expect(dropTarget(chainOf(foto), new Set(['g_poses']))).toBeNull();
    expect(dropTarget(chainOf(foto), new Set(['im_foto']))).toBeNull();
    expect(dropTarget(chainOf(suelta), new Set(['im_suelta']))).toBeNull();
  });

  it('sin cadena no hay destino', () => {
    expect(dropTarget([], new Set())).toBeNull();
  });
});

describe('remainingBounds', () => {
  const uno = createImageItem('b', 100, 100, { id: 'x1', x: 0, y: 0, parentId: 'g' });
  const dos = createImageItem('b', 100, 100, { id: 'x2', x: 300, y: 0, parentId: 'g' });
  const grupito = createGroupItem({ id: 'sub', parentId: 'g' });
  const oculta = createImageItem('b', 100, 100, { id: 'x3', x: 900, y: 0, parentId: 'g', visible: false });

  it('mide sólo lo que se queda', () => {
    const b = remainingBounds([uno, dos, grupito, oculta], new Set(['x1']))!;
    expect(b).toEqual({ x: 250, y: -50, w: 100, h: 100 });
  });

  it('descarta grupos e invisibles', () => {
    const b = remainingBounds([uno, grupito, oculta], new Set())!;
    expect(b).toEqual({ x: -50, y: -50, w: 100, h: 100 });
  });

  it('sin nada que quede devuelve null: el grupo se quedaría vacío', () => {
    expect(remainingBounds([uno, dos], new Set(['x1', 'x2']))).toBeNull();
    expect(remainingBounds([], new Set())).toBeNull();
  });
});
