/**
 * Diálogo de cuenta y sincronización (asistente guiado), y el botón de estado
 * de la barra superior.
 *
 * El diálogo es una lista de cuatro pasos que la app comprueba sola:
 *   1. Proyecto  → URL + clave anon, botón "Probar" (`checkSetup`).
 *   2. Confirmación de correo desactivada → enlace directo al panel.
 *   3. Base de datos y almacenamiento → "Copiar SQL" + editor SQL.
 *   4. Cuenta → correo y contraseña ("Entrar o crear cuenta").
 *
 * Nada depende del correo electrónico: no hay códigos ni enlaces mágicos.
 *
 * Los iconos de nube se definen aquí (y no en `src/ui/icons.ts`) para no
 * pisarnos con el resto de la interfaz.
 */
import type { App } from '../app';
import { t } from '../i18n';
import { h, svg } from './dom';
import { confirmDialog, showDialog, toast, type DialogHandle } from './dialogs';
import schemaSql from '../../supabase/schema.sql?raw';

/** Copia del esquema publicada en GitHub, por si ningún método de copia funciona en el dispositivo. */
const SCHEMA_RAW_URL = 'https://raw.githubusercontent.com/Aphz/moodboard/main/supabase/schema.sql';
import {
  checkSetup,
  clearSyncConfig,
  configureSync,
  encodeSetupLink,
  getLastSync,
  getSyncApp,
  getSyncConfig,
  getSyncError,
  getSyncState,
  getSyncUser,
  initSync,
  MIN_PASSWORD_LENGTH,
  onSyncState,
  providersUrl,
  signIn,
  signOut,
  sqlEditorUrl,
  syncNow,
  type SetupReport,
  type SetupStep,
  type SignInResult,
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
.sync-step { margin-top: 16px; }
.sync-step h3 { margin: 0 0 4px; }
.sync-step .actions { margin-top: 10px; flex-wrap: wrap; justify-content: flex-start; }
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

function fmtDate(ms: number): string {
  if (!ms) return t('ui_sync_never');
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return new Date(ms).toISOString();
  }
}

/** Copia texto al portapapeles, con respaldo para Safari antiguo. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* seguir con el respaldo */
  }
  try {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0', top: '0' } }) as HTMLTextAreaElement;
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Abre una página del panel de Supabase en otra pestaña. */
function openPage(url: string) {
  window.open(url, '_blank', 'noopener');
}

/** Marca visual del paso: ✅ / ❌ / ⏳. */
function badge(step: SetupStep): string {
  return step.state === 'ok' ? '✅' : step.state === 'fail' ? '❌' : '⏳';
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

  // ---- estado local del diálogo (sobrevive a los redibujados) -------------
  const saved = getSyncConfig();
  let url = saved?.url ?? '';
  let anonKey = saved?.anonKey ?? '';
  let email = getSyncUser()?.email ?? '';
  let password = '';
  let report: SetupReport | null = null;
  let checking = false;
  /** Último intento de inicio de sesión fallido (para explicar qué pasó). */
  let authFail: SignInResult | null = null;
  /** Cara del diálogo dibujada la última vez (config + sesión). */
  let phase = '';
  const currentPhase = () => `${getSyncConfig() ? 'cfg' : 'nocfg'}:${getSyncUser() ? 'in' : 'out'}`;

  const pending = (message: string): SetupStep => ({ state: 'pending', message });

  /** Paso tal como hay que pintarlo ahora mismo. */
  const stepOf = (key: 'project' | 'confirmEmail' | 'data'): SetupStep => {
    if (checking) return pending(t('ui_sync_checking'));
    if (report) return report[key];
    if (key === 'project') return pending(getSyncConfig() ? t('ui_sync_checking') : t('ui_sync_project_pending'));
    if (key === 'confirmEmail') return pending(t('ui_sync_confirm_pending'));
    return pending(t('ui_sync_data_pending'));
  };

  /**
   * Lanza las comprobaciones. `fromInputs` usa lo escrito en el paso 1 y, si
   * el proyecto responde, lo guarda; si no, comprueba el proyecto guardado.
   */
  const runCheck = async (fromInputs: boolean) => {
    checking = true;
    build();
    try {
      if (fromInputs) {
        const typed = { url: url.trim(), anonKey: anonKey.trim() };
        const first = await checkSetup(typed, { data: false });
        if (first.project.state !== 'ok') {
          report = first;
          return;
        }
        const same = getSyncConfig()?.url === typed.url.replace(/\/+$/, '') && getSyncConfig()?.anonKey === typed.anonKey;
        if (!same) {
          const ok = await guard(() => configureSync(typed));
          if (!ok) {
            report = first;
            return;
          }
          toast(t('ui_sync_config_saved'));
        }
      }
      report = await checkSetup(getSyncConfig(), { data: !!getSyncConfig() });
    } finally {
      checking = false;
      build();
    }
  };

  // ---- pasos --------------------------------------------------------------

  /** Paso A: URL y clave anon del proyecto. */
  const stepProject = (): Node[] => {
    const step = stepOf('project');
    const urlInput = h('input', {
      type: 'url',
      value: url,
      placeholder: 'https://xxxx.supabase.co',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false'
    });
    urlInput.addEventListener('input', () => (url = urlInput.value));
    const keyInput = h('input', {
      type: 'text',
      value: anonKey,
      placeholder: 'eyJhbGciOi…',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false'
    });
    keyInput.addEventListener('input', () => (anonKey = keyInput.value));
    const test = h('button', { class: 'btn primary', disabled: checking }, checking ? t('ui_sync_checking') : t('ui_sync_test'));
    test.addEventListener('click', () => void runCheck(true));
    return [
      h(
        'div',
        { class: 'sync-step' },
        h('h3', null, `${badge(step)} ${t('ui_sync_step_project')}`),
        h('p', { class: 'hint' }, step.message),
        field(t('ui_sync_url'), urlInput),
        field(t('ui_sync_anon_key'), keyInput, t('ui_sync_anon_key_hint')),
        h('div', { class: 'actions' }, test)
      )
    ];
  };

  /** Paso B: confirmación de correo desactivada. */
  const stepConfirm = (): Node[] => {
    const step = stepOf('confirmEmail');
    const acts: Node[] = [];
    if (step.state === 'fail') {
      const open = h('button', { class: 'btn' }, t('ui_sync_open_providers'));
      open.addEventListener('click', () => openPage(providersUrl(getSyncConfig()?.url ?? url)));
      const again = h('button', { class: 'btn primary', disabled: checking }, t('ui_sync_recheck'));
      again.addEventListener('click', () => void runCheck(false));
      acts.push(h('div', { class: 'actions' }, open, again));
    }
    return [
      h(
        'div',
        { class: 'sync-step' },
        h('h3', null, `${badge(step)} ${t('ui_sync_step_confirm')}`),
        h('p', { class: 'hint' }, step.message),
        ...acts
      )
    ];
  };

  /** Paso C: tabla `scenes` y bucket `blobs`. */
  const stepData = (): Node[] => {
    const step = stepOf('data');
    const acts: Node[] = [];
    if (step.state === 'fail') {
      const copy = h('button', { class: 'btn primary' }, t('ui_sync_copy_sql'));
      copy.addEventListener('click', async () => {
        const ok = await copyText(schemaSql);
        toast(ok ? t('ui_sync_sql_copied') : t('ui_sync_err_unknown'), { error: !ok, ms: 5000 });
      });
      const open = h('button', { class: 'btn' }, t('ui_sync_open_sql'));
      open.addEventListener('click', () => openPage(sqlEditorUrl(getSyncConfig()?.url ?? url)));
      // Respaldos para iPad: la hoja de compartir (trae "Copiar") y el SQL en pantalla para copiarlo a mano.
      const share = h('button', { class: 'btn' }, t('ui_sync_share_sql'));
      share.addEventListener('click', async () => {
        const file = new File([schemaSql], 'schema.sql', { type: 'text/plain' });
        try {
          if (navigator.share && navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'schema.sql' });
          else if (navigator.share) await navigator.share({ text: schemaSql, title: 'schema.sql' });
          else openPage(SCHEMA_RAW_URL);
        } catch {
          /* cancelado */
        }
      });
      const view = h('button', { class: 'btn' }, t('ui_sync_show_sql'));
      const sqlBox = h('textarea', { readonly: true, rows: '10', style: { display: 'none', fontFamily: 'ui-monospace, monospace', fontSize: '12px', marginTop: '8px' } }) as HTMLTextAreaElement;
      sqlBox.value = schemaSql;
      view.addEventListener('click', () => {
        const shown = sqlBox.style.display !== 'none';
        sqlBox.style.display = shown ? 'none' : 'block';
        if (!shown) {
          sqlBox.focus();
          sqlBox.select();
        }
      });
      const again = h('button', { class: 'btn', disabled: checking }, t('ui_sync_recheck'));
      again.addEventListener('click', () => void runCheck(false));
      acts.push(
        h('p', { class: 'hint' }, t('ui_sync_data_sql_hint')),
        h('div', { class: 'actions', style: { justifyContent: 'flex-start', flexWrap: 'wrap' } }, copy, share, view, open, again),
        sqlBox
      );
    }
    return [
      h(
        'div',
        { class: 'sync-step' },
        h('h3', null, `${badge(step)} ${t('ui_sync_step_data')}`),
        h('p', { class: 'hint' }, step.message),
        ...acts
      )
    ];
  };

  /** Paso D: cuenta (correo + contraseña) o estado de la sesión. */
  const stepAccount = (): Node[] => {
    const user = getSyncUser();
    const step: SetupStep = user
      ? { state: 'ok', message: t('ui_sync_account_ok', { email: user.email }) }
      : authFail
        ? { state: 'fail', message: authFail.message }
        : pending(t('ui_sync_account_pending'));
    const nodes: (Node | null)[] = [h('h3', null, `${badge(step)} ${t('ui_sync_step_account')}`), h('p', { class: 'hint' }, step.message)];

    if (!user) {
      const mail = h('input', {
        type: 'email',
        value: email,
        placeholder: 'tu@correo.cl',
        autocomplete: 'email',
        autocapitalize: 'off',
        spellcheck: 'false'
      });
      mail.addEventListener('input', () => (email = mail.value));
      const pass = h('input', {
        type: 'password',
        value: password,
        placeholder: '••••••••',
        autocomplete: 'current-password',
        minlength: String(MIN_PASSWORD_LENGTH)
      });
      pass.addEventListener('input', () => (password = pass.value));
      const enter = h('button', { class: 'btn primary', disabled: !getSyncConfig() }, t('ui_sync_login'));
      const doSignIn = async () => {
        enter.setAttribute('disabled', '');
        const res = await signIn(email.trim(), password);
        enter.removeAttribute('disabled');
        if (res.ok) {
          authFail = null;
          password = '';
          toast(t('ui_sync_done'));
          await runCheck(false);
          return;
        }
        authFail = res;
        build();
      };
      enter.addEventListener('click', () => void doSignIn());
      pass.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') void doSignIn();
      });
      nodes.push(
        field(t('ui_sync_email'), mail),
        field(t('ui_sync_password'), pass, t('ui_sync_password_hint')),
        h('p', { class: 'hint' }, t('ui_sync_login_hint'))
      );
      if (authFail?.code === 'confirm-email') {
        const open = h('button', { class: 'btn' }, t('ui_sync_open_providers'));
        open.addEventListener('click', () => openPage(providersUrl(getSyncConfig()?.url ?? url)));
        nodes.push(h('div', { class: 'actions' }, open, enter));
      } else {
        nodes.push(h('div', { class: 'actions' }, enter));
      }
    } else {
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
        build();
      });
      const state = getSyncState();
      nodes.push(
        row(t('ui_sync_account'), user.email),
        row(t('ui_sync_status'), syncStateLabel(state)),
        row(t('ui_sync_last'), fmtDate(getLastSync())),
        state === 'error' && getSyncError() ? h('p', { class: 'hint' }, getSyncError()) : null,
        h('div', { class: 'actions' }, out, now)
      );
    }
    return [h('div', { class: 'sync-step' }, ...nodes.filter((n): n is Node => !!n))];
  };

  /** Pie: compartir configuración, guía, desconectar y cerrar. */
  const footer = (): Node[] => {
    const nodes: Node[] = [];
    const cfg = getSyncConfig();
    if (cfg) {
      const share = h('button', { class: 'btn' }, t('ui_sync_share'));
      share.addEventListener('click', async () => {
        const link = encodeSetupLink(cfg);
        const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
        if (typeof nav.share === 'function') {
          try {
            await nav.share({ title: 'Moodboard', url: link });
            return;
          } catch {
            /* el usuario canceló: seguimos copiando */
          }
        }
        const ok = await copyText(link);
        toast(ok ? t('ui_sync_share_copied') : link, { ms: 6000, error: !ok });
      });
      nodes.push(
        h('div', { class: 'sync-step' }, h('div', { class: 'actions' }, share), h('p', { class: 'hint' }, t('ui_sync_share_hint')))
      );
    }
    nodes.push(
      h(
        'p',
        { class: 'hint' },
        h(
          'a',
          { href: 'https://github.com/Aphz/moodboard/blob/main/docs/SYNC.md', target: '_blank', rel: 'noreferrer' },
          `${t('ui_sync_guide')} (docs/SYNC.md)`
        )
      ),
      h(
        'div',
        { class: 'actions' },
        cfg ? h('button', { class: 'btn small', onclick: () => void disconnect() }, t('ui_sync_disconnect')) : null,
        h('button', { class: 'btn', onclick: () => dialog.close() }, t('ui_close'))
      )
    );
    return nodes;
  };

  const build = () => {
    phase = currentPhase();
    body.replaceChildren(
      h('h2', null, t('ui_sync_title')),
      h('p', { class: 'hint' }, t('ui_sync_setup_hint')),
      ...stepProject(),
      ...stepConfirm(),
      ...stepData(),
      ...stepAccount(),
      ...footer()
    );
  };

  const disconnect = async () => {
    if (!(await confirmDialog(t('ui_sync_disconnect_confirm'), { danger: true }))) return;
    await guard(() => clearSyncConfig());
    if (app) await initSync(app);
    report = null;
    authFail = null;
    build();
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
  // comprobación automática al abrir, si ya hay proyecto configurado
  if (getSyncConfig()) void runCheck(false);
  return dialog;
}
