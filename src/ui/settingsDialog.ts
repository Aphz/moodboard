/** Diálogo de ajustes de la app y de la escena. */
import type { App } from '../app';
import { appSettings, updateAppSettings } from '../core/settings';
import { gcBlobs, storageEstimate, requestPersistence } from '../core/persistence';
import { t } from '../i18n';
import { h } from './dom';
import { showDialog, toast } from './dialogs';
import { bytesToHuman } from '../features/imageTools';
import { renderAiSettings } from './aiDialogs';
import { showAccountDialog, syncStateLabel } from './accountDialog';
import { getSyncState, getSyncUser } from '../sync';

declare const __APP_VERSION__: string;

export function showSettingsDialog(app: App) {
  const S = app.store;
  const a = appSettings;
  const row = (label: string, control: HTMLElement) => h('div', { class: 'row' }, h('label', null, label), control);
  const check = (value: boolean, on: (v: boolean) => void) => {
    const c = h('input', { type: 'checkbox' });
    c.checked = value;
    c.addEventListener('change', () => on(c.checked));
    return c;
  };
  const select = (value: string, opts: [string, string][], on: (v: string) => void) => {
    const s = h('select', null, ...opts.map(([v, l]) => h('option', { value: v, selected: v === value || undefined }, l)));
    s.addEventListener('change', () => on(s.value));
    return s;
  };
  const number = (value: number, min: number, max: number, step: number, on: (v: number) => void) => {
    const n = h('input', { type: 'number', min: String(min), max: String(max), step: String(step), value: String(value), style: { width: '90px' } });
    n.addEventListener('change', () => on(Number(n.value)));
    return n;
  };

  const storage = h('div', { class: 'hint' }, '…');
  void storageEstimate().then((e) => (storage.textContent = `${t('ui_storage_used')}: ${bytesToHuman(e.usage)} / ${bytesToHuman(e.quota)}`));
  const gcBtn = h('button', { class: 'btn small' }, t('ui_gc_blobs'));
  gcBtn.addEventListener('click', async () => {
    const live = S.scene.items.filter((i) => i.kind === 'image').map((i) => (i as { blobId: string }).blobId);
    const n = await gcBlobs(live);
    toast(`${t('ui_gc_done')}: ${n}`);
  });
  const persistBtn = h('button', { class: 'btn small' }, t('ui_storage'));
  persistBtn.addEventListener('click', async () => toast((await requestPersistence()) ? t('ui_persist_granted') : t('ui_persist_denied')));

  const canvasColor = h('input', { type: 'color', value: S.scene.settings.canvasColor === 'transparent' ? '#1e1e1e' : S.scene.settings.canvasColor });
  canvasColor.addEventListener('input', () => S.updateSettings((s) => (s.canvasColor = canvasColor.value)));
  const gridColor = h('input', { type: 'color', value: S.scene.settings.grid.color });
  gridColor.addEventListener('input', () => S.updateSettings((s) => (s.grid.color = gridColor.value)));

  /** Bajas de los oyentes que registren los bloques, al cerrar el diálogo. */
  const cleanups: Array<() => void> = [];
  const content = [
    h('h2', null, t('ui_settings')),
    row(t('ui_language'), select(a.language, [['es', 'Español'], ['en', 'English']], (v) => void app.setLanguage(v as 'es' | 'en'))),
    row(t('ui_theme'), select(a.theme, [['dark', t('ui_theme_dark')], ['light', t('ui_theme_light')], ['system', t('ui_theme_system')]], (v) => void updateAppSettings({ theme: v as 'dark' | 'light' | 'system' }))),
    h('h3', null, t('ui_grid')),
    row(t('ui_grid'), check(S.scene.settings.grid.enabled, (v) => S.updateSettings((s) => (s.grid.enabled = v)))),
    row(t('ui_grid_snap'), check(S.scene.settings.grid.snap, (v) => S.updateSettings((s) => (s.grid.snap = v)))),
    row(t('ui_grid_size'), number(S.scene.settings.grid.size, 8, 512, 8, (v) => S.updateSettings((s) => (s.grid.size = v)))),
    row(t('ui_grid_color'), gridColor),
    row(t('ui_canvas_color'), canvasColor),
    row(t('ui_align_padding'), number(S.scene.settings.alignPadding, 0, 200, 2, (v) => S.updateSettings((s) => (s.alignPadding = v)))),
    h('h3', null, t('cmd_import_images')),
    row(t('ui_auto_optimize'), select(String(a.autoOptimizeMaxSide), [['0', t('ui_auto_optimize_off')], ['1024', '1024'], ['2048', '2048'], ['4096', '4096']], (v) => void updateAppSettings({ autoOptimizeMaxSide: Number(v) }))),
    row(t('ui_optimize_quality'), number(a.optimizeQuality, 0.5, 1, 0.05, (v) => void updateAppSettings({ optimizeQuality: v }))),
    row(t('ui_auto_parent'), check(a.autoParent, (v) => void updateAppSettings({ autoParent: v }))),
    row(t('ui_drop_into_groups'), check(a.dropIntoGroups, (v) => void updateAppSettings({ dropIntoGroups: v }))),
    row(t('ui_thumbnails'), check(a.generateThumbnails, (v) => void updateAppSettings({ generateThumbnails: v }))),
    row(t('ui_autosave'), select(String(a.autosaveMs), [['0', '—'], ['2000', '2 s'], ['5000', '5 s'], ['15000', '15 s']], (v) => void updateAppSettings({ autosaveMs: Number(v) }))),
    h('h3', null, 'Apple Pencil'),
    row(t('ui_pencil_pressure'), check(a.pencilPressure, (v) => void updateAppSettings({ pencilPressure: v }))),
    row(t('ui_pencil_only_draw'), check(a.pencilOnlyDraw, (v) => void updateAppSettings({ pencilOnlyDraw: v }))),
    h('h3', null, t('ui_sync_section')),
    h('div', { class: 'row' },
      h('label', null, `${syncStateLabel(getSyncState())}${getSyncUser()?.email ? ' · ' + getSyncUser()!.email : ''}`),
      h('button', { class: 'btn small', onclick: () => { d.close(); showAccountDialog(app); } }, t('ui_sync_open_account'))
    ),
    renderAiSettings((off) => cleanups.push(off)),
    h('h3', null, t('ui_storage')),
    storage,
    h('div', { class: 'row' }, gcBtn, persistBtn),
    h('h3', null, t('ui_about')),
    h('p', { class: 'hint' }, `${t('app_name')} · ${t('ui_version')} ${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'}`),
    h('p', { class: 'hint' }, t('ui_install_hint')),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => d.close() }, t('ui_close')))
  ];
  const d = showDialog(content, { onClose: () => { for (const off of cleanups) off(); } });
}
