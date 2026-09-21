import { WebPlugin } from '@capacitor/core';
import type { ICloudEntry, ICloudSyncPlugin } from './definitions.js';
/**
 * Implementación web: no hay iCloud Drive fuera de iOS.
 * `isAvailable()` responde `{ available: false, reason: 'unsupported' }`
 * y el resto de los métodos lanza, para que el llamador use su propio fallback.
 */
export declare class ICloudSyncWeb extends WebPlugin implements ICloudSyncPlugin {
    isAvailable(): Promise<{
        available: boolean;
        reason?: 'unsupported';
        containerPath?: string;
    }>;
    list(): Promise<{
        entries: ICloudEntry[];
    }>;
    exists(): Promise<{
        exists: boolean;
        downloaded: boolean;
    }>;
    readText(): Promise<{
        text: string;
    }>;
    writeText(): Promise<void>;
    readFile(): Promise<{
        data: string;
    }>;
    writeFile(): Promise<void>;
    remove(): Promise<void>;
    startWatching(): Promise<void>;
    stopWatching(): Promise<void>;
    private unsupported;
}
//# sourceMappingURL=web.d.ts.map