/** Preferencias de la app (no de la escena). Se guardan en IndexedDB kv. */
import { getKV, setKV } from './persistence';

export interface AppSettings {
  language: 'es' | 'en';
  theme: 'dark' | 'light' | 'system';
  /** Optimizar imágenes al importar: lado máximo en px (0 = sin límite) */
  autoOptimizeMaxSide: number;
  /** calidad JPEG/WebP al optimizar (0..1) */
  optimizeQuality: number;
  /** Auto-emparentar notas/dibujos al ítem seleccionado */
  autoParent: boolean;
  /** Arrastrar ítems dentro de grupos al soltar sobre ellos */
  dropIntoGroups: boolean;
  /** Generar miniaturas al guardar */
  generateThumbnails: boolean;
  /** Guardado automático (ms, 0 = desactivado) */
  autosaveMs: number;
  /** Apple Pencil: usar presión para el grosor del trazo */
  pencilPressure: boolean;
  /** Sólo Apple Pencil dibuja cuando está el modo dibujo (dedo hace pan) */
  pencilOnlyDraw: boolean;
  /** Clave API opcional para funciones IA (se guarda sólo en este dispositivo) */
  aiApiKey: string;
  /** Modelo de Claude a usar; si no está en la tabla de precios se usa el por defecto */
  aiModel: string;
  /**
   * ID de cliente OAuth de Google para sincronizar con Drive (modo
   * desarrollador). Normalmente viene de `VITE_GOOGLE_CLIENT_ID` en la build;
   * este campo sirve para probar uno sin recompilar. Vacío = usar el de la build.
   */
  googleClientId: string;
  /** Categorías propias para «IA: organizar por categorías», separadas por comas */
  aiCategories: string;
  /** Si es true, la IA propone las categorías según el tablero en vez de usar `aiCategories` */
  aiCategoriesAdHoc: boolean;
  /**
   * Aire del collage: separación entre imágenes como fracción del ancho de
   * columna. Un tablero apretado y uno que respira son decisiones de gusto, y
   * cambian según el uso, así que se guarda como preferencia.
   */
  collageAir: number;
}

/** Opciones de aire del collage (fracción del ancho de columna). */
export const COLLAGE_AIR = { dense: 0.03, balanced: 0.08, wide: 0.18 } as const;

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'es',
  theme: 'dark',
  autoOptimizeMaxSide: 2048,
  optimizeQuality: 0.9,
  autoParent: true,
  dropIntoGroups: true,
  generateThumbnails: true,
  autosaveMs: 5000,
  pencilPressure: true,
  pencilOnlyDraw: true,
  aiApiKey: '',
  // Haiku 4.5: el modelo más barato de la tabla de src/ai/pricing.ts (DEFAULT_AI_MODEL).
  aiModel: 'claude-haiku-4-5',
  googleClientId: '',
  aiCategories: 'Poses, Texturas, Ropa',
  aiCategoriesAdHoc: false,
  collageAir: COLLAGE_AIR.balanced
};

export let appSettings: AppSettings = { ...DEFAULT_SETTINGS };

const listeners = new Set<(s: AppSettings) => void>();

export function onSettingsChange(fn: (s: AppSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Copia de respaldo de la clave API en `localStorage`.
 *
 * La clave vive en IndexedDB junto al resto de los ajustes, pero Safari puede
 * vaciar esa base (o fallar al abrirla) y la clave sólo se ve una vez en la
 * consola de Anthropic: perderla obliga a crear otra. Este espejo permite
 * recuperarla. No cambia quién puede leerla: los dos almacenes pertenecen al
 * mismo origen y nunca salen del dispositivo.
 */
const KEY_BACKUP = 'moodboard.aiApiKey';

/** Lee el respaldo; devuelve '' si no hay o si el almacén no está disponible. */
function readKeyBackup(): string {
  try {
    return localStorage.getItem(KEY_BACKUP) ?? '';
  } catch {
    return '';
  }
}

/** Guarda (o borra) el respaldo. Nunca lanza. */
function writeKeyBackup(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_BACKUP, key);
    else localStorage.removeItem(KEY_BACKUP);
  } catch {
    /* modo privado o almacén lleno: el respaldo es un extra */
  }
}

export async function loadAppSettings(): Promise<AppSettings> {
  const saved = await getKV<Partial<AppSettings>>('appSettings', {});
  appSettings = { ...DEFAULT_SETTINGS, ...saved };
  // si IndexedDB perdió la clave pero queda el respaldo, se restaura
  if (!appSettings.aiApiKey) {
    const backup = readKeyBackup();
    if (backup) {
      appSettings = { ...appSettings, aiApiKey: backup };
      try {
        await setKV('appSettings', appSettings);
      } catch {
        /* si tampoco se puede escribir, al menos la sesión actual la tiene */
      }
    }
  } else if (appSettings.aiApiKey !== readKeyBackup()) {
    writeKeyBackup(appSettings.aiApiKey);
  }
  for (const l of listeners) l(appSettings);
  return appSettings;
}

export async function updateAppSettings(patch: Partial<AppSettings>): Promise<void> {
  appSettings = { ...appSettings, ...patch };
  if (patch.aiApiKey !== undefined) writeKeyBackup(patch.aiApiKey);
  await setKV('appSettings', appSettings);
  for (const l of listeners) l(appSettings);
}
