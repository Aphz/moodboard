import { registerPlugin } from '@capacitor/core';

import type { ICloudSyncPlugin } from './definitions.js';

const ICloudSync = registerPlugin<ICloudSyncPlugin>('ICloudSync', {
  web: () => import('./web.js').then((m) => new m.ICloudSyncWeb()),
});

export * from './definitions.js';
export { ICloudSync };
