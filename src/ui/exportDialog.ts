/** Exportar escena o selección como PNG/JPEG (compartir en iOS o descargar). */
import type { App } from '../app';
import { t } from '../i18n';
import { h } from './dom';
import { showDialog, toast } from './dialogs';
import { exportSet, renderItemsToBlob, safeFileName, shareOrDownload } from '../features/exportImage';

export function showExportDialog(app: App, mode: 'scene' | 'selection') {
  const S = app.store;
  const includeChildren = h('input', { type: 'checkbox' });
  includeChildren.checked = true;
  const scale = h('select', null, ...['0.5', '1', '2'].map((v) => h('option', { value: v, selected: v === '1' || undefined }, `${v}×`)));
  const bg = h('select', null,
    h('option', { value: 'canvas' }, t('ui_canvas_color')),
    h('option', { value: 'transparent' }, t('ui_transparent')),
    h('option', { value: '#ffffff' }, '#ffffff'),
    h('option', { value: '#000000' }, '#000000')
  );
  const format = h('select', null, h('option', { value: 'image/png' }, 'PNG'), h('option', { value: 'image/jpeg' }, 'JPEG'));
  const go = h('button', { class: 'btn primary' }, t('ui_ok'));
  go.addEventListener('click', async () => {
    d.close();
    const tt = toast(t('ui_exporting'), { spinner: true });
    try {
      const roots = mode === 'selection' ? app.roots() : S.scene.items.filter((i) => !i.parentId);
      const items = exportSet(S, roots, mode === 'selection' ? includeChildren.checked : true);
      const bgv = bg.value === 'canvas' ? S.scene.settings.canvasColor : bg.value;
      const r = await renderItemsToBlob(app.renderer, items, {
        includeChildren: includeChildren.checked,
        scale: Number(scale.value),
        background: bgv === 'transparent' ? (format.value === 'image/jpeg' ? '#ffffff' : null) : bgv,
        format: format.value as 'image/png' | 'image/jpeg'
      });
      if (!r) return;
      const ext = format.value === 'image/png' ? 'png' : 'jpg';
      await shareOrDownload(r.blob, `${safeFileName(S.scene.name)}${mode === 'selection' ? '-seleccion' : ''}.${ext}`, S.scene.name);
    } catch (e) {
      toast(String(e), { error: true });
    } finally {
      tt.close();
    }
  });
  const d = showDialog([
    h('h2', null, mode === 'scene' ? t('cmd_export_png') : t('cmd_export_selection_png')),
    mode === 'selection' ? h('div', { class: 'row' }, h('label', null, t('ui_export_include_children')), includeChildren) : null,
    h('div', { class: 'row' }, h('label', null, t('ui_export_scale')), scale),
    h('div', { class: 'row' }, h('label', null, t('ui_export_bg')), bg),
    h('div', { class: 'row' }, h('label', null, t('ui_manage_format')), format),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => d.close() }, t('ui_cancel')), go)
  ]);
}
