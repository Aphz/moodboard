/**
 * Importar un tablero de Pinterest.
 *
 * Pinterest no envía cabeceras CORS en su CDN de imágenes (`i.pinimg.com`), así
 * que una app web no puede descargar los pines por URL. El diálogo explica las
 * tres vías que sí funcionan (arrastre en Split View, Fotos, ZIP) y deja
 * armada la organización automática con IA para la siguiente importación.
 */
import type { App } from '../app';
import { aiAvailable } from '../ai/claude';
import { t } from '../i18n';
import { h, svg } from './dom';
import { icons } from './icons';
import { showDialog, toast } from './dialogs';

/** Guía paso a paso en el repositorio. */
const GUIDE_URL = 'https://github.com/Aphz/moodboard/blob/main/docs/PINTEREST.md';

export function showPinterestImport(app: App): void {
  const ai = aiAvailable();
  const auto = h('input', { type: 'checkbox', checked: ai || undefined, disabled: !ai || undefined });
  const route = (icon: string, text: string) => h('li', null, h('span', { class: 'route-icon' }, svg(icons[icon] ?? icons.photo!, 18)), h('span', null, text));

  const d = showDialog(
    [
      h('h2', null, t('ui_pin_title')),
      h('p', null, t('ui_pin_intro')),
      h('ol', { class: 'routes' }, route('drag', t('ui_pin_route_ipad')), route('photo', t('ui_pin_route_photos')), route('folder', t('ui_pin_route_zip'))),
      h('label', { class: 'row' }, auto, h('span', null, t('ui_pin_auto_organize'))),
      ai ? null : h('p', { class: 'hint' }, t('ui_ai_no_key')),
      h(
        'div',
        { class: 'actions' },
        h('a', { class: 'btn', href: GUIDE_URL, target: '_blank', rel: 'noopener' }, t('ui_pin_guide')),
        h('button', { class: 'btn', onclick: () => { arm(); d.close(); toast(t('ui_pin_ready_drop')); } }, t('ui_ok')),
        h('button', { class: 'btn primary', onclick: () => { arm(); d.close(); app.promptImport(); } }, t('ui_pin_choose'))
      )
    ],
    { wide: true }
  );

  /** Deja programada la organización con IA para la próxima importación. */
  function arm() {
    app.armOrganizeAfterImport(ai && auto.checked);
  }
}
