/** Selector de escenas (recientes con miniaturas), nueva, importar, eliminar. */
import type { App } from '../app';
import { listScenes } from '../core/persistence';
import { t } from '../i18n';
import { h, svg, clear } from './dom';
import { icons } from './icons';
import { showDialog, showMenu } from './dialogs';

export async function showScenesDialog(app: App) {
  const grid = h('div', { class: 'grid-list' });
  const d = showDialog([h('h2', null, t('ui_recent')), grid], { wide: true });
  const refresh = async () => {
    clear(grid);
    const list = await listScenes();
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
      if (m.thumb) thumb.style.backgroundImage = `url(${URL.createObjectURL(m.thumb)})`;
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
                  await refresh();
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
  await refresh();
}
