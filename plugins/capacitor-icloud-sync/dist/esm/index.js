import { registerPlugin } from '@capacitor/core';
const ICloudSync = registerPlugin('ICloudSync', {
    web: () => import('./web.js').then((m) => new m.ICloudSyncWeb()),
});
export * from './definitions.js';
export { ICloudSync };
//# sourceMappingURL=index.js.map