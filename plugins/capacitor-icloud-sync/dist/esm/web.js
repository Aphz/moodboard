import { WebPlugin } from '@capacitor/core';
/**
 * Implementación web: no hay iCloud Drive fuera de iOS.
 * `isAvailable()` responde `{ available: false, reason: 'unsupported' }`
 * y el resto de los métodos lanza, para que el llamador use su propio fallback.
 */
export class ICloudSyncWeb extends WebPlugin {
    async isAvailable() {
        return { available: false, reason: 'unsupported' };
    }
    async list() {
        throw this.unsupported();
    }
    async exists() {
        throw this.unsupported();
    }
    async readText() {
        throw this.unsupported();
    }
    async writeText() {
        throw this.unsupported();
    }
    async readFile() {
        throw this.unsupported();
    }
    async writeFile() {
        throw this.unsupported();
    }
    async remove() {
        throw this.unsupported();
    }
    async startWatching() {
        throw this.unsupported();
    }
    async stopWatching() {
        throw this.unsupported();
    }
    unsupported() {
        return this.unavailable('iCloud Drive solo está disponible en iOS.');
    }
}
//# sourceMappingURL=web.js.map