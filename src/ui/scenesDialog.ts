/** Selector de escenas (recientes con miniaturas), nueva, importar, eliminar. */
import type { App } from '../app';
import { listScenes } from '../core/persistence';
import { t } from '../i18n';
import { h, svg, clear } from './dom';
import { icons } from './icons';
import { showDialog, showMenu } from './dialogs';
import { getSyncState, isConnected, onSyncState, syncNow } from '../sync';

export async function showScenesDialog(app: App) {
  const grid = h('div', { class: 'grid-list' });
  const status = h('div', { class: 'hint sync-hint', 'aria-live': 'polite' });
  let offSync: (() => void) | null = null;
  let closed = false;
  /** URLs de miniaturas vivas, para liberarlas al repintar o cerrar. */
  let thumbUrls: string[] = [];
  const releaseThumbs = () => {
    for (const u of thumbUrls) URL.revokeObjectURL(u);
    thumbUrls = [];
  };
  const d = showDialog([h('h2', null, t('ui_recent')), status, grid], {
    wide: true,
    onClose: () => {
      closed = true;
      offSync?.();
      offSync = null;
      releaseThumbs();
    }
  });
  let gen = 0;
  /** Huella del listado pintado, para no repintar si nada cambió. */
  let painted = '';
  const refresh = async (force = false) => {
    const mine = ++gen;
    const list = await listScenes();
    if (mine !== gen || closed) return; // llegó otra actualización o se cerró
    const signature = list.map((m) => `${m.id}:${m.updatedAt}:${m.itemCount}`).join('|');
    if (!force && signature === painted) return;
    painted = signature;
    releaseThumbs();
    clear(grid);
    const newCard = h('div', { class: 'card new' }, svg(icons.plus, 28), h('div', { class: 'meta' }, t('cmd_new')));
    newCard.addEventListener('click', async () => {
      d.close();
      await app.newScene();
    });
    const importCard = h('div', { class: 'card new' }, svg(icons.folder, 28), h('div', { class: 'meta' }, t('cmd_import_scene_file')));
    importCard.addEventListener('click', () => {
      d.close();
      app.promptImport();
    });
    grid.append(newCard, importCard);
    if (!list.length) grid.appendChild(h('p', { class: 'hint', style: { gridColumn: '1 / -1' } }, t('ui_no_recent')));
    for (const m of list) {
      const thumb = h('div', { class: 'thumb' });
      if (m.thumb) {
        const url = URL.createObjectURL(m.thumb);
        thumbUrls.push(url);
        thumb.style.backgroundImage = `url(${url})`;
      }
      else thumb.appendChild(svg(icons.image, 28));
      const card = h(
        'div',
        { class: 'card' },
        thumb,
        h('div', { class: 'meta' }, h('div', { class: 'name' }, m.name), h('div', { class: 'sub' }, `${m.itemCount} ${t('ui_items')} · ${new Date(m.updatedAt).toLocaleDateString()}`))
      );
      card.addEventListener('click', async () => {
        d.close();
        await app.openSceneById(m.id);
      });
      const menu = (x: number, y: number) =>
        showMenu(
          [
            {
              label: t('ui_delete'),
              icon: 'trash',
              danger: true,
              run: async () => {
                if (await app.confirm(t('ui_confirm_delete_scene'), true)) {
                  await app.deleteSceneById(m.id);
                  await refresh(true);
                }
              }
            }
          ],
          { x, y }
        );
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        void menu(e.clientX, e.clientY);
      });
      let timer = 0;
      card.addEventListener('pointerdown', (e) => {
        timer = window.setTimeout(() => void menu(e.clientX, e.clientY), 550);
      });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'pointermove']) card.addEventListener(ev, () => clearTimeout(timer));
      grid.appendChild(card);
    }
  };
  await refresh(true);
  if (closed) return; // se cerró mientras leíamos la lista

  // Con una cuenta conectada, el listado pide los tableros de los demás
  // dispositivos al abrirse y se vuelve a pintar cuando llegan.
  if (isConnected()) {
    const paint = () => {
      const s = getSyncState();
      status.textContent = s === 'syncing' ? t('ui_sync_state_syncing') : '';
      status.style.display = s === 'syncing' ? '' : 'none';
    };
    paint();
    offSync = onSyncState(() => {
      paint();
      if (getSyncState() === 'synced') void refresh();
    });
    void syncNow();
  } else {
    status.style.display = 'none';
  }
}
