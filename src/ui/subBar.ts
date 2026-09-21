/** Subbarra contextual: herramientas de dibujo o de recorte. */
import type { App } from '../app';
import type { Tool } from '../input/gestures';
import { t } from '../i18n';
import { h, svg, clear } from './dom';
import { icons } from './icons';

const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2', '#ffffff', '#000000'];

export class SubBar {
  private el = document.getElementById('sub-bar')!;

  constructor(private app: App) {
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  update(tool: Tool) {
    clear(this.el);
    if (tool === 'draw') this.buildDraw();
    else if (tool === 'crop') this.buildCrop();
    this.el.hidden = !(tool === 'draw' || tool === 'crop');
  }

  private buildDraw() {
    const g = this.app.gestures;
    const tools: Array<[string, string]> = [['pen', 'pen'], ['line', 'line'], ['arrow', 'arrow'], ['rect', 'rect'], ['ellipse', 'ellipse']];
    for (const [id, icon] of tools) {
      const b = h('button', { class: `tb${g.draw.tool === id ? ' active' : ''}` }, svg(icons[icon]));
      b.addEventListener('click', () => {
        g.draw.tool = id as typeof g.draw.tool;
        this.update('draw');
      });
      this.el.appendChild(b);
    }
    this.el.appendChild(h('div', { class: 'sep' }));
    for (const c of COLORS) {
      const s = h('button', { class: `swatch${g.draw.color === c ? ' active' : ''}`, style: { background: c } });
      s.addEventListener('click', () => {
        g.draw.color = c;
        this.update('draw');
      });
      this.el.appendChild(s);
    }
    const custom = h('input', { type: 'color', value: g.draw.color, title: t('ui_stroke_color') });
    custom.addEventListener('input', () => (g.draw.color = custom.value));
    this.el.appendChild(custom);
    this.el.appendChild(h('div', { class: 'sep' }));
    const width = h('input', { type: 'range', min: '1', max: '40', value: String(g.draw.width), style: { width: '90px' }, title: t('ui_stroke_width') });
    width.addEventListener('input', () => (g.draw.width = Number(width.value)));
    this.el.appendChild(width);
    const done = h('button', { class: 'tb active' }, svg(icons.check));
    done.addEventListener('click', () => g.setTool('select'));
    this.el.appendChild(done);
  }

  private buildCrop() {
    const g = this.app.gestures;
    const id = this.app.renderer.overlay.cropId;
    const lock = h('button', { class: `chip${g.cropAspectLock ? ' active' : ''}` }, t('ui_crop_aspect_lock'));
    lock.addEventListener('click', () => {
      g.cropAspectLock = !g.cropAspectLock;
      this.update('crop');
    });
    const reset = h('button', { class: 'chip' }, t('ui_crop_reset'));
    reset.addEventListener('click', () => {
      if (id) this.app.resetCrop(id);
    });
    const done = h('button', { class: 'tb active' }, svg(icons.check));
    done.addEventListener('click', () => this.app.exitCrop());
    this.el.append(lock, reset, done);
  }
}
