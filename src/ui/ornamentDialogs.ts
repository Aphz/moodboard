/**
 * Símbolos y ornamentos: los signos sueltos que convierten una grilla de
 * imágenes en un moodboard con carácter.
 *
 * El mood sale de las etiquetas y el nombre del tablero (catálogo local de
 * `src/features/ornaments.ts`, sin costo). Con clave API se puede pedir a la IA
 * que lea el mood y proponga su propio repertorio: es una llamada de texto,
 * la más barata de todas.
 */
import type { App } from '../app';
import { createNoteItem, itemBounds, type ImageItem, type ItemId, type Rect } from '../core/model';
import { getLanguage, t, type MsgKey } from '../i18n';
import {
  MOODS,
  defaultOrnamentSize,
  inkColor,
  moodFromText,
  ornamentBox,
  placeOrnaments,
  symbolsForMood,
  type MoodId,
  type OrnamentSpec
} from '../features/ornaments';
import { AiError, aiAvailable, recordUsage, suggestOrnaments } from '../ai/claude';
import { formatUsd } from '../ai/pricing';
import { moodThumbs } from './aiDialogs';
import { h } from './dom';
import { showDialog, toast } from './dialogs';

/** Cuántos signos poner, en proporción a las imágenes del tablero. */
const AMOUNTS = { few: 0.12, normal: 0.25, many: 0.45 } as const;

/** Tamaño del glifo como fracción del ancho típico de las imágenes. */
const SIZES = { small: 1 / 7, medium: 1 / 5, large: 1 / 3.5 } as const;

/** Texto del tablero (nombre, etiquetas y notas) para deducir el mood. */
function boardText(app: App): string {
  const S = app.store;
  const tags = S.scene.items.flatMap((i) => i.tags);
  const notes = S.scene.items.filter((i) => i.kind === 'note').map((i) => (i.kind === 'note' ? i.text : ''));
  return [S.scene.name, ...tags, ...notes.slice(0, 20)].join(' ');
}

/** Cajas de las imágenes visibles: es lo que los ornamentos no deben tapar. */
function boardBoxes(app: App): Rect[] {
  return app.store.scene.items.filter((i) => i.visible && i.kind !== 'group').map((i) => itemBounds(i));
}

/**
 * Diálogo de símbolos y ornamentos. Deja elegir mood, cantidad y tamaño, con
 * los signos a la vista para descartar los que no gusten.
 */
export function showOrnaments(app: App): void {
  const boxes = boardBoxes(app);
  if (boxes.length === 0) {
    toast(t('ui_orn_need_items'), { error: true });
    return;
  }

  const detected = moodFromText(boardText(app));
  let mood: MoodId = detected;
  let symbols = symbolsForMood(mood);
  const chosen = new Set(symbols);

  const moodSel = h(
    'select',
    null,
    h('option', { value: 'auto', selected: true }, t('ui_orn_mood_auto', { mood: t(`mood_${detected}` as MsgKey) })),
    ...MOODS.map((m) => h('option', { value: m }, t(`mood_${m}` as MsgKey)))
  );
  const amount = h(
    'select',
    null,
    ...(['few', 'normal', 'many'] as const).map((id) =>
      h('option', { value: id, selected: id === 'normal' || undefined }, t(`ui_orn_amount_${id}` as MsgKey))
    )
  );
  const size = h(
    'select',
    null,
    ...(['small', 'medium', 'large'] as const).map((id) =>
      h('option', { value: id, selected: id === 'medium' || undefined }, t(`ui_orn_size_${id}` as MsgKey))
    )
  );

  const chips = h('div', { class: 'chips' });
  const addBtn = h('button', { class: 'btn primary' });
  const moodLine = h('div', { class: 'hint' });

  /** Cuántos signos entran según la cantidad elegida y el tamaño del tablero. */
  const plannedCount = (): number => {
    const factor = AMOUNTS[amount.value as keyof typeof AMOUNTS] ?? AMOUNTS.normal;
    return Math.max(2, Math.min(24, Math.round(boxes.length * factor)));
  };

  const refresh = () => {
    chips.replaceChildren(
      ...symbols.map((sym) => {
        const on = chosen.has(sym);
        const chip = h('button', { class: `chip glyph${on ? ' active' : ''}`, 'aria-pressed': String(on) }, sym);
        chip.addEventListener('click', () => {
          if (chosen.has(sym)) chosen.delete(sym);
          else chosen.add(sym);
          refresh();
        });
        return chip;
      })
    );
    addBtn.textContent = t('ui_orn_add', { count: plannedCount() });
  };
  amount.addEventListener('change', refresh);
  moodSel.addEventListener('change', () => {
    mood = moodSel.value === 'auto' ? detected : (moodSel.value as MoodId);
    symbols = symbolsForMood(mood);
    chosen.clear();
    for (const s of symbols) chosen.add(s);
    moodLine.textContent = '';
    refresh();
  });
  refresh();

  const aiBtn = h('button', { class: 'btn' }, t('ui_orn_ai'));
  aiBtn.addEventListener('click', () => {
    void (async () => {
      aiBtn.toggleAttribute('disabled', true);
      const tt = toast(t('ui_ai_thinking'), { spinner: true });
      try {
        const suggestion = await askAi(app);
        tt.close();
        if (suggestion.symbols.length) {
          symbols = suggestion.symbols;
          chosen.clear();
          for (const s of symbols) chosen.add(s);
          moodSel.value = 'auto';
        }
        if (suggestion.mood) moodLine.textContent = t('ui_orn_ai_done', { mood: suggestion.mood });
        refresh();
      } catch (e) {
        tt.close();
        toast(`${t('ui_ai_error')}: ${e instanceof AiError ? e.message : String(e)}`, { error: true });
      } finally {
        aiBtn.toggleAttribute('disabled', false);
      }
    })();
  });

  addBtn.addEventListener('click', () => {
    const list = symbols.filter((s) => chosen.has(s));
    if (!list.length) {
      toast(t('ui_orn_none'), { error: true });
      return;
    }
    d.close();
    const base = defaultOrnamentSize(boxes);
    const factor = SIZES[size.value as keyof typeof SIZES] ?? SIZES.medium;
    const specs = placeOrnaments(boxes, list, {
      count: plannedCount(),
      size: base > 0 ? base * (factor / SIZES.medium) : 0,
      seed: Date.now() & 0xffff
    });
    if (!specs.length) {
      toast(t('ui_orn_no_room'), { error: true });
      return;
    }
    addOrnaments(app, specs);
    toast(t('ui_orn_added', { count: specs.length }));
  });

  const d = showDialog([
    h('h2', null, t('ui_orn_title')),
    h('p', null, t('ui_orn_intro')),
    h('div', { class: 'field' }, h('label', null, t('ui_orn_mood')), moodSel, moodLine),
    ...(aiAvailable() ? [h('div', { class: 'row' }, aiBtn)] : []),
    h('div', { class: 'field' }, h('label', null, t('ui_orn_amount')), amount),
    h('div', { class: 'field' }, h('label', null, t('ui_orn_size')), size),
    h('div', { class: 'field' }, h('label', null, t('ui_orn_symbols')), chips),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn', onclick: () => d.close() }, t('ui_cancel')),
      addBtn
    )
  ]);
}

/** Pide el mood y los signos a la IA y anota el consumo. */
async function askAi(app: App): Promise<{ mood: string; symbols: string[] }> {
  const S = app.store;
  const images = S.scene.items.filter((i): i is ImageItem => i.kind === 'image' && i.visible);
  const tags = [...new Set(images.flatMap((i) => i.tags))];
  const palette = [...new Set(images.flatMap((i) => i.palette.slice(0, 2)))];
  const { result, usage } = await suggestOrnaments({
    board: S.scene.name,
    tags,
    categories: [...new Set(S.scene.items.filter((i) => i.kind === 'group').map((i) => i.name))],
    palette,
    images: await thumbsForMood(app, images),
    lang: getLanguage()
  });
  void recordUsage(usage, 1);
  toast(formatUsd(usage.usd));
  return result;
}

/**
 * Miniaturas de respaldo: sólo se preparan si el tablero no tiene etiquetas ni
 * grupos, que es cuando el texto no alcanza para leer el mood.
 */
async function thumbsForMood(app: App, images: ImageItem[]): Promise<{ jpegBase64: string }[] | undefined> {
  const pistas = new Set(images.flatMap((i) => i.tags)).size + app.store.scene.items.filter((i) => i.kind === 'group').length;
  if (pistas >= 3 || !images.length) return undefined;
  return moodThumbs(images);
}

/** Crea las notas-ornamento en una sola transacción y las deja seleccionadas. */
function addOrnaments(app: App, specs: OrnamentSpec[]): void {
  const S = app.store;
  const color = inkColor(S.scene.settings.canvasColor);
  const created: ItemId[] = [];
  S.commit(() => {
    for (const o of specs) {
      const box = ornamentBox(o.text, o.size);
      const note = createNoteItem(o.text, {
        name: o.text,
        x: o.x,
        y: o.y,
        // la misma caja que se reservó al buscar hueco, para no pisar nada
        w: box.w,
        h: box.h,
        rotation: o.rotation,
        fontSize: o.size,
        color,
        background: 'transparent',
        align: 'center',
        autoHeight: true,
        tags: ['ornamento']
      });
      S.addItem(note);
      created.push(note.id);
    }
    S.select(created);
  });
}
