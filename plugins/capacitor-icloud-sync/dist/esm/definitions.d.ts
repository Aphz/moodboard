import type { PluginListenerHandle } from '@capacitor/core';
/**
 * Motivo por el que iCloud Drive no está disponible.
 *
 * - `unsupported`: la plataforma no es iOS (web / Android).
 * - `no-account`: el dispositivo no tiene una cuenta de iCloud activa
 *   (`FileManager.ubiquityIdentityToken == nil`).
 * - `no-container`: hay cuenta, pero el contenedor `iCloud.cl.nicopinto.moodboard`
 *   no se pudo resolver (falta el capability de iCloud Documents, el entitlement
 *   no coincide con el App ID, o iCloud Drive está apagado).
 */
export type ICloudUnavailableReason = 'unsupported' | 'no-account' | 'no-container';
/** Una entrada de directorio dentro de `<container>/Documents/`. */
export interface ICloudEntry {
    /** Nombre del archivo o carpeta, sin ruta. */
    name: string;
    /** Ruta relativa a `<container>/Documents/`, con `/` como separador. */
    path: string;
    /** `true` si es un directorio. */
    isDir: boolean;
    /** Fecha de modificación en milisegundos desde epoch. */
    mtime: number;
    /** Tamaño en bytes (0 para directorios y para archivos aún no descargados). */
    size: number;
    /** `false` si el archivo todavía es un marcador en la nube y hay que descargarlo. */
    downloaded: boolean;
}
/**
 * Acceso al contenedor de iCloud Drive de la app.
 *
 * Todas las rutas (`path`, `dir`) son **relativas** a `<container>/Documents/`,
 * usan `/` como separador y no pueden contener `..` ni ser absolutas.
 * Esa carpeta es la que el usuario ve en Archivos → iCloud Drive → Moodboard.
 */
export interface ICloudSyncPlugin {
    /**
     * Indica si el contenedor de iCloud está disponible. La primera llamada puede
     * tardar (resolver el contenedor toca la red); el resultado queda cacheado.
     */
    isAvailable(): Promise<{
        available: boolean;
        reason?: ICloudUnavailableReason;
        /** Ruta absoluta de `<container>/Documents` cuando `available` es `true`. */
        containerPath?: string;
    }>;
    /**
     * Lista un directorio (no recursivo). Si no existe, lo crea y devuelve
     * una lista vacía. `dir` vacío o `'/'` es la raíz de `Documents/`.
     */
    list(options: {
        dir: string;
    }): Promise<{
        entries: ICloudEntry[];
    }>;
    /** Comprueba si existe una ruta y si su contenido ya está descargado. */
    exists(options: {
        path: string;
    }): Promise<{
        exists: boolean;
        downloaded: boolean;
    }>;
    /** Lee un archivo como texto UTF-8, descargándolo antes si hace falta (timeout 60 s). */
    readText(options: {
        path: string;
    }): Promise<{
        text: string;
    }>;
    /** Escribe texto UTF-8 de forma atómica, creando las carpetas intermedias. */
    writeText(options: {
        path: string;
        text: string;
    }): Promise<void>;
    /** Lee un archivo binario como base64 (sin prefijo `data:`), descargándolo si hace falta. */
    readFile(options: {
        path: string;
    }): Promise<{
        data: string;
    }>;
    /** Escribe un archivo binario desde base64 (sin prefijo `data:`), de forma atómica. */
    writeFile(options: {
        path: string;
        data: string;
    }): Promise<void>;
    /** Borra un archivo o carpeta. No falla si la ruta no existe. */
    remove(options: {
        path: string;
    }): Promise<void>;
    /**
     * Empieza a observar cambios en el contenedor con `NSMetadataQuery`.
     * Emite el evento `changed` con las rutas afectadas.
     */
    startWatching(): Promise<void>;
    /** Detiene la observación iniciada con {@link ICloudSyncPlugin.startWatching}. */
    stopWatching(): Promise<void>;
    /** Se dispara cuando cambian archivos del contenedor (añadidos, modificados o borrados). */
    addListener(eventName: 'changed', listenerFunc: (event: {
        paths: string[];
    }) => void): Promise<PluginListenerHandle>;
    /** Se dispara cuando el usuario inicia o cierra sesión en iCloud. */
    addListener(eventName: 'availabilityChanged', listenerFunc: (event: {
        available: boolean;
    }) => void): Promise<PluginListenerHandle>;
}
//# sourceMappingURL=definitions.d.ts.map