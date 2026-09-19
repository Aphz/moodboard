/** Paleta de comandos con búsqueda difusa. */
import type { App } from '../app';
import { allCommands, commandTitle, formatShortcut, runCommand, type Command } from '../core/commands';
import { t, type MsgKey } from '../i18n';
import { h, svg, clear } from './dom';
import { icons } from './icons';

function score(q: string, text: string): number {
  if (!q) return 1;
  const tl = text.toLowerCase();
  if (tl.includes(q)) return 10 + (tl.startsWith(q) ? 5 : 0);
  // subsecuencia
  let i = 0;
  for (const ch of tl) if (ch === q[i]) i++;
  return i === q.length ? 1 : 0;
}

export function showCommandPalette(app: App) {
  const root = document.getElementById('overlay-root')!;
  const scrim = h('div', { class: 'scrim' });
  const input = h('input', { type: 'text', placeholder: t('ui_search_commands'), autocomplete: 'off', autocapitalize: 'off' });
  const list = h('div', { class: 'list' });
  const box = h('div', { class: 'cmdp' }, input, list);
  let items: Command[] = [];
  let cursor = 0;
  const close = () => {
    scrim.remove();
    box.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const seen = new Set<string>();
  const unique = allCommands().filter((c) => {
    const k = c.title + '|' + c.category;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const render = () => {
    const q = input.value.trim().toLowerCase();
    items = unique
      .map((c) => ({ c, s: score(q, commandTitle(c)) + score(q, t(`ui_category_${c.category}` as MsgKey)) * 0.5 }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c)
      .slice(0, 40);
    cursor = 0;
    clear(list);
    if (!items.length) list.appendChild(h('div', { class: 'menu-label' }, t('ui_no_results')));
    items.forEach((c, i) => {
      const enabled = c.enabled ? c.enabled() : true;
      const row = h(
        'button',
        { class: `menu-item${i === cursor ? ' hover' : ''}`, disabled: !enabled },
        c.icon ? svg(icons[c.icon] ?? '', 18) : h('span', { style: { width: '18px' } }),
        h('span', null, commandTitle(c)),
        h('span', { class: 'kbd' }, t(`ui_category_${c.category}` as MsgKey) + (c.shortcut && !app.isTouch() ? '  ' + formatShortcut(c.shortcut) : ''))
      );
      row.addEventListener('click', () => {
        close();
        void runCommand(c.id);
      });
      list.appendChild(row);
    });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length);
      [...list.children].forEach((el, i) => el.classList.toggle('hover', i === cursor));
      (list.children[cursor] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = items[cursor];
      if (c && (!c.enabled || c.enabled())) {
        close();
        void runCommand(c.id);
      }
    }
  };
  input.addEventListener('input', render);
  document.addEventListener('keydown', onKey, true);
  scrim.addEventListener('pointerdown', close);
  root.append(scrim, box);
  render();
  setTimeout(() => input.focus(), 30);
}
