import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'cl.nicopinto.moodboard',
  appName: 'Moodboard',
  webDir: 'dist',
  ios: {
    contentInset: 'never',
    backgroundColor: '#1e1e1e',
    preferredContentMode: 'mobile'
  }
};

export default config;
