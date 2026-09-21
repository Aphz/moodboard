/**
 * Importar un tablero de Pinterest.
 *
 * Vía principal: pegar el enlace del tablero (o del pin, o un `pin.it`). Como
 * Pinterest no envía CORS, la lectura pasa por `src/features/pinterest.ts`
 * (lector y proxy de imágenes públicos). Vías alternativas: arrastre en Split
 * View, Fotos o ZIP. En todos los casos puede quedar armada la organización
 * con IA para cuando terminen de entrar las imágenes.
 */
import type { App } from '../app';
import { aiAvailable } from '../ai/claude';
import { onSettingsChange } from '../core/settings';
import { importBlobs } from '../features/importImages';
import { downloadPins, fetchBoard, normalizePinterestUrl } from '../features/pinterest';
import { t } from '../i18n';
import { h, svg } from './dom';
import { icons } from './icons';
import { showDialog, toast } from './dialogs';
import { showSettingsDialog } from './settingsDialog';

/** Guía paso a paso en el repositorio. */
const GUIDE_URL = 'https://github.com/Aphz/moodboard/blob/main/docs/PINTEREST.md';

export function showPinterestImport(app: App, initialLink = ''): void {
  // La casilla es una preferencia del usuario: se puede marcar aunque todavía
  // no haya clave de IA, y en ese caso se ofrece configurarla aquí mismo.
  const auto = h('input', { type: 'checkbox', checked: aiAvailable() || undefined });
  const keyBtn = h('button', { class: 'btn', onclick: () => showSettingsDialog(app) }, t('ui_pin_configure_key'));
  const keyRow = h('div', { class: 'row' }, h('span', { class: 'hint' }, t('ui_ai_no_key')), keyBtn);
  const syncKeyRow = () => {
    const ai = aiAvailable();
    keyRow.style.display = ai ? 'none' : '';
    if (ai && !auto.checked) auto.checked = true;
  };
  syncKeyRow();
  // si el usuario pega la clave en Ajustes sin cerrar esto, el aviso se va solo
  const offSettings = onSettingsChange(syncKeyRow);
  const link = h('input', {
    type: 'url',
    value: initialLink,
    placeholder: 'https://pin.it/… o https://pinterest.com/usuario/tablero/',
    // `autocomplete: url` evita que iOS ofrezca contraseñas guardadas del sitio
    autocomplete: 'url',
    name: 'pinterest-url',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    inputmode: 'url',
    enterkeyhint: 'go'
  });
  const route = (icon: string, text: string) => h('li', null, h('span', { class: 'route-icon' }, svg(icons[icon] ?? icons.photo!, 18)), h('span', null, text));

  const goLink = () => {
    const url = normalizePinterestUrl(link.value);
    if (!url) {
      toast(t('ui_pin_link_invalid'), { error: true });
      link.focus();
      return;
    }
    arm();
    d.close();
    void importPinterestUrl(app, url);
  };
  link.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goLink();
    }
  });

  const d = showDialog(
    [
      h('h2', null, t('ui_pin_title')),
      h('p', null, t('ui_pin_intro')),
      h('div', { class: 'field' }, h('label', null, t('ui_pin_link_label')), link, h('div', { class: 'hint' }, t('ui_pin_link_hint'))),
      h('label', { class: 'row' }, auto, h('span', null, t('ui_pin_auto_organize'))),
      keyRow,
      h(
        'details',
        { class: 'routes-details' },
        h('summary', null, t('ui_pin_other_ways')),
        h('ol', { class: 'routes' }, route('drag', t('ui_pin_route_ipad')), route('photo', t('ui_pin_route_photos')), route('folder', t('ui_pin_route_zip'))),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', onclick: () => { arm(); d.close(); toast(t('ui_pin_ready_drop')); } }, t('ui_ok')),
          h('button', { class: 'btn', onclick: () => { arm(); d.close(); app.promptImport(); } }, t('ui_pin_choose'))
        )
      ),
      h(
        'div',
        { class: 'actions' },
        h('a', { class: 'btn', href: GUIDE_URL, target: '_blank', rel: 'noopener' }, t('ui_pin_guide')),
        h('button', { class: 'btn', onclick: () => d.close() }, t('ui_cancel')),
        h('button', { class: 'btn primary', onclick: goLink }, t('ui_pin_link_import'))
      )
    ],
    { wide: true, onClose: () => offSettings() }
  );
  if (!initialLink) setTimeout(() => link.focus(), 50);

  /** Deja programada la organización con IA para la próxima importación. */
  function arm() {
    app.armOrganizeAfterImport(auto.checked && aiAvailable());
  }
}

/**
 * Lee el tablero por su enlace, descarga los pines por el proxy y los importa
 * al lienzo; si estaba programado, lanza después «IA: organizar».
 */
export async function importPinterestUrl(app: App, url: string): Promise<void> {
  const tt = toast(t('ui_pin_reading'), { spinner: true });
  try {
    const board = await fetchBoard(url);
    tt.update(t('ui_pin_downloading', { done: 0, total: board.pins.length }));
    const files = await downloadPins(board.pins, {
      onProgress: (done, total) => tt.update(t('ui_pin_downloading', { done, total }))
    });
    tt.close();
    if (!files.length) {
      toast(t('ui_pin_error'), { error: true });
      return;
    }
    const items = await importBlobs(app.store, files.map((f) => ({ blob: f.blob, name: f.name })), app.viewCenter());
    if (!items.length) return;
    app.gestures.fitSelection();
    const total = board.pinCount ?? 0;
    toast(
      total > items.length
        ? t('ui_pin_partial', { title: board.title, count: items.length, total })
        : t('ui_pin_imported', { title: board.title, count: items.length }),
      { ms: 6000 }
    );
    await app.afterImport(items, 2);
  } catch (e) {
    tt.close();
    toast(`${t('ui_pin_error')}: ${e instanceof Error ? e.message : String(e)}`, { error: true });
  }
}
