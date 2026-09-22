/**
 * Regla de selección con grupos.
 *
 * Un tablero organizado por la IA queda lleno de grupos, y ahí decidir qué se
 * selecciona al tocar es lo que hace la app usable o insufrible. La regla es
 * **la hoja primero**: tocar una imagen selecciona la imagen, y volver a
 * tocarla sube al grupo que la contiene (y al siguiente, si hay grupos
 * anidados). Antes era al revés —el primer toque tomaba el grupo entero— y
 * mover una sola imagen entre categorías exigía adivinar cuántos toques daba.
 *
 * Módulo PURO: recibe la cadena de ancestros y qué está seleccionado.
 */
import { itemBounds, unionRects, type Item, type ItemId, type Rect } from '../core/model';

/**
 * Qué ítem debe quedar seleccionado al tocar.
 *
 * @param chain    cadena de ancestros: `chain[0]` es el ítem tocado y el
 *                 último es la raíz. La devuelve `ancestorChain`.
 * @param selected ids seleccionados ahora mismo.
 */
export function selectionTarget(chain: Item[], selected: ReadonlySet<ItemId>): Item | null {
  const leaf = chain[0];
  if (!leaf) return null;
  // la hoja manda: si todavía no está seleccionada, se selecciona ella
  if (!selected.has(leaf.id)) return leaf;
  // ya estaba: subir al grupo más cercano que no esté seleccionado
  for (let i = 1; i < chain.length; i++) {
    const up = chain[i]!;
    if (up.kind === 'group' && !selected.has(up.id)) return up;
  }
  // todo el camino está seleccionado: se queda la hoja
  return leaf;
}

/**
 * Cadena de ancestros de un ítem, del propio ítem hacia la raíz.
 *
 * `get` sirve para no depender del store: se le pasa una función que resuelve
 * un id. Corta si encuentra un ciclo, que no debería existir pero un archivo
 * `.moodboard` editado a mano podría traerlo.
 */
export function ancestorChain(item: Item, get: (id: ItemId) => Item | undefined): Item[] {
  const chain: Item[] = [item];
  const seen = new Set<ItemId>([item.id]);
  let cur: Item | undefined = item;
  while (cur?.parentId) {
    const parent: Item | undefined = get(cur.parentId);
    if (!parent || seen.has(parent.id)) break;
    chain.push(parent);
    seen.add(parent.id);
    cur = parent;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Destino al arrastrar

/**
 * A qué puede entrar lo que se arrastra, mirando la cadena del ítem que está
 * debajo del puntero (`ancestorChain` de la hoja, sin contar lo movido).
 *
 * Devuelve el grupo más INTERNO de la cadena: soltar sobre una imagen de
 * «Ropa» mete en «Ropa», no en el grupo que envuelve todo el tablero. Si la
 * hoja no está en ningún grupo, devuelve la propia imagen (ahí se cuelgan
 * notas y dibujos) o `null` si no sirve de destino. Si la hoja o cualquiera de
 * sus ancestros está entre lo movido, no hay destino.
 */
export function dropTarget(chain: Item[], moved: ReadonlySet<ItemId>): Item | null {
  const leaf = chain[0];
  if (!leaf || moved.has(leaf.id)) return null;
  for (let i = 1; i < chain.length; i++) {
    const up = chain[i]!;
    // la hoja cuelga de algo que se está moviendo: no es destino de nada
    if (moved.has(up.id)) return null;
    if (up.kind === 'group') return up;
  }
  return leaf.kind === 'image' ? leaf : null;
}

/**
 * Caja de lo que le queda a un grupo sin contar lo que se está moviendo.
 *
 * Es la clave para poder sacar algo de su categoría: si se mide el grupo
 * entero, su caja sigue al ítem arrastrado y el grupo «se lo queda» siempre.
 * `null` si al grupo no le quedaría contenido visible.
 */
export function remainingBounds(descendants: Item[], moved: ReadonlySet<ItemId>): Rect | null {
  const rest = descendants.filter((d) => d.kind !== 'group' && d.visible && !moved.has(d.id));
  return unionRects(rest.map(itemBounds));
}
