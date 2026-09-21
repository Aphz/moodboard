/**
 * Funciones IA: describir tablero, etiquetar imágenes y organizar por
 * categorías (requieren clave API del usuario). Antes de cada llamada se muestra un diálogo con lo que se enviará,
 * el modelo elegido y el costo estimado; después se avisa el costo real y se
 * suma al contador local.
 */
import type { App } from '../app';
import { createGroupItem, createNoteItem, type ImageItem, type ItemId } from '../core/model';
import { clustersFromAssignments, layoutByCategory } from '../features/organize';
import { getLanguage, t } from '../i18n';
import { h, miniMarkdown } from './dom';
import { confirmDialog, showDialog, toast } from './dialogs';
import {
  aiAvailable,
  classifyImages,
  isApiKeyLike,
  describeBoard,
  tagImages,
  redactKey,
  resolveModel,
  recordUsage,
  getAiUsage,
  resetAiUsage,
  AiError,
  type AiUsage
} from '../ai/claude';
import {
  AI_MODELS,
  AI_THUMB_MAX_SIDE,
  formatTokens,
  formatUsd,
  modelLabel,
  modelPriceLabel
} from '../ai/pricing';
import { appSettings, updateAppSettings } from '../core/settings';
import { ensureBitmaps, getBitmap } from '../render/imageCache';

/** Calidad JPEG de las miniaturas que se envían (baja a propósito: menos tokens). */
const THUMB_QUALITY = 0.7;

/** Tamaño máximo de lote al etiquetar (debe coincidir con el de `tagImages`). */
const TAG_BATCH = 20;

/**
 * Lado de las miniaturas al clasificar: 256 px bastan para distinguir una pose
 * de una textura y cuestan ≈ 90 tokens por imagen, la cuarta parte que a 384.
 */
export const AI_CLASSIFY_THUMB_SIDE = 256;

/** Alto (unidades de escena) del título sobre cada categoría. */
const CATEGORY_TITLE_HEIGHT = 96;

/** Miniatura pequeña en JPEG base64 (sin prefijo), con sus dimensiones reales. */
async function thumbBase64(
  img: ImageItem,
  maxSide = AI_THUMB_MAX_SIDE
): Promise<{ data: string; w: number; h: number } | null> {
  await ensureBitmaps([img.blobId]);
  const bmp = getBitmap(img.blobId);
  if (!bmp) return null;
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s));
  c.height = Math.max(1, Math.round(bmp.height * s));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', THUMB_QUALITY);
  const data = url.split(',')[1] ?? null;
  return data ? { data, w: c.width, h: c.height } : null;
}

function requireKey(): boolean {
  if (aiAvailable()) return true;
  toast(t('ui_ai_no_key'), { error: true });
  return false;
}

/** `<select>` de modelos; el valor elegido se guarda en los ajustes. */
function modelSelect(onChange: (id: string) => void): HTMLSelectElement {
  const current = resolveModel();
  const sel = h(
    'select',
    null,
    ...AI_MODELS.map((m) =>
      h('option', { value: m.id, selected: m.id === current || undefined }, modelLabel(m.id))
    )
  );
  sel.addEventListener('change', () => {
    void updateAppSettings({ aiModel: sel.value });
    onChange(sel.value);
  });
  return sel;
}

/**
 * Diálogo previo a llamar a la API: qué se enviará y con qué modelo. Sin
 * cifras de consumo: el gasto real queda en el contador de Ajustes.
 */
function confirmAiRun(opts: {
  title: string;
  images: { w: number; h: number }[];
  notes: number;
  /** Lado de las miniaturas que se envían (por defecto `AI_THUMB_MAX_SIDE`). */
  px?: number;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v: boolean) => {
      if (done) return;
      done = true;
      d.close();
      resolve(v);
    };

    const d = showDialog(
      [
        h('h2', null, opts.title),
        h(
          'p',
          null,
          t('ui_ai_confirm_send', {
            images: opts.images.length,
            px: opts.px ?? AI_THUMB_MAX_SIDE,
            notes: opts.notes
          })
        ),
        h('div', { class: 'field' }, h('label', null, t('ui_ai_model')), modelSelect(() => undefined)),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn', onclick: () => fin(false) }, t('ui_cancel')),
          h('button', { class: 'btn primary', onclick: () => fin(true) }, t('ui_ai_continue'))
        )
      ],
      { onClose: () => fin(false) }
    );
  });
}

/** Suma el consumo al contador local y avisa el resultado con su costo real. */
function reportUsage(usage: AiUsage, calls: number, extra = ''): void {
  void recordUsage(usage, calls);
  const cost = formatUsd(usage.usd);
  toast(extra ? `${extra} · ${cost}` : cost);
}

export async function showAiDescribe(app: App) {
  if (!requireKey()) return;
  const S = app.store;
  const sel = S.selectedItems();
  const pool = (sel.length ? sel : S.scene.items)
    .filter((i): i is ImageItem => i.kind === 'image' && i.visible)
    .slice(0, 20);
  const notes = S.scene.items
    .filter((i) => i.kind === 'note')
    .map((n) => (n as { text: string }).text)
    .filter(Boolean);

  const prep = toast(t('ui_ai_preparing'), { spinner: true });
  const images: { name: string; jpegBase64: string }[] = [];
  const dims: { w: number; h: number }[] = [];
  for (const img of pool) {
    const th = await thumbBase64(img);
    if (!th) continue;
    images.push({ name: img.name, jpegBase64: th.data });
    dims.push({ w: th.w, h: th.h });
  }
  prep.close();

  const ok = await confirmAiRun({ title: t('cmd_ai_describe'), images: dims, notes: notes.length });
  if (!ok) return;

  const tt = toast(t('ui_ai_thinking'), { spinner: true });
  try {
    const { result: md, usage } = await describeBoard({ images, notes, lang: getLanguage() });
    tt.close();
    reportUsage(usage, 1);
    const d = showDialog(
      [
        h('h2', null, t('cmd_ai_describe')),
        h('div', { class: 'prose', html: miniMarkdown(md) }),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn', onclick: () => { d.close(); app.createNote(undefined, md); } }, t('cmd_tool_note')),
          h('button', { class: 'btn primary', onclick: () => d.close() }, t('ui_close'))
        )
      ],
      { wide: true }
    );
  } catch (e) {
    tt.close();
    toast(`${t('ui_ai_error')}: ${e instanceof AiError ? e.message : String(e)}`, { error: true });
  }
}

export async function runAiTagging(app: App) {
  if (!requireKey()) return;
  const S = app.store;
  const imgs = S.selectedItems().filter((i): i is ImageItem => i.kind === 'image');
  if (!imgs.length) return;

  const prep = toast(t('ui_ai_preparing'), { spinner: true });
  const images: { id: string; name: string; jpegBase64: string }[] = [];
  const dims: { w: number; h: number }[] = [];
  for (const img of imgs) {
    const th = await thumbBase64(img);
    if (!th) continue;
    images.push({ id: img.id, name: img.name, jpegBase64: th.data });
    dims.push({ w: th.w, h: th.h });
  }
  prep.close();
  if (!images.length) return;

  const calls = Math.max(1, Math.ceil(images.length / TAG_BATCH));
  const ok = await confirmAiRun({ title: t('cmd_ai_tag'), images: dims, notes: 0 });
  if (!ok) return;

  const tt = toast(t('ui_ai_thinking'), { spinner: true });
  try {
    const { result: res, usage } = await tagImages({ images, lang: getLanguage() });
    S.commit(() =>
      S.update(Object.keys(res), (it) => {
        it.tags = [...new Set([...it.tags, ...(res[it.id] ?? [])])];
      })
    );
    tt.close();
    reportUsage(usage, calls, `${t('ui_tags')}: ${Object.values(res).flat().length}`);
  } catch (e) {
    tt.close();
    toast(`${t('ui_ai_error')}: ${e instanceof AiError ? e.message : String(e)}`, { error: true });
  }
}

/** Lista de categorías a partir del texto del usuario («a, b; c»). */
export function parseCategories(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,;\n]/)) {
    const c = raw.trim();
    if (c && !out.some((x) => x.toLowerCase() === c.toLowerCase())) out.push(c);
  }
  return out;
}

/**
 * IA: organizar por categorías. Clasifica las imágenes dadas (o las
 * seleccionadas, o todas las visibles) y las recoloca por bloques: un grupo con
 * título por categoría. Todo el cambio en el lienzo es un único paso de
 * historial, así que se deshace con una sola acción.
 */
export async function showAiOrganize(app: App, preset?: ImageItem[]): Promise<void> {
  if (!requireKey()) return;
  const S = app.store;
  const selected = S.selectedItems().filter((i): i is ImageItem => i.kind === 'image');
  const pool = (preset?.length ? preset : selected.length >= 2 ? selected : S.scene.items.filter((i): i is ImageItem => i.kind === 'image')).filter(
    (i) => i.visible && !i.locked
  );
  if (pool.length < 2) {
    toast(t('ui_org_need_two'), { error: true });
    return;
  }

  const choice = await organizeOptionsDialog(pool.length);
  if (!choice) return;
  void updateAppSettings({ aiCategories: choice.categoriesText, aiCategoriesAdHoc: choice.adHoc });
  const categories = choice.adHoc ? [] : parseCategories(choice.categoriesText);
  if (!choice.adHoc && !categories.length) {
    toast(t('ui_org_no_categories'), { error: true });
    return;
  }

  const prep = toast(t('ui_ai_preparing'), { spinner: true });
  const images: { id: string; name: string; jpegBase64: string }[] = [];
  for (const img of pool) {
    const th = await thumbBase64(img, AI_CLASSIFY_THUMB_SIDE);
    if (!th) continue;
    images.push({ id: img.id, name: img.name, jpegBase64: th.data });
  }
  prep.close();
  if (images.length < 2) {
    toast(t('ui_org_need_two'), { error: true });
    return;
  }

  const calls = Math.max(1, Math.ceil(images.length / TAG_BATCH));
  const tt = toast(t('ui_ai_thinking'), { spinner: true });
  try {
    const { result, usage } = await classifyImages({ images, categories, lang: getLanguage() });
    tt.close();
    applyOrganize(app, result.assignments, result.categories, { group: choice.group, titles: choice.titles });
    reportUsage(usage, calls, t('ui_org_done', { categories: result.categories.length }));
  } catch (e) {
    tt.close();
    toast(`${t('ui_ai_error')}: ${e instanceof AiError ? e.message : String(e)}`, { error: true });
  }
}

/** Opciones del diálogo de organizar: modo, categorías, grupos y títulos. */
function organizeOptionsDialog(count: number): Promise<{ adHoc: boolean; categoriesText: string; group: boolean; titles: boolean } | null> {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v: { adHoc: boolean; categoriesText: string; group: boolean; titles: boolean } | null) => {
      if (done) return;
      done = true;
      d.close();
      resolve(v);
    };
    const adHoc = h('input', { type: 'radio', name: 'org-mode', checked: appSettings.aiCategoriesAdHoc || undefined });
    const presetR = h('input', { type: 'radio', name: 'org-mode', checked: !appSettings.aiCategoriesAdHoc || undefined });
    const cats = h('input', { type: 'text', value: appSettings.aiCategories, autocapitalize: 'words', placeholder: 'Poses, Texturas, Ropa' });
    const group = h('input', { type: 'checkbox', checked: true });
    // sin marcar: el nombre de la categoría se ve al tocar el grupo, así que
    // un rótulo fijo sólo hace falta para que salga en la exportación
    const titles = h('input', { type: 'checkbox' });
    const model = modelSelect(() => undefined);
    const syncCats = () => {
      cats.disabled = adHoc.checked;
      cats.style.opacity = adHoc.checked ? '0.5' : '';
    };
    adHoc.addEventListener('change', syncCats);
    presetR.addEventListener('change', syncCats);
    cats.addEventListener('focus', () => {
      presetR.checked = true;
      syncCats();
    });
    syncCats();
    const d = showDialog(
      [
        h('h2', null, t('ui_org_title')),
        h('p', null, t('ui_org_intro', { count })),
        h('label', { class: 'row' }, adHoc, h('span', null, t('ui_org_mode_adhoc'))),
        h('label', { class: 'row' }, presetR, h('span', null, t('ui_org_mode_preset'))),
        h('div', { class: 'field' }, cats, h('div', { class: 'hint' }, t('ui_org_categories_hint'))),
        h('label', { class: 'row' }, group, h('span', null, t('ui_org_group'))),
        h('label', { class: 'row' }, titles, h('span', null, t('ui_org_titles'))),
        h('div', { class: 'field' }, h('label', null, t('ui_ai_model')), model),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn', onclick: () => fin(null) }, t('ui_cancel')),
          h(
            'button',
            { class: 'btn primary', onclick: () => fin({ adHoc: adHoc.checked, categoriesText: cats.value, group: group.checked, titles: titles.checked }) },
            t('ui_ai_continue')
          )
        )
      ],
      { onClose: () => fin(null) }
    );
  });
}

/**
 * Aplica una clasificación al lienzo en una sola transacción: recoloca las
 * imágenes por bloques, crea (opcionalmente) un grupo y un título por
 * categoría, añade la categoría como etiqueta y deja los grupos seleccionados.
 */
export function applyOrganize(
  app: App,
  assignments: Record<ItemId, string>,
  order: string[],
  opts: { group: boolean; titles: boolean }
): void {
  const S = app.store;
  const items = S.scene.items.filter((i) => i.kind === 'image' && assignments[i.id]);
  const clusters = clustersFromAssignments(assignments, order);
  const padding = S.scene.settings.alignPadding;
  const layout = layoutByCategory(items, clusters, {
    padding,
    // apenas una costura entre categorías: el tablero se lee como un collage
    // continuo y el contexto aparece al tocar el grupo
    gap: Math.max(24, padding * 3),
    titleHeight: opts.titles ? CATEGORY_TITLE_HEIGHT : 0,
    aspect: app.viewAspect()
  });
  if (!layout.clusters.length) return;

  // padre común de las imágenes (si todas comparten uno) para colgar ahí los grupos
  const parents = new Set(items.map((i) => i.parentId));
  const parentId = parents.size === 1 ? [...parents][0]! : null;

  const created: ItemId[] = [];
  S.commit(() => {
    const byId = new Map(layout.placements.map((p) => [p.id, p]));
    S.update(
      items.map((i) => i.id),
      (it) => {
        const p = byId.get(it.id);
        if (p) {
          it.x = p.x;
          it.y = p.y;
          // el collage iguala los anchos, así que trae escala propia
          if (p.scale !== undefined && p.scale > 0) it.scale = p.scale;
        }
        const cat = assignments[it.id]!.toLowerCase();
        if (!it.tags.some((x) => x.toLowerCase() === cat)) it.tags = [...it.tags, cat];
      }
    );
    for (const c of layout.clusters) {
      const members: ItemId[] = [...c.ids];
      if (opts.titles) {
        const note = createNoteItem(c.title, {
          name: c.title,
          x: c.rect.x + c.rect.w / 2,
          y: c.rect.y + CATEGORY_TITLE_HEIGHT / 2,
          w: Math.max(240, c.rect.w),
          h: CATEGORY_TITLE_HEIGHT * 0.7,
          fontSize: 40,
          align: 'center',
          background: '#00000000',
          autoHeight: true,
          parentId
        });
        S.addItem(note);
        members.push(note.id);
      }
      if (opts.group) {
        const g = createGroupItem({ name: c.title, x: c.rect.x + c.rect.w / 2, y: c.rect.y + c.rect.h / 2, w: c.rect.w, h: c.rect.h, parentId });
        S.addItem(g);
        S.setParent(members, g.id);
        created.push(g.id);
      } else {
        if (parentId !== undefined) S.setParent(members, parentId);
        created.push(...members);
      }
    }
    S.select(created);
  });
  app.gestures.fitSelection();
}

/**
 * Bloque de ajustes de IA: explica para qué sirve cada función, permite escribir
 * la clave (que nunca sale del dispositivo), elegir modelo con su precio y ver o
 * reiniciar el contador de consumo acumulado.
 *
 * Lo monta `settingsDialog.ts`.
 */
export function renderAiSettings(): HTMLElement {
  const keyInput = h('input', {
    type: 'password',
    placeholder: 'sk-ant-…',
    // iOS ofrece contraseñas guardadas en cualquier campo de este tipo: con
    // nombre propio y sin autocompletado deja de proponerlas.
    name: 'anthropic-api-key',
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    'data-1p-ignore': 'true',
    'data-lpignore': 'true'
  });
  /** Estado actual: clave guardada (ofuscada) o aviso de que no hay. */
  const keyState = h('div', { class: 'hint' });
  const removeBtn = h('button', { class: 'btn small danger' }, t('ui_ai_key_remove'));
  const syncKeyState = () => {
    const saved = appSettings.aiApiKey;
    keyState.textContent = saved ? t('ui_ai_key_saved', { key: redactKey(saved) }) : t('ui_ai_key_none');
    removeBtn.style.display = saved ? '' : 'none';
  };
  syncKeyState();

  /**
   * Sólo se guarda una clave con forma válida. Nunca se escribe una cadena
   * vacía: antes bastaba enfocar el campo y salir para perder la clave.
   */
  const saveKey = () => {
    const value = keyInput.value.trim();
    if (!value) return; // el campo vacío significa «no lo toques»
    if (!isApiKeyLike(value)) {
      toast(t('ui_ai_key_invalid'), { error: true });
      return;
    }
    keyInput.value = '';
    void updateAppSettings({ aiApiKey: value }).then(() => {
      syncKeyState();
      toast(t('ui_ai_key_saved_ok'));
    });
  };
  keyInput.addEventListener('change', saveKey);
  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveKey();
    }
  });
  removeBtn.addEventListener('click', async () => {
    if (!(await confirmDialog(t('ui_ai_key_remove_confirm'), { danger: true }))) return;
    await updateAppSettings({ aiApiKey: '' });
    syncKeyState();
  });

  const price = h('div', { class: 'hint' }, modelPriceLabel(resolveModel()));
  const sel = modelSelect((id) => (price.textContent = modelPriceLabel(id)));

  const usage = h('div', { class: 'hint' }, '…');
  const showUsage = async () => {
    const u = await getAiUsage();
    usage.textContent = t('ui_ai_usage_detail', {
      calls: u.calls,
      tokens: formatTokens(u.inputTokens + u.outputTokens),
      usd: formatUsd(u.usd)
    });
  };
  void showUsage();

  const resetBtn = h('button', { class: 'btn small' }, t('ui_ai_usage_reset'));
  resetBtn.addEventListener('click', async () => {
    await resetAiUsage();
    await showUsage();
    toast(t('ui_ai_usage_reset_done'));
  });

  return h(
    'div',
    { class: 'ai-settings' },
    h('h3', null, t('ui_ai_section')),
    h('p', { class: 'hint' }, t('ui_ai_what_describe')),
    h('p', { class: 'hint' }, t('ui_ai_what_tag')),
    h('p', { class: 'hint' }, t('ui_ai_what_organize')),
    h('p', { class: 'hint' }, t('ui_ai_what_similar')),
    h('p', { class: 'hint' }, t('ui_ai_billing_note')),
    h('div', { class: 'field' }, h('label', null, t('ui_ai_key')), keyInput, keyState, h('div', { class: 'hint' }, t('ui_ai_key_hint')), h('div', { class: 'row' }, removeBtn)),
    h('div', { class: 'field' }, h('label', null, t('ui_ai_model')), sel, price),
    h('div', { class: 'field' }, h('label', null, t('ui_ai_usage')), usage, h('div', { class: 'row' }, resetBtn)),
    h('p', { class: 'hint' }, t('ui_ai_local_key'))
  );
}
