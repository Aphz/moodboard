/** Panel de jerarquía: árbol de ítems con selección, visibilidad, bloqueo y búsqueda. */
import type { App } from '../app';
import { childrenOf, type Item, type ItemId } from '../core/model';
import { t } from '../i18n';
import { h, svg, clear } from './dom';
import { icons } from './icons';
import { getBitmap } from '../render/imageCache';

export class HierarchyPanel {
  private el = document.getElementById('hierarchy')!;
  private tree!: HTMLElement;
  private query = '';
  private collapsed = new Set<ItemId>();
  hidden = true;
  private pendingRefresh = 0;

  constructor(private app: App) {
    this.build();
    app.store.subscribe(() => this.scheduleRefresh());
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  toggle() {
    this.hidden = !this.hidden;
    this.el.hidden = this.hidden;
    if (!this.hidden) this.refresh();
    this.app.toolbar.refresh();
  }

  private build() {
    clear(this.el);
    const search = h('input', { type: 'text', placeholder: t('ui_search'), autocomplete: 'off' });
    search.addEventListener('input', () => {
      this.query = search.value.toLowerCase();
      this.refresh();
    });
    const closeBtn = h('button', { class: 'tb', style: { width: '36px', height: '36px' } }, svg(icons.x, 18));
    closeBtn.addEventListener('click', () => this.toggle());
    this.tree = h('div', { class: 'tree' });
    this.el.append(
      h('header', null, h('span', { style: { flex: '1' } }, t('ui_hierarchy')), closeBtn),
      h('div', { class: 'search' }, search),
      this.tree
    );
  }

  private scheduleRefresh() {
    if (this.hidden) return;
    if (this.pendingRefresh) return;
    this.pendingRefresh = requestAnimationFrame(() => {
      this.pendingRefresh = 0;
      this.refresh();
    });
  }

  refresh() {
    if (this.hidden) return;
    clear(this.tree);
    const S = this.app.store;
    const render = (parent: ItemId | null, depth: number) => {
      const kids = childrenOf(S.scene, parent).slice().reverse(); // arriba = al frente
      for (const it of kids) {
        const hasKids = S.scene.items.some((i) => i.parentId === it.id);
        const matches = !this.query || it.name.toLowerCase().includes(this.query) || it.tags.some((tg) => tg.toLowerCase().includes(this.query)) || (it.kind === 'note' && it.text.toLowerCase().includes(this.query));
        if (matches) this.tree.appendChild(this.row(it, depth, hasKids));
        if (hasKids && (!this.collapsed.has(it.id) || this.query)) render(it.id, depth + 1);
      }
    };
    render(null, 0);
  }

  private row(it: Item, depth: number, hasKids: boolean): HTMLElement {
    const S = this.app.store;
    const sel = S.selection.has(it.id);
    const caret = h('span', { class: 'caret' }, hasKids ? (this.collapsed.has(it.id) ? '▸' : '▾') : '');
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.collapsed.has(it.id)) this.collapsed.delete(it.id);
      else this.collapsed.add(it.id);
      this.refresh();
    });
    const mini = h('div', { class: 'mini' });
    if (it.kind === 'image') {
      const bmp = getBitmap(it.blobId);
      if (bmp) {
        const c = document.createElement('canvas');
        c.width = 56;
        c.height = 56;
        const ctx = c.getContext('2d')!;
        const s = Math.max(56 / bmp.width, 56 / bmp.height);
        ctx.drawImage(bmp, (56 - bmp.width * s) / 2, (56 - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
        mini.appendChild(c);
      } else mini.appendChild(svg(icons.image, 16));
    } else mini.appendChild(svg(icons[it.kind === 'note' ? 'note' : it.kind === 'drawing' ? 'drawing' : 'group'], 16));

    const flags = h('div', { class: 'flags' });
    const vis = h('button', { class: it.visible ? '' : 'on', title: t('ui_hidden') }, svg(it.visible ? icons.eye : icons.eyeOff, 15));
    vis.addEventListener('click', (e) => {
      e.stopPropagation();
      S.commit(() => S.update(it.id, (i) => (i.visible = !i.visible)));
    });
    const lock = h('button', { class: it.locked ? 'on' : '', title: t('ui_locked') }, svg(it.locked ? icons.lock : icons.unlock, 15));
    lock.addEventListener('click', (e) => {
      e.stopPropagation();
      S.commit(() => S.update(it.id, (i) => (i.locked = !i.locked)));
    });
    flags.append(vis, lock);

    const name = h('span', { class: 'name' }, it.name + (it.kind === 'image' && it.crop ? ' ✂' : ''));
    const row = h('div', { class: `tree-row${sel ? ' selected' : ''}${it.visible ? '' : ' hidden-item'}`, style: { paddingLeft: `${6 + depth * 14}px` }, title: it.comment || it.name }, caret, mini, name, flags);
    row.addEventListener('click', (e) => {
      const additive = e.shiftKey || e.metaKey || e.ctrlKey || this.app.gestures.multiSelect;
      S.select([it.id], additive ? 'toggle' : 'replace');
    });
    row.addEventListener('dblclick', () => this.app.editItem(it.id));
    // pulsación larga → menú
    let timer = 0;
    row.addEventListener('pointerdown', (e) => {
      timer = window.setTimeout(() => {
        if (!S.selection.has(it.id)) S.select([it.id]);
        this.app.toolbar.showSelectionMenu({ x: e.clientX, y: e.clientY });
      }, 500);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) row.addEventListener(ev, () => clearTimeout(timer));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!S.selection.has(it.id)) S.select([it.id]);
      this.app.toolbar.showSelectionMenu({ x: e.clientX, y: e.clientY });
    });
    return row;
  }
}
