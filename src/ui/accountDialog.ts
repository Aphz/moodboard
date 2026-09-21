/**
 * Diálogo de cuenta y sincronización, y el botón de estado de la barra
 * superior.
 *
 * Para el usuario final no hay nada que configurar: un solo botón
 * **"Conectar con Google"**. El diálogo tiene tres caras:
 *
 *  1. La build no trae ID de cliente (`'off'`) → se explica que esta versión
 *     no tiene la sincronización habilitada. Solo si `appSettings.googleClientId`
 *     está vacío aparece, plegado bajo "Avanzado", un campo para que quien
 *     publica la app pegue un ID de cliente y lo pruebe sin recompilar.
 *  2. Sin sesión → qué hace la sincronización + "Conectar con Google".
 *  3. Con sesión → correo, estado, última sincronización, "Sincronizar ahora",
 *     "Desconectar" y dónde quedan los archivos en Drive.
 *
 * Los iconos de nube se definen aquí (y no en `src/ui/icons.ts`) para no
 * pisarnos con el resto de la interfaz.
 */
import type { App } from '../app';
import { appSettings } from '../core/settings';
import { t } from '../i18n';
import { h, svg } from './dom';
import { confirmDialog, showDialog, toast, type DialogHandle } from './dialogs';
import {
  connectGoogle,
  disconnectGoogle,
  getLastSync,
  getSyncApp,
  getSyncError,
  getSyncState,
  getSyncUser,
  hasClientId,
  onSyncState,
  setClientId,
  syncNow,
  type SyncState
} from '../sync';

/** Guía de sincronización publicada en GitHub. */
const GUIDE_URL = 'https://github.com/Aphz/moodboard/blob/main/docs/SYNC.md';

// ---------------------------------------------------------------------------
// iconos (trazo, viewBox 0 0 24 24)

const CLOUD = '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>';

export const cloudIcons = {
  /** nube normal: todo sincronizado */
  cloud: CLOUD,
  /** nube tachada: sin sincronización o sin conectar */
  cloudOff: `${CLOUD}<path d="M3 3 21 21"/>`,
  /** nube con flechas: sincronizando */
  cloudSync: `${CLOUD}<path d="M10 17.4v-4.8"/><path d="m8.4 14.2 1.6-1.6 1.6 1.6"/><path d="M14 12.6v4.8"/><path d="m12.4 15.8 1.6 1.6 1.6-1.6"/>`,
  /** nube con alerta: error o sin conexión */
  cloudAlert: `${CLOUD}<path d="M12 12.4v3.2"/><path d="M12 18h.01"/>`
};

/** Etiqueta traducida de cada estado. */
export function syncStateLabel(s: SyncState): string {
  switch (s) {
    case 'off':
      return t('ui_sync_state_off');
    case 'signed-out':
      return t('ui_sync_state_signed_out');
    case 'syncing':
      return t('ui_sync_state_syncing');
    case 'synced':
      return t('ui_sync_state_synced');
    case 'offline':
      return t('ui_sync_state_offline');
    default:
      return t('ui_sync_state_error');
  }
}

function iconFor(s: SyncState): string {
  if (s === 'syncing') return cloudIcons.cloudSync;
  if (s === 'synced') return cloudIcons.cloud;
  if (s === 'error' || s === 'offline') return cloudIcons.cloudAlert;
  return cloudIcons.cloudOff;
}

/** Estilos propios del botón (no tocamos `styles.css`, que es compartido). */
function ensureStyles() {
  if (document.getElementById('sync-icon-style')) return;
  const style = document.createElement('style');
  style.id = 'sync-icon-style';
  style.textContent = `
.tb.sync-off { opacity: .45; }
.tb.sync-signed-out { opacity: .7; }
.tb.sync-synced { color: var(--accent, #4a9eff); }
.tb.sync-error, .tb.sync-offline { color: var(--danger, #e2564a); }
.tb.sync-syncing svg { animation: sync-pulse 1.1s ease-in-out infinite; }
@keyframes sync-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .tb.sync-syncing svg { animation: none; } }
.sync-step { margin-top: 16px; }
.sync-step h3 { margin: 0 0 4px; }
.sync-step .actions { margin-top: 10px; flex-wrap: wrap; justify-content: flex-start; }
.sync-step details { margin-top: 12px; }
.sync-step details > summary { cursor: pointer; opacity: .75; }
`;
  document.head.appendChild(style);
}

/**
 * Botón de la barra superior que refleja el estado de la sincronización y
 * abre el diálogo de cuenta. Hay que llamar a `destroy()` al desmontarlo.
 */
export function syncStatusIcon(): { el: HTMLElement; destroy(): void } {
  ensureStyles();
  const el = h('button', { class: 'tb', type: 'button' });
  const render = (s: SyncState) => {
    el.className = `tb sync-${s}`;
    const label = `${t('ui_sync')}: ${syncStateLabel(s)}`;
    el.title = label;
    el.setAttribute('aria-label', label);
    el.replaceChildren(svg(iconFor(s)));
  };
  render(getSyncState());
  const off = onSyncState(render);
  const onClick = () => void showAccountDialog();
  el.addEventListener('click', onClick);
  return {
    el,
    destroy() {
      off();
      el.removeEventListener('click', onClick);
    }
  };
}

// ---------------------------------------------------------------------------
// utilidades del diálogo

function field(label: string, control: HTMLElement, hint?: string) {
  return h('div', { class: 'field' }, h('label', null, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
}

function row(label: string, value: string) {
  return h('div', { class: 'row' }, h('label', null, label), h('span', null, value));
}

function fmtDate(ms: number): string {
  if (!ms) return t('ui_sync_never');
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return new Date(ms).toISOString();
  }
}

/** Ejecuta una acción mostrando el error en un toast en vez de lanzarlo. */
async function guard(fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    toast(String((e as { message?: string })?.message ?? e), { error: true });
    return false;
  }
}

/** ¿Tiene pinta de ID de cliente OAuth de Google? */
function looksLikeClientId(v: string): boolean {
  return /\.apps\.googleusercontent\.com$/.test(v.trim());
}

// ---------------------------------------------------------------------------
// diálogo

/**
 * Abre el diálogo de cuenta. Si no se pasa `app` se usa la registrada en
 * `initSync` (la barra superior no la tiene a mano).
 */
export function showAccountDialog(app: App | null = getSyncApp()): DialogHandle {
  let dialog: DialogHandle;
  const body = h('div');
  let offState: (() => void) | null = null;

  /** Texto escrito en el campo avanzado (sobrevive a los redibujados). */
  let clientId = appSettings.googleClientId ?? '';
  let connecting = false;
  /** Cara del diálogo dibujada la última vez. */
  let phase = '';
  const currentPhase = () => `${hasClientId() ? 'id' : 'noid'}:${getSyncUser() ? 'in' : 'out'}:${getSyncState()}`;

  // ---- caras del diálogo ---------------------------------------------------

  /** Sin ID de cliente: esta build no puede sincronizar. */
  const faceNoClientId = (): Node[] => {
    const nodes: Node[] = [h('p', null, t('ui_sync_no_client_id'))];
    // el campo de desarrollador sólo aparece si no se pegó ya uno
    if (!(appSettings.googleClientId ?? '').trim()) {
      const input = h('input', {
        type: 'text',
        value: clientId,
        placeholder: '1234567890-abc.apps.googleusercontent.com',
        autocomplete: 'off',
        autocapitalize: 'off',
        spellcheck: 'false'
      }) as HTMLInputElement;
      input.addEventListener('input', () => (clientId = input.value));
      const save = h('button', { class: 'btn primary' }, t('ui_sync_client_id_save'));
      save.addEventListener('click', async () => {
        const value = clientId.trim();
        if (!looksLikeClientId(value)) {
          toast(t('ui_sync_client_id_invalid'), { error: true, ms: 5000 });
          return;
        }
        save.setAttribute('disabled', '');
        const ok = await guard(() => setClientId(value, app));
        save.removeAttribute('disabled');
        if (ok) {
          toast(t('ui_sync_client_id_saved'));
          build();
        }
      });
      nodes.push(
        h(
          'details',
          null,
          h('summary', null, t('ui_sync_advanced')),
          field(t('ui_sync_client_id'), input, t('ui_sync_client_id_hint')),
          h('div', { class: 'actions' }, save)
        )
      );
    }
    return [h('div', { class: 'sync-step' }, ...nodes)];
  };

  /** Con ID de cliente pero sin sesión: un solo botón. */
  const faceSignedOut = (): Node[] => {
    const connect = h('button', { class: 'btn primary', disabled: connecting }, connecting ? t('ui_sync_connecting') : t('ui_sync_connect'));
    connect.addEventListener('click', async () => {
      connecting = true;
      build();
      const ok = await connectGoogle();
      connecting = false;
      build();
      toast(ok ? t('ui_sync_connected') : getSyncError() || t('ui_sync_err_unknown'), { error: !ok, ms: ok ? 2600 : 5000 });
    });
    const err = getSyncError();
    return [
      h(
        'div',
        { class: 'sync-step' },
        h('p', null, t('ui_sync_intro')),
        err ? h('p', { class: 'hint' }, err) : null,
        h('div', { class: 'actions' }, connect)
      )
    ];
  };

  /** Con sesión: estado y acciones. */
  const faceSignedIn = (email: string): Node[] => {
    const state = getSyncState();
    const now = h('button', { class: 'btn primary' }, t('ui_sync_now'));
    now.addEventListener('click', async () => {
      now.setAttribute('disabled', '');
      await guard(() => syncNow());
      now.removeAttribute('disabled');
      build();
    });
    const out = h('button', { class: 'btn danger' }, t('ui_sync_disconnect'));
    out.addEventListener('click', async () => {
      if (!(await confirmDialog(t('ui_sync_disconnect_confirm'), { danger: true }))) return;
      await guard(() => disconnectGoogle());
      toast(t('ui_sync_disconnected'));
      build();
    });
    return [
      h(
        'div',
        { class: 'sync-step' },
        row(t('ui_sync_account'), email),
        row(t('ui_sync_status'), syncStateLabel(state)),
        row(t('ui_sync_last'), fmtDate(getLastSync())),
        (state === 'error' || state === 'offline') && getSyncError() ? h('p', { class: 'hint' }, getSyncError()) : null,
        h('div', { class: 'actions' }, out, now),
        h('p', { class: 'hint' }, t('ui_sync_where'))
      )
    ];
  };

  /** Pie: enlace a la guía y cerrar. */
  const footer = (): Node[] => [
    h(
      'p',
      { class: 'hint' },
      h('a', { href: GUIDE_URL, target: '_blank', rel: 'noreferrer' }, `${t('ui_sync_guide')} (docs/SYNC.md)`)
    ),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => dialog.close() }, t('ui_close')))
  ];

  const build = () => {
    phase = currentPhase();
    const user = getSyncUser();
    const face = !hasClientId() ? faceNoClientId() : user ? faceSignedIn(user.email) : faceSignedOut();
    body.replaceChildren(h('h2', null, t('ui_sync_title')), ...face, ...footer());
  };

  build();
  dialog = showDialog(body, {
    onClose: () => {
      offState?.();
      offState = null;
    }
  });
  // sólo se redibuja si cambió la cara del diálogo (para no borrar lo escrito)
  offState = onSyncState(() => {
    if (currentPhase() === phase) return;
    build();
  });
  return dialog;
}
