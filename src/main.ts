import './styles.css';
import { App } from './app';
import { registerSW } from 'virtual:pwa-register';
import { toast } from './ui/dialogs';
import { t } from './i18n';

const app = new App();
(window as unknown as { moodboard: App }).moodboard = app;
void app.init();

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
