/** Barra superior (título, guardar, jerarquía), barra inferior flotante y menús contextuales. */
import type { App } from '../app';
import { allCommands, commandTitle, formatShortcut, getCommand, runCommand } from '../core/commands';
import type { ItemId, Point } from '../core/model';
import { t } from '../i18n';
import { h, svg, clear } from './dom';
import { icons } from './icons';
import { showMenu, toast, type MenuEntry } from './dialogs';
import { aiAvailable } from '../ai/claude';
import { syncStatusIcon } from './accountDialog';

export class Toolbar {
  private top = document.getElementById('top-bar')!;
  private bottom = document.getElementById('toolbar')!;
  private titleEl!: HTMLElement;
  private buttons = new Map<string, HTMLButtonElement>();
  private syncIcon: { el: HTMLElement; destroy(): void } | null = null;

  constructor(private app: App) {
    this.rebuild();
    app.store.subscribe(() => this.refresh());
  }

  rebuild() {
    clear(this.top);
    clear(this.bottom);
    this.buttons.clear();
    this.syncIcon?.destroy();
    this.syncIcon = syncStatusIcon();
    const S = this.app.store;

    // --- superior
    this.titleEl = h('button', { class: 'title', onclick: () => runCommand('rename_scene') }, S.scene.name);
    const left = h(
      'div',
      { class: 'pill' },
      this.tb('open', 'open', () => runCommand('open')),
      this.titleEl,
      this.tb('save', 'save', () => runCommand('save'))
    );
    const right = h(
      'div',
      { class: 'pill' },
      this.tb('search', 'search', () => runCommand('command_palette')),
      this.tb('layers', 'layers', () => runCommand('toggle_hierarchy')),
      this.syncIcon.el,
      this.tb('more', 'more', (e) => this.showMainMenu(e.currentTarget as HTMLElement))
    );
    this.top.append(left, h('div', { class: 'spacer' }), right);

    // --- inferior
    const b = this.bottom;
    b.append(
      this.tb('plus', 'plus', (e) => this.showAddMenu(e.currentTarget as HTMLElement)),
      h('div', { class: 'sep' }),
      this.tb('select', 'select', () => runCommand('tool_select')),
      modifier(this.tb('multi', 'multi', () => this.toggleMulti())),
      phone(this.tb('lasso', 'lasso', () => runCommand('tool_lasso'))),
      phone(this.tb('hand', 'hand', () => runCommand('tool_pan'))),
      h('div', { class: 'sep' }),
      this.tb('pen', 'pen', () => runCommand('toggle_draw')),
      phone(this.tb('note', 'note', () => runCommand('tool_note'))),
      phone(this.tb('crop', 'crop', () => runCommand('crop'))),
      h('div', { class: 'sep' }),
      this.tb('undo', 'undo', () => runCommand('undo')),
      phone(this.tb('redo', 'redo', () => runCommand('redo'))),
      h('div', { class: 'sep' }),
      this.tb('arrange', 'arrange', (e) => this.showArrangeMenu(e.currentTarget as HTMLElement)),
      phone(this.tb('fit', 'fit', () => runCommand('zoom_fit'))),
      phone(this.tb('grid', 'grid', () => runCommand('toggle_grid'))),
      this.tb('selmenu', 'more', (e) => this.showSelectionMenu(e.currentTarget as HTMLElement))
    );
    this.refresh();
  }

  private hints = new Map<string, () => string | null>();

  private tb(id: string, icon: string, onClick: (e: MouseEvent) => void, title?: string): HTMLButtonElement {
    const btn = h('button', { class: 'tb', title: title ?? '', 'aria-label': title ?? id }, svg(icons[icon]));
    btn.addEventListener('click', (e) => {
      // un botón "apagado" sigue respondiendo: explica qué falta en vez de no hacer nada
      const hint = this.hints.get(id)?.();
      if (hint) {
        toast(hint, { ms: 1600 });
        return;
      }
      onClick(e);
    });
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.buttons.set(id, btn);
    return btn;
  }

  /** Registra el motivo por el que un botón está apagado (si devuelve texto, el botón se ve atenuado). */
  private hint(id: string, fn: () => string | null) {
    this.hints.set(id, fn);
  }

  private toggleMulti() {
    this.app.gestures.multiSelect = !this.app.gestures.multiSelect;
    this.refresh();
  }

  refresh() {
    const S = this.app.store;
    const g = this.app.gestures;
    if (!this.titleEl) return;
    this.titleEl.textContent = S.scene.name;
    this.titleEl.classList.toggle('dirty', S.dirty);
    const set = (id: string, active: boolean) => {
      const b = this.buttons.get(id);
      if (!b) return;
      b.classList.toggle('active', active);
      b.classList.toggle('dim', !!this.hints.get(id)?.());
    };
    this.hint('crop', () => (g.tool === 'crop' || S.selectedItems().filter((i) => i.kind === 'image').length === 1 ? null : t('ui_hint_crop_one_image')));
    this.hint('undo', () => (S.canUndo ? null : t('ui_hint_nothing_undo')));
    this.hint('redo', () => (S.canRedo ? null : t('ui_hint_nothing_redo')));
    this.hint('selmenu', () => (S.selection.size ? null : t('ui_hint_select_first')));
    set('select', g.tool === 'select');
    set('lasso', g.tool === 'lasso');
    set('hand', g.tool === 'pan');
    set('pen', g.tool === 'draw');
    set('crop', g.tool === 'crop');
    set('multi', g.multiSelect);
    set('undo', false);
    set('redo', false);
    set('grid', S.scene.settings.grid.enabled);
    set('layers', !this.app.hierarchy?.hidden);
    const selBtn = this.buttons.get('selmenu');
    if (selBtn) {
      set('selmenu', false);
      let badge = selBtn.querySelector('.badge');
      if (S.selection.size > 0) {
        if (!badge) {
          badge = h('span', { class: 'badge' });
          selBtn.appendChild(badge);
        }
        badge.textContent = String(S.selection.size);
      } else badge?.remove();
    }
    const save = this.buttons.get('save');
    if (save) save.classList.toggle('active', false);
  }

  // ---------------------------------------------------------------------
  // menús

  private entry(id: string, extra: Partial<MenuEntry> = {}): MenuEntry {
    const c = getCommand(id);
    if (!c) return { label: id, run: () => void runCommand(id) };
    return {
      label: commandTitle(c),
      icon: c.icon,
      kbd: c.shortcut && !this.app.isTouch() ? formatShortcut(c.shortcut) : undefined,
      disabled: c.enabled ? !c.enabled() : false,
      run: () => void runCommand(id),
      ...extra
    };
  }

  showAddMenu(anchor: HTMLElement) {
    const entries: MenuEntry[] = [
      this.entry('import_images'),
      this.entry('import_url'),
      this.entry('import_pinterest'),
      this.entry('paste'),
      { sep: true },
      this.entry('tool_note'),
      this.entry('toggle_draw'),
      this.entry('tool_lasso'),
      this.entry('tool_pan'),
      { sep: true },
      this.entry('import_scene_file')
    ];
    void showMenu(entries, anchor);
  }

  showArrangeMenu(anchor: HTMLElement) {
    const entries: MenuEntry[] = [
      { header: t('ui_arrange') },
      this.entry('arrange_optimal'),
      this.entry('arrange_masonry'),
      this.entry('arrange_grid'),
      this.entry('arrange_horizontal'),
      this.entry('arrange_vertical'),
      this.entry('arrange_by_color'),
      this.entry('arrange_random'),
      { sep: true },
      this.entry('normalize_size'),
      this.entry('normalize_area'),
      { sep: true },
      {
        label: t('cmd_align_left').split(' ')[0] + '…',
        icon: 'alignL',
        children: [
          this.entry('align_left'),
          this.entry('align_center_h'),
          this.entry('align_right'),
          this.entry('align_top'),
          this.entry('align_center_v'),
          this.entry('align_bottom'),
          { sep: true },
          this.entry('distribute_h'),
          this.entry('distribute_v'),
          this.entry('stack_h'),
          this.entry('stack_v')
        ]
      }
    ];
    void showMenu(entries, anchor);
  }

  showMainMenu(anchor: HTMLElement) {
    const S = this.app.store;
    const entries: MenuEntry[] = [
      this.entry('undo'),
      this.entry('redo'),
      this.entry('zoom_fit'),
      { sep: true },
      this.entry('new'),
      this.entry('open'),
      this.entry('save'),
      this.entry('rename_scene'),
      { sep: true },
      this.entry('import_pinterest'),
      this.entry('export_png'),
      this.entry('export_scene_file'),
      this.entry('manage_images'),
      { sep: true },
      this.entry('toggle_grid', { checked: S.scene.settings.grid.enabled }),
      this.entry('toggle_snap', { checked: S.scene.settings.grid.snap }),
      this.entry('canvas_color'),
      this.entry('show_all'),
      { sep: true },
      this.entry('find_duplicates'),
      this.entry('ornaments'),
      ...(aiAvailable() ? [this.entry('ai_describe'), this.entry('ai_organize')] : []),
      { sep: true },
      this.entry('shortcuts'),
      this.entry('settings')
    ];
    void showMenu(entries, anchor);
  }

  showSelectionMenu(anchor: HTMLElement | Point) {
    const S = this.app.store;
    const sel = S.selectedItems();
    const hasImg = sel.some((i) => i.kind === 'image');
    const hasGroup = sel.some((i) => i.kind === 'group');
    const anyLocked = sel.some((i) => i.locked);
    const one = this.app.roots().length === 1;
    const entries: MenuEntry[] = [
      ...(one ? [this.entry('edit_item'), this.entry('rename'), this.entry('comment')] : []),
      { sep: true },
      this.entry('copy'),
      this.entry('cut'),
      this.entry('duplicate'),
      this.entry('copy_as_image'),
      this.entry('export_selection_png'),
      { sep: true },
      ...(hasImg ? [this.entry('crop'), this.entry('discard_crop'), this.entry('replace_image'), this.entry('extract_palette'), this.entry('add_palette_note')] : []),
      ...(hasImg && aiAvailable() ? [this.entry('ai_tag'), this.entry('ai_organize')] : []),
      ...(hasImg ? [this.entry('ai_find_similar')] : []),
      this.entry('connect_items'),
      { sep: true },
      {
        label: t('ui_more'),
        icon: 'more',
        children: [
          this.entry('flip_h'),
          this.entry('flip_v'),
          this.entry('rotate_cw'),
          this.entry('rotate_ccw'),
          this.entry('reset_transform'),
          this.entry('opacity'),
          { sep: true },
          this.entry('bring_front'),
          this.entry('send_back'),
          { sep: true },
          this.entry('zoom_selection')
        ]
      },
      this.entry('group'),
      ...(hasGroup ? [this.entry('ungroup')] : []),
      this.entry('parent'),
      this.entry('unparent'),
      anyLocked ? this.entry('unlock') : this.entry('lock'),
      this.entry('hide'),
      { sep: true },
      this.entry('delete', { danger: true })
    ];
    void showMenu(compact(entries), anchor);
  }

  /** Menú contextual del lienzo (pulsación larga / clic derecho). */
  showContextMenu(p: Point, itemId: ItemId | null) {
    const r = this.app.canvas.getBoundingClientRect();
    const at = { x: p.x + r.left, y: p.y + r.top };
    if (itemId) {
      this.showSelectionMenu(at);
      return;
    }
    const S = this.app.store;
    const entries: MenuEntry[] = [
      this.entry('paste'),
      this.entry('import_images'),
      this.entry('tool_note', { run: () => void this.app.createNote(this.sceneAt(p)) }),
      { sep: true },
      this.entry('select_all'),
      this.entry('zoom_fit'),
      this.entry('arrange_optimal'),
      this.entry('arrange_masonry'),
      this.entry('ornaments'),
      { sep: true },
      this.entry('toggle_grid', { checked: S.scene.settings.grid.enabled }),
      this.entry('canvas_color'),
      this.entry('settings')
    ];
    void showMenu(entries, at);
  }

  private sceneAt(p: Point): Point {
    const v = this.app.store.scene.viewport;
    return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom };
  }

  /** Lista para la paleta: todos los comandos con título y categoría. */
  allEntries() {
    return allCommands();
  }
}

/** Marca un botón como modificador (no herramienta): activo se muestra con anillo, no relleno. */
function modifier<T extends HTMLElement>(el: T): T {
  el.classList.add('modifier');
  return el;
}

/** Marca un botón como secundario: en teléfonos se oculta (CSS) y queda en los menús. */
function phone<T extends HTMLElement>(el: T): T {
  el.dataset.phoneHide = '';
  return el;
}

/** Elimina separadores duplicados o al principio/final. */
function compact(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (e.sep && (out.length === 0 || out[out.length - 1].sep)) continue;
    out.push(e);
  }
  while (out.length && out[out.length - 1].sep) out.pop();
  return out;
}
