/**
 * Funciones IA: describir tablero y etiquetar imágenes (requieren clave API del
 * usuario). Antes de cada llamada se muestra un diálogo con lo que se enviará,
 * el modelo elegido y el costo estimado; después se avisa el costo real y se
 * suma al contador local.
 */
import type { App } from '../app';
import type { ImageItem } from '../core/model';
import { getLanguage, t } from '../i18n';
import { h, miniMarkdown } from './dom';
import { showDialog, toast } from './dialogs';
import {
  aiAvailable,
  describeBoard,
  tagImages,
  redactKey,
  resolveModel,
  recordUsage,
  getAiUsage,
  resetAiUsage,
  AiError,
  MAX_TOKENS_DESCRIBE,
  MAX_TOKENS_TAG,
  type AiUsage
} from '../ai/claude';
import {
  AI_MODELS,
  AI_THUMB_MAX_SIDE,
  estimateRequest,
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
      h('option', { value: m.id, selected: m.id === current || undefined }, `${modelLabel(m.id)} · ${modelPriceLabel(m.id)}`)
    )
  );
  sel.addEventListener('change', () => {
    void updateAppSettings({ aiModel: sel.value });
    onChange(sel.value);
  });
  return sel;
}

/**
 * Diálogo previo a llamar a la API: dice qué se enviará, con qué modelo y
 * cuánto costaría aproximadamente. Devuelve `true` si el usuario continúa.
 */
function confirmAiRun(opts: {
  title: string;
  images: { w: number; h: number }[];
  notes: number;
  textChars: number;
  maxOutput: number;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v: boolean) => {
      if (done) return;
      done = true;
      d.close();
      resolve(v);
    };

    const cost = h('p', { class: 'ai-cost' });
    const price = h('div', { class: 'hint' });
    const refresh = () => {
      const model = resolveModel();
      const est = estimateRequest({
        model,
        images: opts.images,
        textChars: opts.textChars,
        maxOutput: opts.maxOutput
      });
      cost.textContent = t('ui_ai_confirm_cost', {
        usd: formatUsd(est.usd),
        tokens: formatTokens(est.inputTokens + est.outputTokens)
      });
      price.textContent = modelPriceLabel(model);
    };
    const sel = modelSelect(refresh);
    refresh();

    const d = showDialog(
      [
        h('h2', null, opts.title),
        h(
          'p',
          null,
          t('ui_ai_confirm_send', {
            images: opts.images.length,
            px: AI_THUMB_MAX_SIDE,
            notes: opts.notes
          })
        ),
        h('div', { class: 'field' }, h('label', null, t('ui_ai_model')), sel, price),
        cost,
        h('p', { class: 'hint' }, t('ui_ai_confirm_billing')),
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

/** Suma el consumo al contador local y avisa el costo real. */
function reportUsage(usage: AiUsage, calls: number, extra = ''): void {
  void recordUsage(usage, calls);
  const line = t('ui_ai_cost_toast', {
    usd: formatUsd(usage.usd),
    tokens: formatTokens(usage.inputTokens + usage.outputTokens)
  });
  toast(extra ? `${extra} · ${line}` : line);
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

  const ok = await confirmAiRun({
    title: t('cmd_ai_describe'),
    images: dims,
    notes: notes.length,
    textChars: notes.join(' ').length + 500,
    maxOutput: MAX_TOKENS_DESCRIBE
  });
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
  const ok = await confirmAiRun({
    title: t('cmd_ai_tag'),
    images: dims,
    notes: 0,
    textChars: images.reduce((n, i) => n + i.id.length + i.name.length + 20, 0) + 500 * calls,
    maxOutput: MAX_TOKENS_TAG * calls
  });
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
    placeholder: appSettings.aiApiKey ? redactKey(appSettings.aiApiKey) : 'sk-ant-…',
    autocomplete: 'off',
    autocapitalize: 'off'
  });
  keyInput.addEventListener('change', () => {
    void updateAppSettings({ aiApiKey: keyInput.value.trim() });
    keyInput.value = '';
    keyInput.placeholder = appSettings.aiApiKey ? redactKey(appSettings.aiApiKey) : 'sk-ant-…';
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
    h('p', { class: 'hint' }, t('ui_ai_what_similar')),
    h('div', { class: 'field' }, h('label', null, t('ui_ai_key')), keyInput, h('div', { class: 'hint' }, t('ui_ai_key_hint'))),
    h('div', { class: 'field' }, h('label', null, t('ui_ai_model')), sel, price),
    h('div', { class: 'field' }, h('label', null, t('ui_ai_usage')), usage, h('div', { class: 'row' }, resetBtn)),
    h('p', { class: 'hint' }, t('ui_ai_local_key'))
  );
}
