/**
 * Pruebas del formato `.moodboard` (exportar → importar).
 *
 * Se usan blobs diminutos en memoria: no hace falta IndexedDB ni decodificar
 * imágenes de verdad, sólo comprobar que los bytes viajan intactos y que la
 * jerarquía y los identificadores se reconstruyen bien.
 */
import { describe, expect, it } from 'vitest';
import {
  createGroupItem,
  createImageItem,
  createNoteItem,
  createScene,
  type ImageItem,
  type Item,
  type Scene
} from '../src/core/model';
import {
  blobToU8,
  exportSceneFile,
  extToMime,
  importSceneFile,
  inspectZip,
  mimeToExt,
  sceneFileName
} from '../src/features/sceneFile';

/** Bytes de prueba por blobId. */
const BYTES: Record<string, Uint8Array> = {
  blob_a: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]),
  blob_b: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7, 6, 5])
};

/** `getBlob` de prueba sobre el mapa `BYTES`. */
async function getBlob(id: string): Promise<Blob | null> {
  const b = BYTES[id];
  return b ? new Blob([b as unknown as BlobPart], { type: 'image/png' }) : null;
}

interface PutCall {
  id: string;
  blob: Blob;
  w: number;
  h: number;
}

/** `putBlob` de prueba que registra cada llamada. */
function recorder() {
  const calls: PutCall[] = [];
  const putBlob = async (id: string, blob: Blob, w: number, h: number) => {
    calls.push({ id, blob, w, h });
  };
  return { calls, putBlob };
}

/** Escena de prueba: 2 imágenes, una nota hija de la imagen 1 y un grupo. */
function makeScene() {
  const scene: Scene = createScene('Mi tablero / prueba');
  const img1 = createImageItem('blob_a', 800, 600, { name: 'Foto 1', x: 100, y: 50 });
  const img2 = createImageItem('blob_b', 400, 300, { name: 'Foto 2', x: 900, y: 400 });
  const note = createNoteItem('hola', { name: 'Nota 1', parentId: img1.id, x: 120, y: 260 });
  const group = createGroupItem({ name: 'Grupo 1', x: 500, y: 500 });
  scene.items = [img1, img2, note, group];
  return { scene, img1, img2, note, group };
}

/** Busca un ítem por nombre. */
function byName(items: Item[], name: string): Item {
  const found = items.find((i) => i.name === name);
  if (!found) throw new Error(`No se encontró el ítem "${name}"`);
  return found;
}

/** jsdom no siempre implementa `Blob.arrayBuffer`; se reutiliza el helper del módulo. */
async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return blobToU8(blob);
}

describe('mimeToExt / extToMime', () => {
  it('mapea los formatos soportados', () => {
    expect(mimeToExt('image/png')).toBe('png');
    expect(mimeToExt('image/jpeg')).toBe('jpg');
    expect(mimeToExt('image/webp')).toBe('webp');
    expect(mimeToExt('image/gif')).toBe('gif');
    expect(mimeToExt('application/pdf')).toBe('png');
    expect(extToMime('jpg')).toBe('image/jpeg');
    expect(extToMime('.png')).toBe('image/png');
    expect(extToMime('webp')).toBe('image/webp');
  });
});

describe('sceneFileName', () => {
  it('sanea el nombre y añade la extensión', () => {
    const { scene } = makeScene();
    expect(sceneFileName(scene)).toBe('Mi tablero prueba.moodboard');
    expect(sceneFileName({ ...scene, name: '   ' })).toBe('moodboard.moodboard');
  });
});

describe('exportSceneFile / importSceneFile', () => {
  it('reimporta la escena completa con nuevos ids y los mismos bytes', async () => {
    const { scene, img1, note } = makeScene();
    const file = await exportSceneFile(scene, getBlob);
    expect(file.size).toBeGreaterThan(0);

    const { calls, putBlob } = recorder();
    const out = await importSceneFile(file, putBlob);

    // mismo número de ítems
    expect(out.items).toHaveLength(scene.items.length);

    // la nota sigue colgando de la imagen correcta (identificada por nombre)
    const newImg1 = byName(out.items, 'Foto 1');
    const newNote = byName(out.items, 'Nota 1');
    expect(newNote.parentId).toBe(newImg1.id);

    // los ids cambiaron (escena e ítems) y también los blobIds
    expect(out.id).not.toBe(scene.id);
    expect(newImg1.id).not.toBe(img1.id);
    expect(newNote.id).not.toBe(note.id);
    const newIds = new Set(out.items.map((i) => i.id));
    for (const old of scene.items) expect(newIds.has(old.id)).toBe(false);
    const images = out.items.filter((i): i is ImageItem => i.kind === 'image');
    expect(images).toHaveLength(2);
    for (const im of images) expect(im.blobId in BYTES).toBe(false);

    // putBlob: una vez por imagen, con los bytes originales y su tamaño natural
    expect(calls).toHaveLength(2);
    const byId = new Map(calls.map((c) => [c.id, c]));
    const c1 = byId.get((byName(out.items, 'Foto 1') as ImageItem).blobId)!;
    const c2 = byId.get((byName(out.items, 'Foto 2') as ImageItem).blobId)!;
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    expect(Array.from(await bytesOf(c1.blob))).toEqual(Array.from(BYTES.blob_a));
    expect(Array.from(await bytesOf(c2.blob))).toEqual(Array.from(BYTES.blob_b));
    expect([c1.w, c1.h]).toEqual([800, 600]);
    expect([c2.w, c2.h]).toEqual([400, 300]);
  });

  it('con onlyItems exporta sólo esos ítems y sus descendientes, recentrados', async () => {
    const { scene, img1 } = makeScene();
    const file = await exportSceneFile(scene, getBlob, { onlyItems: new Set([img1.id]) });

    const { calls, putBlob } = recorder();
    const out = await importSceneFile(file, putBlob);

    expect(out.items).toHaveLength(2);
    expect(out.items.map((i) => i.name).sort()).toEqual(['Foto 1', 'Nota 1']);
    const newImg1 = byName(out.items, 'Foto 1');
    const newNote = byName(out.items, 'Nota 1');
    // el root exportado pierde el padre; la nota conserva el suyo
    expect(newImg1.parentId).toBeNull();
    expect(newNote.parentId).toBe(newImg1.id);
    // recentrado en torno a 0,0
    const cx = (Math.min(newImg1.x, newNote.x) + Math.max(newImg1.x, newNote.x)) / 2;
    expect(Math.abs(cx)).toBeLessThan(200);
    expect(newImg1.x).not.toBe(img1.x);
    // sólo se restauró el bitmap de la imagen 1
    expect(calls).toHaveLength(1);
    expect(Array.from(await bytesOf(calls[0].blob))).toEqual(Array.from(BYTES.blob_a));
  });

  it('un archivo basura lanza un Error legible', async () => {
    const { putBlob } = recorder();
    const junk = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: 'application/zip' });
    await expect(importSceneFile(junk, putBlob)).rejects.toThrow(Error);
    await expect(importSceneFile(junk, putBlob)).rejects.toThrow(/moodboard/i);
  });
});

describe('inspectZip', () => {
  it('reconoce un .moodboard por su scene.json', async () => {
    const { scene } = makeScene();
    const blob = await exportSceneFile(scene, getBlob);
    const z = await inspectZip(blob);
    expect(z.isScene).toBe(true);
    expect(z.images).toEqual([]);
  });

  it('de un ZIP corriente saca sólo las imágenes, sin __MACOSX ni ocultos, ordenadas', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const zipped = zipSync({
      'tablero/pin 10.jpg': png,
      'tablero/pin 2.png': png,
      'tablero/notas.txt': strToU8('hola'),
      'tablero/.DS_Store': png,
      '__MACOSX/tablero/._pin 2.png': png,
      'tablero/sub/': new Uint8Array(0)
    });
    const z = await inspectZip(new Blob([zipped as unknown as BlobPart], { type: 'application/zip' }));
    expect(z.isScene).toBe(false);
    expect(z.images.map((i) => i.name)).toEqual(['pin 2.png', 'pin 10.jpg']);
    expect(z.images[0]!.blob.type).toBe('image/png');
    expect(z.images[1]!.blob.type).toBe('image/jpeg');
  });

  it('un archivo que no es ZIP lanza un Error legible', async () => {
    await expect(inspectZip(new Blob([new Uint8Array([1, 2, 3]) as unknown as BlobPart]))).rejects.toThrow(/ZIP/);
  });
});
