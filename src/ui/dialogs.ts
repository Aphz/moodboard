/** Diálogos modales, menús contextuales y avisos (toasts). */
import { t } from '../i18n';
import { h, svg, clear, type Child } from './dom';
import { icons } from './icons';

const root = () => document.getElementById('overlay-root')!;
const toastRoot = () => document.getElementById('toast-root')!;

export interface MenuEntry {
  label?: string;
  icon?: string;
  kbd?: string;
  danger?: boolean;
  disabled?: boolean;
  sep?: boolean;
  header?: string;
  checked?: boolean;
  run?: () => void | Promise<void>;
  /** submenú */
  children?: MenuEntry[];
}

let openMenuClose: (() => void) | null = null;

export function closeMenus() {
  openMenuClose?.();
  openMenuClose = null;
}

/** Muestra un menú anclado en (x,y) de pantalla o bajo un elemento. */
export function showMenu(entries: MenuEntry[], anchor: { x: number; y: number } | HTMLElement): Promise<void> {
  closeMenus();
  return new Promise((resolve) => {
    const scrim = h('div', { class: 'scrim transparent' });
    const menu = h('div', { class: 'menu', role: 'menu' });
    const close = () => {
      scrim.remove();
      menu.remove();
      openMenuClose = null;
      resolve();
    };
    openMenuClose = close;
    scrim.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      close();
    });
    const build = (list: MenuEntry[], into: HTMLElement) => {
      for (const en of list) {
        if (en.sep) {
          into.appendChild(h('div', { class: 'menu-sep' }));
          continue;
        }
        if (en.header) {
          into.appendChild(h('div', { class: 'menu-label' }, en.header));
          continue;
        }
        const btn = h(
          'button',
          { class: `menu-item${en.danger ? ' danger' : ''}`, disabled: en.disabled, role: 'menuitem' },
          en.icon ? svg(icons[en.icon] ?? '', 18) : h('span', { style: { width: '18px' } }),
          h('span', null, en.label ?? ''),
          en.checked ? svg(icons.check, 16) : null,
          en.kbd ? h('span', { class: 'kbd' }, en.kbd) : null,
          en.children ? svg(icons.chevronR, 16) : null
        );
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (en.children) {
            const r = btn.getBoundingClientRect();
            close();
            await showMenu(en.children, { x: r.left + 12, y: r.top });
            return;
          }
          close();
          await en.run?.();
        });
        into.appendChild(btn);
      }
    };
    build(entries, menu);
    root().append(scrim, menu);
    // posicionar
    let x: number, y: number;
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect();
      x = r.left;
      y = r.bottom + 6;
      const mh = menu.offsetHeight;
      if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
    } else {
      x = anchor.x;
      y = anchor.y;
    }
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    x = Math.min(Math.max(8, x), innerWidth - mw - 8);
    y = Math.min(Math.max(8, y), innerHeight - mh - 8);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  });
}

export interface DialogHandle {
  el: HTMLElement;
  close: () => void;
}

/** Diálogo modal genérico. `content` puede ser cualquier nodo. */
export function showDialog(content: Child, opts: { wide?: boolean; onClose?: () => void; dismissable?: boolean } = {}): DialogHandle {
  closeMenus();
  const scrim = h('div', { class: 'scrim' });
  const dlg = h('div', { class: `dialog${opts.wide ? ' wide' : ''}`, role: 'dialog' }, content);
  const close = () => {
    scrim.remove();
    dlg.remove();
    document.removeEventListener('keydown', onKey);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && opts.dismissable !== false) {
      e.stopPropagation();
      close();
    }
  };
  if (opts.dismissable !== false) scrim.addEventListener('pointerdown', close);
  document.addEventListener('keydown', onKey);
  root().append(scrim, dlg);
  return { el: dlg, close };
}

export function confirmDialog(message: string, opts: { okLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const d = showDialog(
      [
        h('p', null, message),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn', onclick: () => (d.close(), resolve(false)) }, t('ui_cancel')),
          h('button', { class: `btn ${opts.danger ? 'danger' : 'primary'}`, onclick: () => (d.close(), resolve(true)) }, opts.okLabel ?? t('ui_ok'))
        )
      ],
      { onClose: () => resolve(false) }
    );
  });
}

/** Tres opciones: guardar / descartar / cancelar. */
export function saveDiscardDialog(message: string): Promise<'save' | 'discard' | 'cancel'> {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v: 'save' | 'discard' | 'cancel') => {
      if (done) return;
      done = true;
      d.close();
      resolve(v);
    };
    const d = showDialog(
      [
        h('p', null, message),
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn', onclick: () => fin('cancel') }, t('ui_cancel')),
          h('button', { class: 'btn danger', onclick: () => fin('discard') }, t('ui_discard')),
          h('button', { class: 'btn primary', onclick: () => fin('save') }, t('ui_save'))
        )
      ],
      { onClose: () => fin('cancel') }
    );
  });
}

export function promptDialog(title: string, initial = '', opts: { type?: string; placeholder?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: opts.type ?? 'text', value: initial, placeholder: opts.placeholder ?? '', autocomplete: 'off', autocapitalize: 'off' });
    let done = false;
    const fin = (v: string | null) => {
      if (done) return;
      done = true;
      d.close();
      resolve(v);
    };
    const d = showDialog(
      [
        h('h2', null, title),
        h('form', { onsubmit: (e: Event) => (e.preventDefault(), fin(input.value)) }, input,
          h('div', { class: 'actions' },
            h('button', { class: 'btn', type: 'button', onclick: () => fin(null) }, t('ui_cancel')),
            h('button', { class: 'btn primary', type: 'submit' }, t('ui_ok'))
          )
        )
      ],
      { onClose: () => fin(null) }
    );
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  });
}

export interface ToastHandle {
  update(msg: string): void;
  close(): void;
}

export function toast(
  message: string,
  opts: { error?: boolean; ms?: number; spinner?: boolean; action?: { label: string; run: () => void } } = {}
): ToastHandle {
  // el botón permite deshacer lo que acaba de pasar sin ir a buscar el comando
  const button = opts.action ? h('button', { class: 'toast-action' }, opts.action.label) : null;
  const el = h(
    'div',
    { class: `toast${opts.error ? ' error' : ''}` },
    opts.spinner ? h('div', { class: 'spin' }) : null,
    h('span', null, message),
    button
  );
  toastRoot().appendChild(el);
  let timer = 0;
  const close = () => {
    clearTimeout(timer);
    el.remove();
  };
  if (button && opts.action) {
    const run = opts.action.run;
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
      run();
    });
  }
  if (!opts.spinner) timer = window.setTimeout(close, opts.ms ?? 2600);
  el.addEventListener('click', close);
  return {
    update(msg) {
      const span = el.querySelector('span');
      if (span) span.textContent = msg;
    },
    close
  };
}

export function clearOverlays() {
  closeMenus();
  clear(root());
}
