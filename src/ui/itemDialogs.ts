/** Diálogos de ítem: comentario+etiquetas, opacidad, paleta, color del lienzo, atajos. */
import type { App } from '../app';
import type { ImageItem, Item } from '../core/model';
import { allCommands, commandTitle, formatShortcut } from '../core/commands';
import { t } from '../i18n';
import { h, clear } from './dom';
import { showDialog, toast } from './dialogs';
import { contrastText } from '../features/palette';
import { copyTextToSystemClipboard } from '../features/clipboard';

export function showCommentDialog(app: App, item: Item) {
  const S = app.store;
  const ta = h('textarea', { rows: '6', placeholder: t('ui_comment_placeholder') });
  ta.value = item.comment;
  const tags = h('div', null);
  const tagInput = h('input', { type: 'text', placeholder: t('ui_add_tag'), autocapitalize: 'none' });
  let current = [...item.tags];
  const renderTags = () => {
    clear(tags);
    for (const tg of current) {
      const rm = h('button', null, '×');
      rm.addEventListener('click', () => {
        current = current.filter((x) => x !== tg);
        renderTags();
      });
      tags.appendChild(h('span', { class: 'tag' }, tg, rm));
    }
  };
  renderTags();
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = tagInput.value.trim().toLowerCase().replace(/^#/, '');
      if (v && !current.includes(v)) current.push(v);
      tagInput.value = '';
      renderTags();
    }
  });
  const d = showDialog([
    h('h2', null, item.name),
    ta,
    h('h3', null, t('ui_tags')),
    tags,
    tagInput,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => d.close() }, t('ui_cancel')),
      h('button', {
        class: 'btn primary',
        onclick: () => {
          const pending = tagInput.value.trim().toLowerCase().replace(/^#/, '');
          if (pending && !current.includes(pending)) current.push(pending);
          S.commit(() => S.update(item.id, (i) => {
            i.comment = ta.value;
            i.tags = current;
          }));
          d.close();
        }
      }, t('ui_ok'))
    )
  ]);
  setTimeout(() => ta.focus(), 30);
}

export function showOpacityDialog(app: App) {
  const S = app.store;
  const ids = [...S.selection];
  const first = S.get(ids[0]);
  const range = h('input', { type: 'range', min: '0.05', max: '1', step: '0.05', value: String(first?.opacity ?? 1) });
  S.beginTransaction();
  range.addEventListener('input', () => S.update(ids, (i) => (i.opacity = Number(range.value))));
  const d = showDialog([
    h('h2', null, t('ui_opacity')),
    range,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => d.close() }, t('ui_ok')))
  ], { onClose: () => S.endTransaction() });
}

export function showPaletteDialog(app: App) {
  const imgs = app.store.selectedItems().filter((i): i is ImageItem => i.kind === 'image');
  const rows = imgs.map((img) =>
    h('div', null,
      h('div', { class: 'hint' }, img.name),
      h('div', { class: 'palette-row' }, ...img.palette.map((c) => {
        const sw = h('button', { class: 'sw', style: { background: c, color: contrastText(c) } }, c);
        sw.addEventListener('click', async () => {
          if (await copyTextToSystemClipboard(c)) toast(`${t('ui_copied')} ${c}`, { ms: 900 });
        });
        return sw;
      }))
    )
  );
  const d = showDialog([
    h('h2', null, t('ui_palette')),
    ...rows,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => { d.close(); app.addPaletteNote(); } }, t('cmd_add_palette_note')),
      h('button', { class: 'btn primary', onclick: () => d.close() }, t('ui_close'))
    )
  ]);
}

export function showCanvasColorDialog(app: App) {
  const S = app.store;
  const presets = ['#1e1e1e', '#000000', '#2d2d30', '#3a3a3a', '#ffffff', '#f5f0e6', '#e8eef5', 'transparent'];
  const current = S.scene.settings.canvasColor;
  const color = h('input', { type: 'color', value: current === 'transparent' ? '#1e1e1e' : current });
  color.addEventListener('input', () => S.updateSettings((s) => (s.canvasColor = color.value)));
  const d = showDialog([
    h('h2', null, t('ui_canvas_color')),
    h('div', { class: 'palette-row' }, ...presets.map((c) => {
      const sw = h('button', { class: 'sw', style: { background: c === 'transparent' ? 'repeating-linear-gradient(45deg,#888 0 6px,#444 6px 12px)' : c, minHeight: '44px' } });
      sw.addEventListener('click', () => S.updateSettings((s) => (s.canvasColor = c)));
      return sw;
    })),
    h('div', { class: 'row' }, h('label', null, t('ui_canvas_color')), color),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => d.close() }, t('ui_ok')))
  ]);
}

export function showShortcutsDialog() {
  const seen = new Set<string>();
  const rows = allCommands()
    .filter((c) => c.shortcut && !seen.has(c.title) && seen.add(c.title))
    .map((c) => h('tr', null, h('td', null, commandTitle(c)), h('td', null, formatShortcut(c.shortcut!))));
  const d = showDialog([
    h('h2', null, t('ui_shortcuts_title')),
    h('h3', null, t('ui_gesture_help')),
    h('p', { class: 'hint' }, [t('ui_gesture_pan'), t('ui_gesture_zoom'), t('ui_gesture_select'), t('ui_gesture_multi'), t('ui_gesture_rotate')].join(' · ')),
    h('h3', null, t('ui_shortcuts_title')),
    h('table', { class: 'kbd-table' }, ...rows),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => d.close() }, t('ui_close')))
  ]);
}
