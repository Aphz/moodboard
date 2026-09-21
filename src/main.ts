import './styles.css';
import { App } from './app';
import { registerSW } from 'virtual:pwa-register';
import { toast } from './ui/dialogs';
import { t } from './i18n';
import { configureSync, decodeSetupLink } from './sync';
import { showAccountDialog } from './ui/accountDialog';

const app = new App();
(window as unknown as { moodboard: App }).moodboard = app;

/**
 * Configuración recibida desde el otro dispositivo (`…/#setup=<base64url>`).
 *
 * El enlace sólo lleva la URL del proyecto y la clave anon, que es pública por
 * diseño. Tras aplicarla se limpia el hash y se abre el diálogo de cuenta,
 * donde ya sólo falta escribir el correo y la contraseña.
 */
async function applySetupLink(): Promise<void> {
  const cfg = decodeSetupLink(location.hash);
  if (!cfg) return;
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch {
    /* si el navegador no deja tocar el historial, da igual */
  }
  try {
    await configureSync(cfg);
    toast(t('ui_sync_setup_received'), { ms: 6000 });
  } catch (e) {
    toast(String((e as { message?: string })?.message ?? e), { error: true });
  }
  showAccountDialog(app);
}

void app.init().then(() => applySetupLink());

const updateSW = registerSW({
  onNeedRefresh() {
    const h = toast(t('ui_update_available'), { ms: 15000 });
    void h;
    document.querySelector('#toast-root .toast:last-child')?.addEventListener('click', () => void updateSW(true));
  },
  onOfflineReady() {
    /* listo para usar sin conexión */
  }
});

window.addEventListener('offline', () => toast(t('ui_offline'), { ms: 3000 }));
