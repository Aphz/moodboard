/**
 * Selector de pines: rejilla de miniaturas donde el usuario quita lo que no
 * quiere antes de descargar. Así no se bajan imágenes de más ni se gastan
 * tokens clasificándolas.
 *
 * Las miniaturas son las `236x` del CDN de Pinterest servidas por el mismo
 * proxy que las imágenes grandes, así que se ven sin descargar el original.
 */
import { t } from '../i18n';
import { thumbUrl, type PinImage } from '../features/pinterest';
import { h } from './dom';
import { showDialog } from './dialogs';

export interface PinPickerOptions {
  /** Título del tablero, para la cabecera. */
  title: string;
  /** Pines que declara el tablero, si se sabe (para avisar si faltan). */
  pinCount: number | null;
}

/**
 * Muestra la rejilla y resuelve con los pines elegidos, o `null` si se
 * cancela. Todos entran marcados.
 */
export function pickPins(pins: PinImage[], opts: PinPickerOptions): Promise<PinImage[] | null> {
  return new Promise((resolve) => {
    let done = false;
    const chosen = new Set(pins.map((p) => p.id));

    const fin = (v: PinImage[] | null) => {
      if (done) return;
      done = true;
      d.close();
      resolve(v);
    };

    const grid = h('div', { class: 'pin-grid' });
    const okBtn = h('button', { class: 'btn primary' });
    const refreshCount = () => {
      okBtn.textContent = t('ui_pick_import', { count: chosen.size });
      okBtn.toggleAttribute('disabled', chosen.size === 0);
    };

    const cells = pins.map((pin) => {
      const img = h('img', { src: thumbUrl(pin), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
      const cell = h('button', { class: 'pin-cell on', 'aria-pressed': 'true', title: t('ui_pick_toggle') }, img, h('span', { class: 'pin-mark' }));
      cell.addEventListener('click', () => {
        const on = !chosen.has(pin.id);
        if (on) chosen.add(pin.id);
        else chosen.delete(pin.id);
        cell.classList.toggle('on', on);
        cell.setAttribute('aria-pressed', String(on));
        refreshCount();
      });
      return { pin, cell };
    });
    grid.append(...cells.map((c) => c.cell));

    const setAll = (on: boolean) => {
      chosen.clear();
      for (const { pin, cell } of cells) {
        if (on) chosen.add(pin.id);
        cell.classList.toggle('on', on);
        cell.setAttribute('aria-pressed', String(on));
      }
      refreshCount();
    };

    okBtn.addEventListener('click', () => fin(pins.filter((p) => chosen.has(p.id))));
    refreshCount();

    const missing = opts.pinCount !== null && opts.pinCount > pins.length;
    const d = showDialog(
      [
        h('h2', null, opts.title || t('ui_pin_title')),
        h('p', null, t('ui_pick_intro', { count: pins.length })),
        missing ? h('p', { class: 'hint' }, t('ui_pick_missing', { total: opts.pinCount! })) : null,
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', onclick: () => setAll(true) }, t('ui_pick_all')),
          h('button', { class: 'btn', onclick: () => setAll(false) }, t('ui_pick_none'))
        ),
        grid,
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn', onclick: () => fin(null) }, t('ui_cancel')),
          okBtn
        )
      ],
      { wide: true, onClose: () => fin(null) }
    );
  });
}
