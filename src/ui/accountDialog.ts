/**
 * Diálogo de cuenta y sincronización, y el botón de estado de la barra
 * superior.
 *
 * El diálogo tiene tres caras según el estado del motor de `src/sync`:
 *   1. sin configurar  → URL + clave anon del proyecto de Supabase.
 *   2. sin sesión      → correo → código de un solo uso → entrar.
 *   3. con sesión      → estado, última sincronización y acciones.
 *
 * Los iconos de nube se definen aquí (y no en `src/ui/icons.ts`) para no
 * pisarnos con el resto de la interfaz.
 */
import type { App } from '../app';
import { t } from '../i18n';
import { h, svg } from './dom';
import { confirmDialog, showDialog, toast, type DialogHandle } from './dialogs';
import {
  clearSyncConfig,
  configureSync,
  getLastSync,
  getSyncApp,
  getSyncConfig,
  getSyncError,
  getSyncState,
  getSyncUser,
  initSync,
  onSyncState,
  sendOtp,
  signOut,
  syncNow,
  verifyOtp,
  type SyncState
} from '../sync';

// ---------------------------------------------------------------------------
// iconos (trazo, viewBox 0 0 24 24)

const CLOUD = '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>';

export const cloudIcons = {
  /** nube normal: todo sincronizado */
  cloud: CLOUD,
  /** nube tachada: sin configurar o sin sesión */
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
// diálogo

function field(label: string, control: HTMLElement, hint?: string) {
  return h('div', { class: 'field' }, h('label', null, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
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

/**
 * Abre el diálogo de cuenta. Si no se pasa `app` se usa la registrada en
 * `initSync` (la barra superior no la tiene a mano).
 */
export function showAccountDialog(app: App | null = getSyncApp()): DialogHandle {
  let dialog: DialogHandle;
  const body = h('div');
  let offState: (() => void) | null = null;

  /** Correo escrito y si ya se pidió el código (estado local del diálogo). */
  let email = '';
  let codeSent = false;
  /** Cara del diálogo dibujada la última vez, para no borrar lo que se escribe. */
  let phase = '';
  const currentPhase = () => (!getSyncConfig() ? 'setup' : !getSyncUser() ? 'auth' : 'account');

  const restart = async () => {
    if (app) await initSync(app);
  };

  const build = () => {
    phase = currentPhase();
    const state = getSyncState();
    const user = getSyncUser();
    const cfg = getSyncConfig();
    const nodes: (Node | null)[] = [h('h2', null, t('ui_sync_title'))];

    if (!cfg) {
      // ---- 1. sin configurar ------------------------------------------
      const url = h('input', { type: 'url', placeholder: 'https://xxxx.supabase.co', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
      const key = h('input', { type: 'text', placeholder: 'eyJhbGciOi…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
      const save = h('button', { class: 'btn primary' }, t('ui_sync_save_config'));
      save.addEventListener('click', async () => {
        save.setAttribute('disabled', '');
        const ok = await guard(() => configureSync({ url: url.value, anonKey: key.value }));
        save.removeAttribute('disabled');
        if (ok) {
          toast(t('ui_sync_config_saved'));
          render();
        }
      });
      nodes.push(
        h('h3', null, t('ui_sync_setup_title')),
        h('p', { class: 'hint' }, t('ui_sync_setup_hint')),
        field(t('ui_sync_url'), url),
        field(t('ui_sync_anon_key'), key, t('ui_sync_anon_key_hint')),
        h('p', { class: 'hint' }, h('a', { href: 'https://github.com/Aphz/moodboard/blob/main/docs/SYNC.md', target: '_blank', rel: 'noreferrer' }, `${t('ui_sync_guide')} (docs/SYNC.md)`)),
        h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => dialog.close() }, t('ui_close')), save)
      );
    } else if (!user) {
      // ---- 2. sin sesión ----------------------------------------------
      const mail = h('input', { type: 'email', value: email, placeholder: 'tu@correo.cl', autocomplete: 'email', autocapitalize: 'off', spellcheck: 'false' });
      mail.addEventListener('input', () => (email = mail.value));
      const send = h('button', { class: `btn${codeSent ? '' : ' primary'}` }, t('ui_sync_send_code'));
      send.addEventListener('click', async () => {
        email = mail.value.trim();
        if (!email) {
          toast(t('ui_sync_email_required'), { error: true });
          return;
        }
        send.setAttribute('disabled', '');
        const ok = await guard(() => sendOtp(email));
        send.removeAttribute('disabled');
        if (ok) {
          codeSent = true;
          toast(t('ui_sync_code_sent', { email }));
          render();
        }
      });
      nodes.push(
        h('p', { class: 'hint' }, t('ui_sync_login_hint')),
        field(t('ui_sync_email'), mail),
        codeSent ? null : h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => dialog.close() }, t('ui_close')), send)
      );

      if (codeSent) {
        const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', maxlength: '10' });
        const enter = h('button', { class: 'btn primary' }, t('ui_sync_login'));
        enter.addEventListener('click', async () => {
          enter.setAttribute('disabled', '');
          const ok = await guard(() => verifyOtp(email, code.value));
          enter.removeAttribute('disabled');
          if (ok) {
            codeSent = false;
            toast(t('ui_sync_done'));
            render();
          }
        });
        nodes.push(
          field(t('ui_sync_code'), code, t('ui_sync_code_sent', { email })),
          h('div', { class: 'actions' }, send, enter)
        );
        setTimeout(() => code.focus(), 30);
      }
      nodes.push(h('p', { class: 'hint' }, h('button', { class: 'btn small', onclick: () => void disconnect() }, t('ui_sync_disconnect'))));
    } else {
      // ---- 3. con sesión ----------------------------------------------
      const row = (label: string, value: string) => h('div', { class: 'row' }, h('label', null, label), h('span', null, value));
      const now = h('button', { class: 'btn primary' }, t('ui_sync_now'));
      now.addEventListener('click', async () => {
        now.setAttribute('disabled', '');
        await guard(() => syncNow());
        now.removeAttribute('disabled');
      });
      const out = h('button', { class: 'btn danger' }, t('ui_sync_signout'));
      out.addEventListener('click', async () => {
        await guard(() => signOut());
        render();
      });
      nodes.push(
        row(t('ui_sync_account'), user.email),
        row(t('ui_sync_status'), syncStateLabel(state)),
        row(t('ui_sync_last'), fmtDate(getLastSync())),
        state === 'error' && getSyncError() ? h('p', { class: 'hint' }, getSyncError()) : null,
        h('div', { class: 'actions' }, out, h('button', { class: 'btn', onclick: () => dialog.close() }, t('ui_close')), now),
        h('p', { class: 'hint' }, h('button', { class: 'btn small', onclick: () => void disconnect() }, t('ui_sync_disconnect')))
      );
    }

    body.replaceChildren(...nodes.filter((n): n is Node => !!n));
  };

  const disconnect = async () => {
    if (!(await confirmDialog(t('ui_sync_disconnect_confirm'), { danger: true }))) return;
    await guard(() => clearSyncConfig());
    await restart();
    render();
  };

  const render = () => build();

  build();
  dialog = showDialog(body, {
    onClose: () => {
      offState?.();
      offState = null;
    }
  });
  // sólo se redibuja si cambió la cara del diálogo (o si muestra estado en vivo)
  offState = onSyncState(() => {
    if (currentPhase() === phase && phase !== 'account') return;
    build();
  });
  return dialog;
}
