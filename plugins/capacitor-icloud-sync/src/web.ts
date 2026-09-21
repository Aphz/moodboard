import { WebPlugin } from '@capacitor/core';

import type { ICloudEntry, ICloudSyncPlugin } from './definitions.js';

/**
 * Implementación web: no hay iCloud Drive fuera de iOS.
 * `isAvailable()` responde `{ available: false, reason: 'unsupported' }`
 * y el resto de los métodos lanza, para que el llamador use su propio fallback.
 */
export class ICloudSyncWeb extends WebPlugin implements ICloudSyncPlugin {
  async isAvailable(): Promise<{ available: boolean; reason?: 'unsupported'; containerPath?: string }> {
    return { available: false, reason: 'unsupported' };
  }

  async list(): Promise<{ entries: ICloudEntry[] }> {
    throw this.unsupported();
  }

  async exists(): Promise<{ exists: boolean; downloaded: boolean }> {
    throw this.unsupported();
  }

  async readText(): Promise<{ text: string }> {
    throw this.unsupported();
  }

  async writeText(): Promise<void> {
    throw this.unsupported();
  }

  async readFile(): Promise<{ data: string }> {
    throw this.unsupported();
  }

  async writeFile(): Promise<void> {
    throw this.unsupported();
  }

  async remove(): Promise<void> {
    throw this.unsupported();
  }

  async startWatching(): Promise<void> {
    throw this.unsupported();
  }

  async stopWatching(): Promise<void> {
    throw this.unsupported();
  }

  private unsupported(): Error {
    return this.unavailable('iCloud Drive solo está disponible en iOS.');
  }
}
