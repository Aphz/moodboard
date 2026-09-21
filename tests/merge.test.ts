import { describe, it, expect } from 'vitest';
import { createNoteItem, createScene, type Item, type Scene } from '../src/core/model';
import { mergeScenes, sceneDigest, stableStringify, TOMBSTONE_TTL_MS } from '../src/sync/merge';

const NOW = 1_700_000_000_000;

/** Marca de tiempo "hace poco": los tests usan números pequeños y legibles. */
const at = (n: number) => NOW - 1_000_000 + n;

/** Escena de prueba con id fijo para que local y remoto sean "la misma". */
function scene(updatedAt: number, items: Item[] = [], tombstones: Record<string, number> = {}): Scene {
  const s = createScene('Tablero');
  s.id = 's_test';
  s.createdAt = 1;
  s.updatedAt = at(updatedAt);
  s.items = items;
  s.tombstones = Object.fromEntries(Object.entries(tombstones).map(([k, v]) => [k, at(v)]));
  return s;
}

function note(id: string, mtime: number, text = id): Item {
  const n = createNoteItem(text);
  n.id = id;
  n.mtime = at(mtime);
  n.createdAt = 1;
  return n;
}

describe('sceneDigest', () => {
  it('ignora el viewport y el orden de los ítems', () => {
    const a = scene(10, [note('a', 1), note('b', 2)]);
    const b = scene(99, [note('b', 2), note('a', 1)]);
    b.viewport = { x: 500, y: -200, zoom: 3 };
    expect(sceneDigest(a)).toBe(sceneDigest(b));
  });

  it('cambia cuando cambia el contenido', () => {
    const a = scene(10, [note('a', 1, 'hola')]);
    const b = scene(10, [note('a', 2, 'chao')]);
    expect(sceneDigest(a)).not.toBe(sceneDigest(b));
  });

  it('stableStringify ordena las claves', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe('mergeScenes', () => {
  it('por ítem gana el de mtime mayor (LWW)', () => {
    const local = scene(100, [note('a', 100, 'local')]);
    const remote = scene(200, [note('a', 200, 'remoto')]);
    const { scene: m, localChanged, remoteChanged } = mergeScenes(local, remote, NOW);
    expect(m.items).toHaveLength(1);
    expect((m.items[0] as { text: string }).text).toBe('remoto');
    expect(localChanged).toBe(true);
    expect(remoteChanged).toBe(false);
  });

  it('gana el local cuando es más nuevo', () => {
    const local = scene(300, [note('a', 300, 'local')]);
    const remote = scene(200, [note('a', 200, 'remoto')]);
    const { scene: m, localChanged, remoteChanged } = mergeScenes(local, remote, NOW);
    expect((m.items[0] as { text: string }).text).toBe('local');
    expect(localChanged).toBe(false);
    expect(remoteChanged).toBe(true);
  });

  it('un borrado local se propaga al remoto', () => {
    const local = scene(300, [], { a: 250 });
    const remote = scene(200, [note('a', 100)]);
    const { scene: m, remoteChanged } = mergeScenes(local, remote, NOW);
    expect(m.items).toHaveLength(0);
    expect(m.tombstones).toEqual({ a: at(250) });
    expect(remoteChanged).toBe(true);
  });

  it('un borrado remoto no resucita el ítem local', () => {
    const local = scene(200, [note('a', 100)]);
    const remote = scene(300, [], { a: 250 });
    const { scene: m, localChanged } = mergeScenes(local, remote, NOW);
    expect(m.items).toHaveLength(0);
    expect(m.tombstones!.a).toBe(at(250));
    expect(localChanged).toBe(true);
  });

  it('un ítem recreado después del borrado sí sobrevive', () => {
    const local = scene(400, [note('a', 400, 'recreado')]);
    const remote = scene(300, [], { a: 250 });
    const { scene: m } = mergeScenes(local, remote, NOW);
    expect(m.items).toHaveLength(1);
    expect(m.tombstones).toEqual({});
  });

  it('conserva los ítems nuevos de cada lado', () => {
    const local = scene(100, [note('a', 100), note('soloLocal', 110)]);
    const remote = scene(120, [note('a', 100), note('soloRemoto', 120)]);
    const { scene: m, localChanged, remoteChanged } = mergeScenes(local, remote, NOW);
    expect(m.items.map((i) => i.id).sort()).toEqual(['a', 'soloLocal', 'soloRemoto']);
    expect(localChanged).toBe(true);
    expect(remoteChanged).toBe(true);
  });

  it('toma name y settings del lado con updatedAt mayor y el viewport del local', () => {
    const local = scene(100);
    local.name = 'Local';
    local.settings.canvasColor = '#111111';
    local.viewport = { x: 42, y: 7, zoom: 2 };
    const remote = scene(900);
    remote.name = 'Remoto';
    remote.settings.canvasColor = '#999999';
    remote.viewport = { x: -1, y: -1, zoom: 0.1 };
    const { scene: m } = mergeScenes(local, remote, NOW);
    expect(m.name).toBe('Remoto');
    expect(m.settings.canvasColor).toBe('#999999');
    expect(m.viewport).toEqual({ x: 42, y: 7, zoom: 2 });
    expect(m.updatedAt).toBe(at(900));
  });

  it('es idempotente: merge(merge(a,b), b) === merge(a,b)', () => {
    const local = scene(300, [note('a', 300, 'local'), note('x', 120)], { z: 10 });
    const remote = scene(400, [note('a', 200, 'remoto'), note('y', 400)], { x: 350 });
    const once = mergeScenes(local, remote, NOW).scene;
    const twice = mergeScenes(once, remote, NOW);
    expect(stableStringify(twice.scene)).toBe(stableStringify(once));
    expect(twice.localChanged).toBe(false);
  });

  it('poda las lápidas de más de 30 días y conserva las recientes', () => {
    const vieja = NOW - TOMBSTONE_TTL_MS - 1;
    const reciente = NOW - 1000;
    const local = scene(100, []);
    local.tombstones = { vieja, reciente };
    const remote = scene(100, []);
    const { scene: m } = mergeScenes(local, remote, NOW);
    expect(m.tombstones).toEqual({ reciente });
  });

  it('no muta las escenas de entrada', () => {
    const local = scene(100, [note('a', 100)], { z: 50 });
    const remote = scene(200, [note('b', 200)], { c: 150 });
    const antesL = stableStringify(local);
    const antesR = stableStringify(remote);
    const { scene: m } = mergeScenes(local, remote, NOW);
    m.items[0].x = 999;
    m.name = 'otro';
    expect(stableStringify(local)).toBe(antesL);
    expect(stableStringify(remote)).toBe(antesR);
  });

  it('dos escenas iguales no cambian nada', () => {
    const local = scene(100, [note('a', 100)], { z: 50 });
    const remote = scene(100, [note('a', 100)], { z: 50 });
    const r = mergeScenes(local, remote, NOW);
    expect(r.localChanged).toBe(false);
    expect(r.remoteChanged).toBe(false);
  });

  it('trata la falta de mtime como 0', () => {
    const sinMtime = note('a', 0, 'antiguo');
    delete (sinMtime as { mtime?: number }).mtime;
    const local = scene(100, [sinMtime]);
    const remote = scene(100, [note('a', 1, 'nuevo')]);
    const { scene: m } = mergeScenes(local, remote, NOW);
    expect((m.items[0] as { text: string }).text).toBe('nuevo');
  });
});
