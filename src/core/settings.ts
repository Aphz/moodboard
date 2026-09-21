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
}

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
  aiCategoriesAdHoc: false
};

export let appSettings: AppSettings = { ...DEFAULT_SETTINGS };

const listeners = new Set<(s: AppSettings) => void>();

export function onSettingsChange(fn: (s: AppSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function loadAppSettings(): Promise<AppSettings> {
  const saved = await getKV<Partial<AppSettings>>('appSettings', {});
  appSettings = { ...DEFAULT_SETTINGS, ...saved };
  for (const l of listeners) l(appSettings);
  return appSettings;
}

export async function updateAppSettings(patch: Partial<AppSettings>): Promise<void> {
  appSettings = { ...appSettings, ...patch };
  await setKV('appSettings', appSettings);
  for (const l of listeners) l(appSettings);
}
