/** Editor de notas: textarea superpuesta al ítem + barra de formato. */
import type { App } from '../app';
import type { NoteItem } from '../core/model';
import { t } from '../i18n';
import { h, svg } from './dom';
import { icons } from './icons';

const BG_PRESETS = ['#2b2b2bcc', '#fff8b3', '#ffd6d6', '#d6f0ff', '#dcf8d6', 'transparent'];

export function openNoteEditor(app: App, note: NoteItem) {
  const root = document.getElementById('overlay-root')!;
  const S = app.store;
  const initial = note.text;
  app.store.beginTransaction();

  const wrap = h('div', { class: 'note-editor' });
  const ta = h('textarea', { placeholder: t('ui_note_placeholder'), autocapitalize: 'sentences' });
  ta.value = note.text;
  wrap.appendChild(ta);

  const layout = () => {
    const it = app.noteFor(note.id);
    if (!it) return;
    const v = S.scene.viewport;
    const w = it.w * it.scale * v.zoom;
    const hgt = it.h * it.scale * v.zoom;
    const cx = it.x * v.zoom + v.x;
    const cy = it.y * v.zoom + v.y;
    const r = app.canvas.getBoundingClientRect();
    Object.assign(wrap.style, { left: `${r.left + cx - w / 2}px`, top: `${r.top + cy - hgt / 2}px`, width: `${w}px`, height: `${hgt}px`, transform: `rotate(${it.rotation}rad)` });
    const pad = it.fontSize * 0.6 * it.scale * v.zoom;
    Object.assign(ta.style, {
      font: `${it.fontSize * it.scale * v.zoom}px ${it.fontFamily}`,
      color: it.color,
      background: it.background === 'transparent' ? 'rgba(127,127,127,0.2)' : it.background,
      padding: `${pad}px`,
      textAlign: it.align
    });
  };

  const apply = () => {
    S.update(note.id, (it) => {
      if (it.kind === 'note') it.text = ta.value;
    });
    app.renderer.invalidateNoteLayout(note.id);
    app.renderer.draw();
    layout();
  };
  ta.addEventListener('input', apply);

  // barra de formato
  const bar = h('div', { class: 'fmt-bar' });
  const btn = (icon: string, title: string, fn: () => void) => {
    const b = h('button', { class: 'tb', title }, svg(icons[icon]));
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', fn);
    return b;
  };
  const wrapSel = (pre: string, post = pre) => {
    const s = ta.selectionStart, e = ta.selectionEnd;
    const v = ta.value;
    ta.value = v.slice(0, s) + pre + v.slice(s, e) + post + v.slice(e);
    ta.setSelectionRange(s + pre.length, e + pre.length);
    apply();
    ta.focus();
  };
  const toggleBullets = () => {
    const s = ta.selectionStart, e = ta.selectionEnd;
    const v = ta.value;
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    const le = v.indexOf('\n', e) === -1 ? v.length : v.indexOf('\n', e);
    const block = v.slice(ls, le);
    const lines = block.split('\n');
    const all = lines.every((l) => /^\s*- /.test(l));
    const out = lines.map((l) => (all ? l.replace(/^\s*- /, '') : '- ' + l)).join('\n');
    ta.value = v.slice(0, ls) + out + v.slice(le);
    apply();
    ta.focus();
  };
  const setProp = (fn: (it: NoteItem) => void) => {
    S.update(note.id, (it) => {
      if (it.kind === 'note') fn(it);
    });
    app.renderer.invalidateNoteLayout(note.id);
    layout();
  };
  const fontMinus = btn('zoomOut', t('ui_font_size'), () => setProp((it) => (it.fontSize = Math.max(8, it.fontSize - 2))));
  const fontPlus = btn('zoomIn', t('ui_font_size'), () => setProp((it) => (it.fontSize = Math.min(120, it.fontSize + 2))));
  const color = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(note.color) ? note.color : '#f2f2f2', title: t('ui_text_color') });
  color.addEventListener('input', () => setProp((it) => (it.color = color.value)));
  const alignBtn = btn('alignL', t('ui_align'), () => setProp((it) => (it.align = it.align === 'left' ? 'center' : it.align === 'center' ? 'right' : 'left')));
  bar.append(
    btn('bold', t('ui_bold'), () => wrapSel('**')),
    btn('italic', t('ui_italic'), () => wrapSel('*')),
    btn('list', t('ui_list'), toggleBullets),
    btn('link', t('ui_link'), () => wrapSel('[', '](https://)')),
    h('div', { class: 'sep' }),
    fontMinus,
    fontPlus,
    alignBtn,
    color,
    h('div', { class: 'sep' })
  );
  for (const bg of BG_PRESETS) {
    const s = h('button', { class: 'swatch', style: { background: bg === 'transparent' ? 'repeating-linear-gradient(45deg,#888 0 4px,#444 4px 8px)' : bg } });
    s.addEventListener('pointerdown', (e) => e.preventDefault());
    s.addEventListener('click', () => setProp((it) => {
      it.background = bg;
      if (bg !== 'transparent' && bg !== '#2b2b2bcc') it.color = '#111';
      if (bg === '#2b2b2bcc') it.color = '#f2f2f2';
    }));
    bar.appendChild(s);
  }
  bar.appendChild(h('div', { class: 'sep' }));
  const del = btn('trash', t('ui_delete'), () => {
    finish(true);
    S.commit(() => S.removeItems([note.id]));
  });
  del.classList.add('warn');
  bar.append(del, btn('check', t('ui_ok'), () => finish(false)));

  const scrim = h('div', { class: 'scrim transparent' });
  let done = false;
  const finish = (cancelled: boolean) => {
    if (done) return;
    done = true;
    scrim.remove();
    wrap.remove();
    bar.remove();
    unsub();
    document.removeEventListener('keydown', onKey, true);
    if (cancelled) {
      S.cancelTransaction();
      return;
    }
    const it = app.noteFor(note.id);
    if (it && !it.text.trim() && !initial.trim()) {
      S.cancelTransaction();
      S.commit(() => S.removeItems([note.id]));
      return;
    }
    S.endTransaction();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      finish(false);
    }
    e.stopPropagation();
  };
  scrim.addEventListener('pointerdown', () => finish(false));
  document.addEventListener('keydown', onKey, true);
  const unsub = S.subscribe((e) => {
    if (e.type === 'viewport' || e.type === 'items') layout();
  });
  root.append(scrim, wrap, bar);
  layout();
  setTimeout(() => {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, 30);
}
