# Moodboard: guía para agentes

App de moodboard para iPhone e iPad (PWA, luego Capacitor). El código, los
comentarios, los textos de la interfaz y las respuestas al usuario van en
**español de Chile: nunca voseo ni acento argentino o uruguayo**.

## Comandos

```
npm run lint    # tsc --noEmit (estricto, noUnusedLocals)
npm test        # vitest (jsdom); todo debe pasar antes de subir
npm run build   # tsc + vite build (PWA con service worker)
```

Antes de dar por terminado cualquier cambio: lint, tests y build limpios.

## Estructura

- `src/core/` modelo plano de ítems (`parentId`, coordenadas absolutas), store
  con instantáneas de deshacer y transacciones (`store.commit`), persistencia en
  IndexedDB (`idb`), ajustes.
- `src/features/` módulos **puros** (organizar, paleta, phash, formato
  `.moodboard`, importación, Pinterest): sin DOM ni store, con tests.
- `src/ai/` cliente directo de la Messages API (clave del usuario, en el
  dispositivo); Haiku 4.5 por defecto; toda función devuelve `usage`.
- `src/sync/` sincronización con Google Drive del usuario (sin servidor).
- `src/ui/` diálogos y barras; `src/render/` Canvas 2D; `src/input/` gestos.
- `src/i18n/es.ts` y `en.ts`: **cada clave nueva va en los dos**.
- `docs/` FEATURES (catálogo de funciones), SYNC, PINTEREST, IOS, ARCHITECTURE.

## Reglas de trabajo

- Un cambio en el lienzo que el usuario percibe como una acción es **una sola
  transacción** (`store.commit`) para que se deshaga en un paso.
- Los módulos de `features/` se prueban en `tests/` sin navegador; la interfaz
  se verifica con Playwright/Chromium (`/opt/pw-browsers/chromium`) contra
  `vite preview`, con los servicios externos simulados con `page.route`.
- Sin servidores propios ni cuentas nuevas para el usuario: todo cliente.
- Costo de IA mínimo: miniaturas pequeñas, lotes, JSON corto, estimación antes
  de llamar y costo real después.
- Nunca desactivar ni saltar tests para dejar CI en verde.
- Commits en español, imperativo, con cuerpo en viñetas cuando hay más de un
  cambio. Documentación (`README.md`, `docs/`) al día con cada función nueva.

## Subagentes del proyecto (`.claude/agents/`)

- `depurador` (Sonnet): arreglos menores y acotados entre PRs.
- `revisor` (Opus): revisión de un diff en busca de errores antes de abrir o
  fusionar un PR.

Atajo: `/depurar <qué arreglar>` delega en `depurador`.
