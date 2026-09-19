/** Funciones IA: describir tablero y etiquetar imágenes (requiere clave API del usuario). */
import type { App } from '../app';
import type { ImageItem } from '../core/model';
import { getLanguage, t } from '../i18n';
import { h, miniMarkdown } from './dom';
import { showDialog, toast } from './dialogs';
import { aiAvailable, describeBoard, tagImages, AiError } from '../ai/claude';
import { ensureBitmaps, getBitmap } from '../render/imageCache';

/** Miniatura JPEG en base64 (sin prefijo) para enviar a la API. */
async function thumbBase64(img: ImageItem, maxSide = 768): Promise<string | null> {
  await ensureBitmaps([img.blobId]);
  const bmp = getBitmap(img.blobId);
  if (!bmp) return null;
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s));
  c.height = Math.max(1, Math.round(bmp.height * s));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.8);
  return url.split(',')[1] ?? null;
}

function requireKey(): boolean {
  if (aiAvailable()) return true;
  toast(t('ui_ai_no_key'), { error: true });
  return false;
}

export async function showAiDescribe(app: App) {
  if (!requireKey()) return;
  const S = app.store;
  const sel = S.selectedItems();
  const pool = (sel.length ? sel : S.scene.items).filter((i): i is ImageItem => i.kind === 'image' && i.visible).slice(0, 20);
  const notes = S.scene.items.filter((i) => i.kind === 'note').map((n) => (n as { text: string }).text).filter(Boolean);
  const tt = toast(t('ui_ai_thinking'), { spinner: true });
  try {
    const images: { name: string; jpegBase64: string }[] = [];
    for (const img of pool) {
      const b64 = await thumbBase64(img);
      if (b64) images.push({ name: img.name, jpegBase64: b64 });
    }
    const md = await describeBoard({ images, notes, lang: getLanguage() });
    tt.close();
    const d = showDialog([
      h('h2', null, t('cmd_ai_describe')),
      h('div', { class: 'prose', html: miniMarkdown(md) }),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => { d.close(); app.createNote(undefined, md); } }, t('cmd_tool_note')),
        h('button', { class: 'btn primary', onclick: () => d.close() }, t('ui_close'))
      )
    ], { wide: true });
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
  const tt = toast(t('ui_ai_thinking'), { spinner: true });
  try {
    const images: { id: string; name: string; jpegBase64: string }[] = [];
    for (const img of imgs) {
      const b64 = await thumbBase64(img, 512);
      if (b64) images.push({ id: img.id, name: img.name, jpegBase64: b64 });
    }
    const res = await tagImages({ images, lang: getLanguage() });
    S.commit(() =>
      S.update(Object.keys(res), (it) => {
        it.tags = [...new Set([...it.tags, ...(res[it.id] ?? [])])];
      })
    );
    toast(`${t('ui_tags')}: ${Object.values(res).flat().length}`);
  } catch (e) {
    toast(`${t('ui_ai_error')}: ${e instanceof AiError ? e.message : String(e)}`, { error: true });
  } finally {
    tt.close();
  }
}
