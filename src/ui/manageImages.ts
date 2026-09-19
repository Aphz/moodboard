/** Administrar imágenes: tamaño en disco, reducir, cambiar formato, descartar recortes. */
import type { App } from '../app';
import type { ImageItem } from '../core/model';
import { getBlob, putBlob } from '../core/persistence';
import { t } from '../i18n';
import { h, clear } from './dom';
import { showDialog, toast } from './dialogs';
import { bytesToHuman, decodeImage, optimizeImage } from '../features/imageTools';
import { putBitmap } from '../render/imageCache';
import { uid } from '../core/model';

export async function showManageImages(app: App) {
  const S = app.store;
  const imgs = S.scene.items.filter((i): i is ImageItem => i.kind === 'image');
  const sizes = new Map<string, number>();
  for (const i of imgs) {
    if (sizes.has(i.blobId)) continue;
    const b = await getBlob(i.blobId);
    sizes.set(i.blobId, b?.size ?? 0);
  }
  const total = [...sizes.values()].reduce((a, b) => a + b, 0);
  const checks = new Map<string, HTMLInputElement>();
  const list = h('div', null);
  const render = () => {
    clear(list);
    for (const i of imgs) {
      const c = h('input', { type: 'checkbox' });
      c.checked = S.selection.size === 0 || S.selection.has(i.id);
      checks.set(i.id, c);
      list.appendChild(
        h('div', { class: 'row' }, c, h('label', null, `${i.name}${i.crop ? ' ✂' : ''}`), h('span', { class: 'hint' }, `${i.naturalW}×${i.naturalH} · ${bytesToHuman(sizes.get(i.blobId) ?? 0)}`))
      );
    }
  };
  render();
  const maxSide = h('select', null, ...['1024', '1536', '2048', '4096'].map((v) => h('option', { value: v, selected: v === '2048' || undefined }, v)));
  const quality = h('input', { type: 'number', min: '0.5', max: '1', step: '0.05', value: '0.85', style: { width: '80px' } });
  const selected = () => imgs.filter((i) => checks.get(i.id)?.checked);
  const applyBtn = h('button', { class: 'btn primary' }, t('ui_manage_apply'));
  applyBtn.addEventListener('click', async () => {
    const targets = selected();
    if (!targets.length) return;
    const tt = toast(t('ui_optimizing'), { spinner: true });
    let saved = 0;
    try {
      S.beginTransaction();
      const done = new Map<string, { id: string; w: number; h: number }>();
      for (const it of targets) {
        let res = done.get(it.blobId);
        if (!res) {
          const blob = await getBlob(it.blobId);
          if (!blob) continue;
          const opt = await optimizeImage(blob, Number(maxSide.value), Number(quality.value));
          if (!opt.changed) continue;
          const newId = uid('b');
          await putBlob(newId, opt.blob, opt.w, opt.h);
          putBitmap(newId, await decodeImage(opt.blob));
          saved += blob.size - opt.blob.size;
          res = { id: newId, w: opt.w, h: opt.h };
          done.set(it.blobId, res);
        }
        const r = res;
        S.update(it.id, (x) => {
          if (x.kind !== 'image') return;
          const worldW = x.w * x.scale;
          x.blobId = r.id;
          x.naturalW = r.w;
          x.naturalH = r.h;
          x.w = r.w;
          x.h = r.h;
          x.scale = worldW / r.w;
        });
      }
      S.endTransaction();
    } finally {
      tt.close();
    }
    toast(`${t('ui_manage_total')}: −${bytesToHuman(Math.max(0, saved))}`);
    d.close();
  });
  const discardBtn = h('button', { class: 'btn' }, t('ui_manage_discard_crops'));
  discardBtn.addEventListener('click', () => {
    for (const it of selected()) if (it.crop) app.resetCrop(it.id);
    d.close();
  });
  const d = showDialog(
    [
      h('h2', null, t('ui_manage_images_title')),
      h('p', { class: 'hint' }, `${imgs.length} ${t('ui_items')} · ${t('ui_manage_total')}: ${bytesToHuman(total)}`),
      list,
      h('div', { class: 'row' }, h('label', null, t('ui_manage_downscale')), maxSide),
      h('div', { class: 'row' }, h('label', null, t('ui_optimize_quality')), quality),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => d.close() }, t('ui_cancel')), discardBtn, applyBtn)
    ],
    { wide: true }
  );
}
