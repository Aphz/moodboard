# Arquitectura

Aplicación de una sola página, sin framework, sin backend y sin estado en el servidor.
El lienzo es un `<canvas>` 2D; el DOM solo aporta barras, diálogos y el panel de jerarquía.
El flujo es siempre el mismo: **gesto o comando → mutación del store dentro de una
transacción → evento → repintado**.

```text
 index.html
   └─ src/main.ts ──────── registra el service worker, crea App
        └─ src/app.ts ──── orquestador: comandos, autosave, teclado, portapapeles
             ├─ core/store.ts ──── estado + selección + historial   ←── único punto de mutación
             │     └─ core/model.ts ── tipos, geometría, jerarquía (puro)
             ├─ render/renderer.ts ── Canvas 2D (lee store, nunca lo muta)
             ├─ input/gestures.ts ─── Pointer Events → máquina de modos
             ├─ features/* ────────── importar, organizar, exportar, archivo, paleta, phash
             ├─ ui/* ──────────────── barras, menús, diálogos, jerarquía, paleta de comandos
             └─ core/persistence.ts ─ IndexedDB (scenes, blobs, kv)
```

## Módulos y responsabilidades

| Módulo | Responsabilidad | Reglas |
|---|---|---|
| `core/model.ts` | Tipos `Scene`/`Item`, fábricas, geometría (`itemBounds`, `hitTest`, `sceneToLocal`), jerarquía (`childrenOf`, `descendantsOf`, `paintOrder`, `subtreeBounds`) | Puro. Sin DOM, sin store, sin IO |
| `core/store.ts` | Escena activa, selección, historial, emisión de eventos | Único lugar que muta la escena. No conoce el DOM |
| `core/persistence.ts` | IndexedDB: escenas, bitmaps y clave-valor; GC de bitmaps | No conoce el store |
| `core/settings.ts` | Preferencias de la app (no de la escena), con suscriptores | Se persisten en el store `kv` |
| `core/commands.ts` | Registro de comandos, atajos y formateo Apple de los atajos | Sin lógica de negocio |
| `features/*` | Algoritmos y operaciones: organizar, paleta, phash, importar, exportar, portapapeles, `.moodboard` | `arrange`, `palette` y `phash` son **puros** (y por eso se prueban en jsdom) |
| `render/*` | Dibujar la escena, cachear bitmaps, maquetar texto | Solo lee del store |
| `input/gestures.ts` | Traducir Pointer Events a intenciones sobre el store | Abre y cierra transacciones |
| `ui/*` | DOM: barras, menús contextuales, diálogos, jerarquía, paleta de comandos | Solo invocan comandos o mutan vía store |
| `ai/claude.ts` | Cliente HTTP mínimo de la Messages API | Sin dependencias, con timeout y errores tipados |
| `i18n/*` | Diccionarios `es` (fuente de verdad) y `en`, con `t()` | Las claves de `en` deben coincidir con las de `es` |

`src/app.ts` es el pegamento: construye `Renderer` y `GestureController`, registra **todos**
los comandos en un solo arreglo, y concentra el guardado automático, el teclado, el
portapapeles del sistema y el drag & drop.

## Modelo de datos

```ts
Scene { id, version, name, items: Item[], viewport, settings, createdAt, updatedAt }
Item  = ImageItem | NoteItem | DrawingItem | GroupItem
```

- **Lista plana.** `scene.items` es un arreglo plano; la jerarquía se expresa con `parentId`. No hay árboles anidados que clonar ni referencias cíclicas: la escena es JSON puro y serializable tal cual.
- **Coordenadas de escena.** `x, y` es el **centro** del ítem en unidades de lienzo (no píxeles de pantalla), `w, h` el tamaño sin escalar, `rotation` en radianes, `scale` uniforme, `flipX/flipY` booleanos.
- **Padre/hijo con coordenadas absolutas.** Un hijo guarda su posición absoluta, no relativa al padre. Emparentar (`store.setParent`) no toca `x, y`: el ítem no salta. Mover un padre mueve explícitamente a sus descendientes (`descendantsOf` + el mismo delta). La ventaja es que hit-test, render y organización trabajan siempre en el mismo espacio, sin componer matrices; el costo es que el movimiento del padre debe propagarse a mano, en un solo lugar.
- **`z` por nivel.** El orden de pintado es un recorrido en profundidad (`paintOrder`) donde los hermanos se ordenan por `z`. `nextZ(scene, parentId)` calcula el tope de un nivel. Traer al frente o enviar al fondo solo compite con los hermanos, nunca con toda la escena.
- **Los grupos no se dibujan.** `GroupItem` es un contenedor; su caja se calcula con `subtreeBounds()`. Por eso mover ítems entre grupos no deja tamaños desfasados.
- **Las imágenes no llevan píxeles.** `ImageItem.blobId` apunta a un `Blob` del store `blobs`. Un mismo bitmap puede ser referenciado por varios ítems y por varias escenas.
- **Recorte por fracciones.** `crop = { left, top, right, bottom }` en 0..1 del bitmap original, así que el recorte sobrevive a cualquier reescalado o recodificación de la imagen.
- **Datos derivados, calculados al importar**: `palette` (colores dominantes) y `phash` (dHash de 64 bits). Se guardan en el ítem para que organizar por color, buscar duplicados y buscar similares sean instantáneos y offline.

## Historial: instantáneas + transacciones

`core/store.ts` no usa comandos inversos: guarda **instantáneas estructurales** de
`scene.items` y `scene.settings` (`structuredClone`). Es barato porque los ítems son
objetos pequeños y los bitmaps viven fuera, en IndexedDB.

```ts
store.commit(() => { … })           // un paso de deshacer
store.beginTransaction();  …  store.endTransaction();   // anidable
store.cancelTransaction();          // restaura el estado previo (gesto abortado)
```

- Solo el nivel más externo toma la instantánea (`txDepth`), así que `commit` dentro de `commit` sigue siendo un solo paso.
- Un gesto continuo (arrastrar, pellizcar, escalar, recortar) abre la transacción en `pointerdown` y la cierra en `pointerup`: el gesto completo es un paso, no cientos.
- `redoStack` se limpia en cada `endTransaction`. Tope: 200 pasos.
- `restore()` limpia de la selección los ítems que ya no existen.

Eventos emitidos a los suscriptores: `scene`, `items`, `selection`, `viewport`, `settings`,
`history`. El renderizador repinta con cualquiera; el autosave ignora `viewport` y
`selection` para no escribir por un simple paneo.

## Persistencia

IndexedDB `moodboard` versión 1 (vía `idb`), tres stores:

| Store | Clave | Valor |
|---|---|---|
| `scenes` | `meta.id` | `{ scene, meta }` con índice `byUpdated`; `meta` trae nombre, fecha, cantidad de ítems y miniatura JPEG |
| `blobs` | `id` | `{ id, blob, w, h, type }` — un bitmap por entrada, compartido entre escenas |
| `kv` | clave libre | Preferencias (`appSettings`), `lastSceneId`, recientes |

- **Autosave** cada `autosaveMs` (5 s por defecto), más un *flush* en `visibilitychange`, `pagehide` y `beforeunload`. El flag `saving` evita guardados concurrentes y se libera siempre en `finally`.
- **Miniaturas**: se renderiza la escena a 320 px de lado mayor y se guarda como JPEG 0,75 dentro de `meta`. Se puede desactivar.
- **GC de blobs**: `gcBlobs()` recorre todas las escenas guardadas, arma el conjunto de `blobId` vivos y borra el resto. Se invoca desde Ajustes → *Limpiar imágenes huérfanas*. Es necesario porque los bitmaps sobreviven al borrado de un ítem (para que deshacer funcione) y porque una escena eliminada puede dejar huérfanos.
- **Persistencia**: al arrancar se pide `navigator.storage.persist()` para que iOS no purgue los datos bajo presión de espacio; `storageEstimate()` muestra el uso en Ajustes.
- **`.moodboard`**: ZIP con `fflate`. `scene.json` con nivel 6, `blobs/<id>.<ext>` con nivel 0 (ya vienen comprimidos, desinflarlos gastaría CPU del iPad sin ganancia). Al importar se **regeneran todos los IDs** (escena, ítems, blobs) para que el mismo archivo se pueda abrir varias veces sin pisar lo que ya existe.

## Pipeline de importación

`features/importImages.ts` → `ingestBlob()`, por cada imagen:

1. **Optimizar** (`imageTools.optimizeImage`): si el lado mayor supera `autoOptimizeMaxSide` (2048 px por defecto) se reescala y se recodifica con la calidad configurada, preservando alfa cuando el formato lo necesita.
2. **Decodificar** (`decodeImage`): `createImageBitmap(blob, { imageOrientation: 'from-image' })` para respetar el EXIF; si Safari no acepta las opciones, reintenta sin ellas y, como último recurso, usa `<img>` + object URL.
3. **Guardar**: `putBlob(blobId, blob, w, h)` en IndexedDB y `putBitmap()` en la caché en memoria, para que la imagen aparezca sin esperar una lectura de vuelta.
4. **Paleta**: se reduce a 96 px (`imageDataOf`) y se extrae la paleta con `extractPalette` (mean-cut + fusión ΔE76 en CIE-Lab).
5. **phash**: sobre el mismo `ImageData` reducido, `dhash()` produce 64 bits en 16 caracteres hexadecimales.
6. **Colocar**: `importBlobs()` ubica el lote con `arrangeGrid` alrededor del punto de destino (evita el parpadeo de imágenes apiladas) y respeta el ajuste a la cuadrícula.

Los pasos 4 y 5 van dentro de un `try`: si fallan, la imagen se importa igual, solo sin
datos derivados. Todas las rutas de entrada —archivo, portapapeles, URL, drag & drop,
reemplazar imagen— pasan por `ingestBlob`, así que ninguna se salta la optimización ni el
cálculo de paleta y hash.

## Render

`render/renderer.ts`, Canvas 2D:

- **Transformación**: `sx = x * zoom + vx`, `sy = y * zoom + vy`, con `viewport` en píxeles CSS. `sceneToScreen` / `screenToScene` son la conversión canónica y las usan gestos, menús y exportación.
- **DPR**: el backing store se escala por `devicePixelRatio` con tope 3 (más no se nota en Retina y cuesta memoria); el CSS mantiene el tamaño lógico.
- **Bucle**: `requestDraw()` marca sucio y agenda un `requestAnimationFrame`; nunca se dibuja dos veces por frame aunque lleguen muchos eventos.
- **Orden de pintado**: fondo del lienzo → cuadrícula (si está activa) → ítems en `paintOrder(scene)` (profundidad, hermanos por `z`) → trazo en vivo → resaltado de hover → lazo → gizmo → superposición de recorte.
- **Bitmaps**: `imageCache.getBitmap(blobId)` devuelve el bitmap si está listo; si no, dispara la carga desde IndexedDB y avisa con `onBitmapReady` para repintar. Caché LRU de 400 entradas. Mientras tanto se dibuja un marcador, y los blobs perdidos quedan marcados como fallidos para no reintentar en bucle.
- **Gizmo**: se deriva de la selección (no del gesto), con 8 tiradores de escala más uno de rotación desplazado `ROTATE_HANDLE_OFFSET` px. Se oculta durante las transformaciones (`overlay.hideGizmo`) y en modo recorte.
- **Exportación**: `renderToCanvas()` reutiliza exactamente el mismo código de dibujo sobre un canvas fuera de pantalla acotado a la caja de los ítems, con tope de ~16 Mpx (límite práctico de Safari en iOS). Lo que ves es lo que exportas.
- **Texto**: `render/text.ts` maqueta las notas (ajuste de línea, `**negrita**`, `*cursiva*`, viñetas y enlaces) y devuelve líneas con *runs* que el renderizador pinta con `fontString()`.

## Gestos: máquina de modos

`input/gestures.ts` escucha Pointer Events sobre el canvas con `touch-action: none` y
mantiene un mapa de punteros activos y un **modo** explícito:

```text
none → pending → { pan | lasso | move | handle | pinch | pinchItems | draw | crop }
```

- **`pending`**: al tocar no se sabe todavía si es toque, arrastre o pulsación larga. Se arma un temporizador de 480 ms para el menú contextual y se decide al primer movimiento que supere el umbral (10 px con dedo, 4 px con mouse).
- **Ruteo por tipo de puntero**: en modo dibujo, con *pencilOnlyDraw* activo, el dedo entra en `pan` y solo el lápiz entra en `draw`. La presión (`e.pressure`) modula el grosor del trazo si *pencilPressure* está activo.
- **Dos dedos**: `pinch` mueve y hace zoom del lienzo; si el gesto empezó sobre la selección, es `pinchItems` y escala y rota los ítems. Zoom acotado entre 0,02× y 40×.
- **Transacciones**: cada modo que muta abre la transacción al empezar y la cierra al soltar; `pointercancel` la cancela y restaura.
- **Ajuste a la cuadrícula**: se aplica sobre la caja de la selección, no sobre cada ítem, así el conjunto engancha sin deformarse.
- **Doble toque** (≤320 ms) llama a `onEditItem`; la **pulsación larga** selecciona lo que haya debajo, vibra y abre el menú contextual.
- Los gestos nativos de pinch de Safari (`gesturestart`/`gesturechange`/`gestureend`) se cancelan para que el zoom de página no compita con el del lienzo.

## Comandos e i18n

Cada acción se declara **una sola vez** en `registerAllCommands()` (`src/app.ts`) como
`{ id, title, category, icon?, shortcut?, enabled?, run }`. De ese registro salen, sin
duplicar lógica:

- la **paleta de comandos** (`⌘K` / `F3`) con búsqueda difusa,
- los **menús contextuales** y los menús de las barras (`toolbar.entry(id)` toma título, ícono, atajo y estado habilitado del propio comando),
- los **atajos de teclado**: `keyEventToShortcut(e)` normaliza el evento a `Mod+Shift+K` y `findByShortcut()` resuelve el comando,
- el **diálogo de atajos** (`⌘/`).

`enabled()` se evalúa en el momento: un comando deshabilitado no corre ni aparece activo en
los menús. `Mod` es ⌘ o Ctrl según la plataforma, y `formatShortcut()` lo muestra con
símbolos Apple. En dispositivos táctiles los atajos no se muestran en los menús.

Los textos salen de `t(key)` con `src/i18n/es.ts` como **fuente de verdad**: `en.ts` debe
tener exactamente las mismas claves, y `MsgKey` se deriva del tipo de `es`, así que una
clave inventada o faltante es un error de compilación. Agregar un idioma es agregar un
diccionario y una entrada en `dict`.

## Pruebas

Vitest con entorno jsdom (`vite.config.ts` → `test.include: ['tests/**/*.test.ts']`).
Se prueban los módulos que concentran el riesgo y no dependen del navegador:

| Archivo | Qué cubre |
|---|---|
| `tests/arrange.test.ts` | Los 11 algoritmos de organización: un `Placement` por ítem, sin solapes, centro del conjunto preservado, columnas de la cuadrícula, determinismo del aleatorio con la misma semilla, orden por tono, normalizaciones, alineado, distribución y apilado |
| `tests/palette.test.ts` | `extractPalette` (orden por población, independencia del orden de los píxeles, determinismo, fusión de colores casi iguales, alfa), conversiones RGB/HSL/hex y `contrastText` |
| `tests/phash.test.ts` | `grayscaleResize` (promedio por área, gradientes, validación de dimensiones), `dhash`, `hamming`, `similarity`, duplicados y similares |
| `tests/sceneFile.test.ts` | Ida y vuelta del ZIP `.moodboard`: manifiesto, bitmaps, regeneración de IDs, exportación parcial |
| `tests/ai.test.ts` | Cliente de la Messages API con `fetch` mockeado: endpoint y cabeceras (incluida la de acceso directo del navegador), parseo de JSON envuelto en texto, normalización de etiquetas, lotes de 20 imágenes, `AiError` 401 y 429, y que sin clave no se llame a la red |

Lo que **no** se prueba con Vitest —render, gestos, IndexedDB— depende del navegador real
y se verifica a mano en el dispositivo; `playwright` está en `devDependencies` como base
para pruebas de extremo a extremo cuando existan.

`npm run lint` es `tsc --noEmit` con `strict`, `noUnusedLocals`, `noUnusedParameters` y
`noFallthroughCasesInSwitch`: el tipado es parte de la suite, no un extra. El CI
(`.github/workflows/ci.yml`) corre `lint`, `test` y `build` en cada push y pull request.
