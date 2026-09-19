import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/core/store';
import { createGroupItem, createImageItem, createNoteItem, descendantsOf, paintOrder, subtreeBounds } from '../src/core/model';

describe('Store', () => {
  let s: Store;
  beforeEach(() => {
    s = new Store();
  });

  it('deshace y rehace un commit completo', () => {
    const a = createImageItem('b1', 100, 100, { x: 0, y: 0 });
    s.commit(() => s.addItem(a));
    expect(s.scene.items).toHaveLength(1);
    s.commit(() => s.update(a.id, (i) => (i.x = 50)));
    expect(s.get(a.id)!.x).toBe(50);
    s.undo();
    expect(s.get(a.id)!.x).toBe(0);
    s.undo();
    expect(s.scene.items).toHaveLength(0);
    s.redo();
    s.redo();
    expect(s.get(a.id)!.x).toBe(50);
  });

  it('agrupa transacciones anidadas en un solo paso', () => {
    const a = createImageItem('b1', 100, 100);
    s.commit(() => {
      s.addItem(a);
      s.commit(() => s.update(a.id, (i) => (i.x = 10)));
      s.commit(() => s.update(a.id, (i) => (i.y = 10)));
    });
    expect(s.canUndo).toBe(true);
    s.undo();
    expect(s.scene.items).toHaveLength(0);
    expect(s.canUndo).toBe(false);
  });

  it('cancelTransaction restaura el estado previo', () => {
    const a = createImageItem('b1', 100, 100, { x: 5 });
    s.commit(() => s.addItem(a));
    s.beginTransaction();
    s.update(a.id, (i) => (i.x = 999));
    s.cancelTransaction();
    expect(s.get(a.id)!.x).toBe(5);
    expect(s.canRedo).toBe(false);
  });

  it('eliminar un padre elimina sus descendientes y limpia la selección', () => {
    const img = createImageItem('b1', 100, 100);
    const note = createNoteItem('hola', { parentId: img.id });
    s.commit(() => {
      s.addItem(img);
      s.addItem(note);
    });
    s.select([note.id]);
    s.commit(() => s.removeItems([img.id]));
    expect(s.scene.items).toHaveLength(0);
    expect(s.selection.size).toBe(0);
  });

  it('setParent evita ciclos', () => {
    const g = createGroupItem();
    const img = createImageItem('b1', 100, 100, { parentId: g.id });
    s.commit(() => {
      s.addItem(g);
      s.addItem(img);
    });
    s.setParent([g.id], img.id);
    expect(s.get(g.id)!.parentId).toBeNull();
    expect(s.get(img.id)!.parentId).toBe(g.id);
  });

  it('selectedRoots excluye ítems cuyo ancestro está seleccionado', () => {
    const g = createGroupItem();
    const img = createImageItem('b1', 100, 100, { parentId: g.id });
    const other = createImageItem('b2', 100, 100);
    s.commit(() => {
      s.addItem(g);
      s.addItem(img);
      s.addItem(other);
    });
    s.select([g.id, img.id, other.id]);
    expect(s.selectedRoots().map((i) => i.id).sort()).toEqual([g.id, other.id].sort());
  });

  it('bringToFront cambia el orden de pintado dentro del nivel', () => {
    const a = createImageItem('b1', 10, 10);
    const b = createImageItem('b2', 10, 10);
    s.commit(() => {
      s.addItem(a);
      s.addItem(b);
    });
    expect(paintOrder(s.scene).map((i) => i.id)).toEqual([a.id, b.id]);
    s.commit(() => s.bringToFront([a.id]));
    expect(paintOrder(s.scene).map((i) => i.id)).toEqual([b.id, a.id]);
  });

  it('subtreeBounds incluye a los hijos y descendantsOf es recursivo', () => {
    const g = createGroupItem();
    const img = createImageItem('b1', 100, 100, { x: 0, y: 0, parentId: g.id });
    const note = createNoteItem('n', { x: 300, y: 0, w: 100, h: 50, parentId: img.id });
    s.commit(() => {
      s.addItem(g);
      s.addItem(img);
      s.addItem(note);
    });
    expect(descendantsOf(s.scene, g.id).map((i) => i.id).sort()).toEqual([img.id, note.id].sort());
    const b = subtreeBounds(s.scene, g.id)!;
    expect(b.x).toBe(-50);
    expect(b.x + b.w).toBe(350);
  });
});
