/**
 * Registro de comandos: cada acción de la app se declara una vez y queda
 * disponible en la paleta de comandos, los menús contextuales, la barra de
 * herramientas y los atajos de teclado (iPad con teclado).
 */
import { t, type MsgKey } from '../i18n';

export interface Command {
  id: string;
  /** clave i18n del título */
  title: MsgKey;
  /** atajo estilo 'Mod+D', 'Shift+G', 'F3' */
  shortcut?: string;
  category: 'file' | 'edit' | 'view' | 'arrange' | 'item' | 'tools' | 'ai';
  /** icono (nombre en ui/icons.ts) */
  icon?: string;
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

const registry = new Map<string, Command>();

export function registerCommand(cmd: Command) {
  registry.set(cmd.id, cmd);
}

export function registerCommands(cmds: Command[]) {
  for (const c of cmds) registerCommand(c);
}

export function getCommand(id: string): Command | undefined {
  return registry.get(id);
}

export function allCommands(): Command[] {
  return [...registry.values()];
}

export async function runCommand(id: string): Promise<boolean> {
  const c = registry.get(id);
  if (!c) return false;
  if (c.enabled && !c.enabled()) return false;
  await c.run();
  return true;
}

export function commandTitle(c: Command): string {
  return t(c.title);
}

/** Normaliza un evento de teclado a la sintaxis de atajos. */
export function keyEventToShortcut(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join('+');
}

export function findByShortcut(sc: string): Command | undefined {
  for (const c of registry.values()) if (c.shortcut === sc) return c;
  return undefined;
}

/** Formatea el atajo para mostrar en Apple (⌘, ⌥, ⇧). */
export function formatShortcut(sc: string): string {
  return sc
    .replace('Mod', '⌘')
    .replace('Alt', '⌥')
    .replace('Shift', '⇧')
    .replace('Backspace', '⌫')
    .replace('Delete', '⌦')
    .replace('Enter', '↩')
    .replace('Escape', 'esc')
    .replace(/\+/g, '');
}
