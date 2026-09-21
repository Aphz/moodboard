# Funciones: PureRef 2.1.x ↔ Moodboard

Correspondencia función por función entre PureRef (funciones clásicas + el changelog de
la serie 2.1) y el estado en esta app.

**Leyenda**

- ✅ implementado — se indica el `id` del comando (ver `src/app.ts`) y el atajo cuando existe.
- 🟡 parcial — existe una versión reducida o distinta.
- ❌ no aplica en móvil, o pendiente.

Los atajos se escriben como los registra `src/core/commands.ts`: `Mod` es ⌘ en iPad con
teclado y Ctrl en escritorio. En pantalla se muestran con símbolos Apple (⌘, ⌥, ⇧).

---

## Lienzo y vista

| PureRef | Estado | Detalle |
|---|---|---|
| Lienzo infinito con zoom y paneo | ✅ | Zoom 0,02×–40×; `zoom_in` `Mod+=`, `zoom_out` `Mod+-`, `zoom_100` `Mod+0` |
| Ajustar todo a la vista | ✅ | `zoom_fit` `Mod+1` |
| Ajustar selección a la vista | ✅ | `zoom_selection` `Mod+2` |
| Color del lienzo (incluido transparente) | ✅ | `canvas_color`; `scene.settings.canvasColor` |
| Cuadrícula de fondo con ajuste (2.1.0, `G`) | ✅ | `toggle_grid` `G`; al activarla se activa el ajuste, igual que en 2.1.0.beta3 |
| Ajuste a la cuadrícula por separado | ✅ | `toggle_snap` `Shift+G` |
| Color de la cuadrícula (2.1.0.beta3) | ✅ | Ajustes → Color de cuadrícula; `scene.settings.grid.color` |
| Ajustes de cuadrícula en el diálogo de ajustes además del menú contextual (beta5) | ✅ | Están en Ajustes y en el menú contextual del lienzo |
| Cuadrícula visible con lienzo transparente (fix 2.1.3) | ✅ | La cuadrícula se dibuja siempre que `grid.enabled` |
| No dibujar cuadrícula en modo overlay (beta6) | ❌ | No hay modo overlay en iOS |
| Mantener la transformación de vista al recargar la escena (fix 2.1.3) | ✅ | `viewport` se guarda dentro de la escena |
| Always on top / ventana sin borde / doble clic en la barra de título | ❌ | No aplica: no hay ventanas |
| Perfil de color de pantalla (experimental 2.1.0) | ❌ | Safari administra el color; no hay API equivalente |
| Asignación de núcleos de CPU | ❌ | No aplica en el navegador |

## Imágenes

| PureRef | Estado | Detalle |
|---|---|---|
| Importar archivos | ✅ | `import_images` `Mod+I` (también desde el botón ＋) |
| Importar desde URL | ✅ | `import_url`; valida que la respuesta sea `image/*` |
| Importar un tablero de Pinterest | 🟡 | `import_pinterest`: guía las tres vías que funcionan sin servidor (arrastre en Split View, Fotos, ZIP) y encadena `ai_organize`. El CDN de Pinterest no envía CORS, así que no se descarga por URL. Ver `docs/PINTEREST.md` |
| Importar un ZIP de imágenes sueltas | ✅ | `inspectZip()`: si el ZIP no trae `scene.json` se importan sus imágenes (ignora `__MACOSX` y ocultos) |
| Pegar desde el portapapeles | ✅ | `paste` `Mod+V`; imagen, URL o texto (crea nota) |
| Arrastrar y soltar desde el navegador | ✅ | `dragenter/drop` en `src/app.ts`; archivos, URLs y texto |
| Ajustar posición de lo soltado a la cuadrícula (beta4) | ✅ | La colocación pasa por `snapToGrid` cuando el ajuste está activo |
| Colocar imágenes nuevas en cuadrícula durante la carga (beta5) | ✅ | `importBlobs()` usa `arrangeGrid` para evitar parpadeo |
| Optimizar imágenes al importar (2.1.0) | ✅ | Ajustes → lado máximo (2048 px por defecto) y calidad |
| Recorte con gizmo | ✅ | `crop` `C`; gizmo de recorte en `renderer.drawCropOverlay` |
| Bloqueo de proporción en el recorte (2.1.0) | ✅ | Botón *Bloquear proporción* en la subbarra de recorte |
| Descartar recorte | ✅ | `discard_crop`; recoloca el centro sin mover a los hijos |
| Reemplazar imagen (beta3) | ✅ | `replace_image`; conserva tamaño en escena, limpia el recorte |
| Relink / reubicar archivos | ❌ | No aplica: los bitmaps viven dentro de la app (IndexedDB), no hay rutas externas que se rompan |
| Administrar imágenes (2.1.0) | ✅ | `manage_images`: tamaño por imagen, reducir a lado máximo, recodificar, descartar recortes |
| Indicador de imagen recortada en la jerarquía (2.1.2) | ✅ | Sufijo ✂ en el nombre del ítem del árbol |
| Voltear horizontal / vertical | ✅ | `flip_h` `Shift+H`, `flip_v` `Shift+V` |
| Rotar 90° | ✅ | `rotate_cw` `R`, `rotate_ccw` `Shift+R` |
| Restablecer transformación | ✅ | `reset_transform` `Mod+R` |
| Opacidad de ítems (2.1.0) | ✅ | `opacity` para cualquier ítem; los dibujos heredan la opacidad del pincel |
| GIF animado | 🟡 | Se importa y se detecta, pero se muestra el primer fotograma |
| Descarga con cabecera `Referer` para evitar bloqueos (beta5) | ❌ | El navegador no permite fijar `Referer` desde `fetch` |

## Notas

| PureRef | Estado | Detalle |
|---|---|---|
| Crear nota | ✅ | `tool_note` `N`; auto-emparenta a la imagen o grupo seleccionado |
| Editar nota | ✅ | `edit_item` `Enter` o doble toque; editor superpuesto al ítem |
| Formato de texto | 🟡 | Markdown ligero: `**negrita**`, `*cursiva*`, viñetas `- `, enlaces `[texto](url)`. No hay editor de texto enriquecido completo |
| Viñetas en listas (2.1.1) | 🟡 | Se renderizan; no hay comandos de lista ni corrección de retroceso en listas |
| Alineación del texto (izq./centro/der./justificado) | ✅ | `NoteItem.align`, en la barra del editor |
| Tamaño, color de texto y fondo | ✅ | Barra del editor de notas, con presets de fondo |
| Alto automático con ajuste de línea | ✅ | `NoteItem.autoHeight` + `layoutText()` |
| Recordar la última tipografía usada (fix 2.1.1/2.1.3) | 🟡 | Tipografía del sistema por ítem; no hay selector de fuentes |
| Insertar enlaces | ✅ | Sintaxis markdown en el editor |
| Emparentar nota nueva solo si hay imagen o grupo seleccionado (tweak 2.1.0) | ✅ | `autoParentTarget()`, se puede apagar en Ajustes |
| Pegar una nota no la emparenta a la selección (tweak 2.1.0) | ✅ | `pasteItems()` pega al nivel raíz salvo que se indique un padre |
| Comentario por ítem | ✅ | `comment` `Mod+Shift+M`; texto plano + etiquetas, visible como tooltip en la jerarquía |
| Texto enriquecido en el diálogo de comentario (2.1.0) | 🟡 | El comentario es texto plano |

## Dibujo

| PureRef | Estado | Detalle |
|---|---|---|
| Modo dibujo | ✅ | `toggle_draw` `D` (en PureRef 2.1 pasó a `Ctrl+Shift+D` para liberar `Ctrl+D`; aquí `Mod+D` ya es Duplicar y el dibujo queda en una sola tecla) |
| Lápiz libre | ✅ | `tool_draw_pen` |
| Líneas rectas y formas (2.1.0) | ✅ | `tool_draw_line`, `tool_draw_arrow`, `tool_draw_rect`, `tool_draw_ellipse` |
| Color y grosor del trazo | ✅ | Subbarra de dibujo: 7 colores + selector libre + control de grosor |
| Opacidad del dibujo (2.1.0) | ✅ | `DrawSettings.opacity`, aplicada al crear el ítem |
| Dibujo emparentado al ítem seleccionado, aunque no sea imagen (fix 2.1.3) | 🟡 | Se emparenta a imagen o grupo; sobre otro dibujo seleccionado, los trazos se suman a ese dibujo |
| Círculos pequeños que "no pegan" (fix 2.1.0) | ✅ | Los trazos se recentran con `strokesBounds()`, con tamaño mínimo de 1 unidad |
| No salir del modo dibujo al guardar (fix beta5) | ✅ | El guardado automático no toca la herramienta activa |
| Presión de lápiz | ✅ | **Mejora**: Apple Pencil con presión real, ver más abajo |

## Selección, jerarquía y grupos

| PureRef | Estado | Detalle |
|---|---|---|
| Seleccionar / deseleccionar todo | ✅ | `select_all` `Mod+A`, `deselect` `Mod+Shift+A` |
| Invertir selección | ✅ | `invert_selection` `Mod+Shift+I` |
| Selección múltiple | ✅ | Botón **multi** de la barra, ⇧ + toque, o lazo (`tool_lasso` `L`) |
| Deselección continua (2.1.0, comando asignable) | ❌ | No hay un modo continuo; sí toque a toque con selección múltiple |
| Agrupar / desagrupar | ✅ | `group` `Mod+G`, `ungroup` `Mod+Shift+U` |
| Agregar ítems a un grupo existente seleccionándolo primero (tweak 2.1.0) | ✅ | `groupSelection()` detecta un grupo en la selección y mete el resto dentro |
| Emparentar / quitar padre (2.1.0, `P`) | ✅ | `parent` `P` (elige el ítem más grande como padre), `unparent` `Shift+P` |
| Arrastrar y soltar ítems dentro de grupos (2.1.0) | ✅ | Ajuste *Soltar ítems dentro de grupos*; el grupo bajo el cursor se resalta |
| Tamaño correcto del grupo al mover ítems entre grupos (fix 2.1.3) | ✅ | El grupo no guarda caja propia: se calcula con `subtreeBounds()` |
| Panel de jerarquía | ✅ | `toggle_hierarchy` `H`: árbol, búsqueda, visibilidad, bloqueo, miniaturas |
| Comentario en el tooltip de la jerarquía (2.1.0) | ✅ | `title` de la fila del árbol |
| Bloquear / desbloquear | ✅ | `lock` `Mod+L`, `unlock` `Mod+Shift+L`; también por fila en la jerarquía |
| Desbloquear ítems dentro de un grupo (fix 2.1.3) | ✅ | El botón de bloqueo está en cada fila, a cualquier profundidad |
| Ocultar / mostrar todo | ✅ | `hide` `Mod+Shift+.`, `show_all` |
| Traer al frente / enviar al fondo | ✅ | `bring_front` `Mod+]`, `send_back` `Mod+[`; `z` por nivel de jerarquía |
| El gizmo aparece al seleccionar desde la jerarquía (fix 2.1.3) | ✅ | El gizmo se deriva de la selección, no del gesto |
| Ocultar gizmo y barras durante la transformación (tweak beta6) | ✅ | `overlay.hideGizmo` |
| No cambiar la selección mientras carga (fix 2.1.3) | ✅ | La escena se carga completa antes de emitir `scene` |

## Organizar

| PureRef | Estado | Detalle |
|---|---|---|
| Organizar óptimo | ✅ | `arrange_optimal` `Mod+Shift+O`: empaquetado por estanterías, prueba 9 anchos y minimiza área desperdiciada |
| Organizar en cuadrícula | ✅ | `arrange_grid` `Mod+Shift+G` |
| Organizar en fila / columna | ✅ | `arrange_horizontal` `Mod+Shift+H`, `arrange_vertical` `Mod+Shift+V` |
| Organizar aleatorio (2.1.0, `Ctrl+Alt+R`) | ✅ | `arrange_random` `Mod+Alt+R`; PRNG determinista (`mulberry32`) |
| Usar la proporción de la ventana en todos los métodos (tweak beta5) | ✅ | `viewAspect()` entra como `opts.aspect` en todos los algoritmos |
| Normalizar tamaño | ✅ | `normalize_size` |
| Normalizar área (2.1.0) | ✅ | `normalize_area` |
| Alinear (izq./der./arriba/abajo/centros) | ✅ | `align_left`, `align_right`, `align_top`, `align_bottom`, `align_center_h`, `align_center_v` |
| Distribuir | ✅ | `distribute_h`, `distribute_v` |
| Apilar sin huecos | ✅ | `stack_h`, `stack_v` |
| Separación de alineación (padding) configurable | ✅ | `scene.settings.alignPadding`, en Ajustes |
| Alinear con padding 0 sin dejar huecos (fix 2.1.3) | ✅ | `alignItems()` con `padding` 0 no reordena ni separa |

## Archivo, exportación y portapapeles

| PureRef | Estado | Detalle |
|---|---|---|
| Escena nueva / abrir / guardar | ✅ | `new` `Mod+N`, `open` `Mod+O`, `save` `Mod+S` |
| Guardado periódico | ✅ | Autosave cada 5 s (configurable, 0 = apagado); también al ocultar la app o cerrar la pestaña |
| Guardado periódico que se detiene tras cancelar un guardado (fix 2.1.3) | ✅ | El flag `saving` se libera siempre en `finally` |
| Escenas recientes con miniaturas (2.1.0) | ✅ | `open` muestra la grilla de recientes con miniaturas guardadas |
| Generar miniaturas al guardar, activable (2.1.0) | ✅ | Ajuste *Generar miniaturas al guardar* |
| Widget de escena vacía (fix 2.1.1) | ✅ | `#empty-hint` con la pista de inicio |
| Archivo de escena propio (`.pur`) | ✅ | **Formato abierto `.moodboard`**: `export_scene_file` / `import_scene_file` |
| Exportar como imagen | ✅ | `export_png` `Mod+E` (escala, fondo, PNG/JPEG) |
| Exportar selección como imagen | ✅ | `export_selection_png` `Mod+Shift+E` |
| Exportación de imágenes con hijos (2.1.3) | ✅ | Casilla *Incluir notas y dibujos hijos* |
| Exportar selección como escena a resolución máxima (fix 2.1.2) | ✅ | `exportSceneFile({ onlyItems })` exporta los bitmaps originales, sin reescalar |
| Exportar varias imágenes sin pisar nombres (fix 2.1.3) | 🟡 | La exportación es de un archivo por vez (tablero o selección); no hay exportación por lotes |
| Copiar / cortar / pegar | ✅ | `copy` `Mod+C`, `cut` `Mod+X`, `paste` `Mod+V` |
| Copiar como imagen | ✅ | `copy_as_image` `Mod+Shift+C`; si el sistema no acepta, ofrece compartir |
| Copiar como archivo (beta3) | 🟡 | La hoja de compartir de iOS cumple ese rol; no hay archivo temporal |
| Duplicar (2.1.0, `Ctrl+D`) | ✅ | `duplicate` `Mod+D`, conserva el padre de cada raíz |
| Tamaño máximo de imagen al copiar (beta3) | ❌ | Pendiente; hoy se copia a escala 1× con tope de ~16 Mpx |
| Abrir ubicación de la escena (2.1.0, `Ctrl+Alt+L`) | ❌ | No aplica: no hay sistema de archivos visible |
| CLI | ❌ | No aplica |

## Comandos, atajos y traducciones

| PureRef | Estado | Detalle |
|---|---|---|
| Paleta de comandos | ✅ | `command_palette` `Mod+K` |
| Alias `F3` para la paleta (2.1.2) | ✅ | `command_palette2` `F3` |
| Menú contextual | ✅ | Pulsación larga o clic derecho: menú de lienzo y menú de selección |
| Lista de atajos de teclado | ✅ | `shortcuts` `Mod+/` |
| Reasignar atajos | ❌ | Pendiente: los atajos se declaran en el registro de comandos, no se editan desde la UI |
| Traducciones (2.1.0: chino, francés, japonés, coreano, español) | 🟡 | Español (fuente de verdad) e inglés, con detección del idioma del sistema. Agregar un idioma es un archivo más en `src/i18n/` |
| Ajustes | ✅ | `settings` `Mod+,`: idioma, tema, importación, lápiz, autosave, IA, almacenamiento |

---

## Mejoras respecto a PureRef

Cosas que esta app hace y PureRef no:

- **Paleta de color automática.** Cada imagen guarda su paleta dominante al importarse (mean-cut + fusión perceptual ΔE76 en CIE-Lab, `src/features/palette.ts`). Se puede ver con `extract_palette`, copiar los hex e insertar una nota de paleta con `add_palette_note`.
- **Hash perceptual para duplicados y similares.** dHash de 64 bits por imagen (`src/features/phash.ts`): `find_duplicates` selecciona los grupos con similitud ≥ 0,92 y `ai_find_similar` encuentra parecidos ≥ 0,8 al ítem seleccionado. Es local, instantáneo y no usa red ni IA.
- **Organizar por color.** `arrange_by_color` ordena por tono a partir del color dominante y deja al final lo que no tiene tono (grises, notas, dibujos).
- **IA opcional con tu propia clave.** `ai_describe` resume el tablero en markdown (y lo inserta como nota si quieres); `ai_tag` etiqueta las imágenes seleccionadas en un solo paso de deshacer; `ai_organize` clasifica las imágenes por categorías (las tuyas o las que proponga la IA) y las recoloca en bloques con grupo y título (`src/features/organize.ts`), también en un solo paso de deshacer. Modelo por defecto `claude-haiku-4-5`, clave guardada solo en el dispositivo.
- **Apple Pencil con presión.** El grosor del trazo sigue `pointer.pressure`; el dedo mantiene el paneo mientras el lápiz dibuja. Configurable en Ajustes.
- **Compartir con la hoja nativa de iOS.** Exportar PNG/JPEG o `.moodboard` abre el *share sheet* (`navigator.share` con archivos) para mandarlo a Fotos, Archivos, Mensajes o cualquier app; en escritorio cae a descarga.
- **PWA offline.** Service worker con Workbox y `autoUpdate`: la app arranca sin conexión, avisa cuando hay versión nueva y pide almacenamiento persistente para que iOS no purgue los datos.
- **Formato `.moodboard` abierto.** Un ZIP con `scene.json` (JSON legible) y `blobs/<id>.<ext>`. Se puede abrir con cualquier descompresor, versionar o procesar con un script. Al importar se regeneran todos los IDs, así que el mismo archivo se puede abrir varias veces sin pisar nada.
- **Instantáneas + transacciones.** Un arrastre, un pellizco o un recorte completo son un solo paso de deshacer, sin comandos inversos escritos a mano.
- **Multiescena local.** Varias escenas en el dispositivo con miniaturas, y recolección de basura de bitmaps huérfanos compartidos entre escenas.

## Roadmap sugerido

1. **Sincronización con iCloud Drive / Archivos.** Guardar y abrir `.moodboard` desde el proveedor de archivos del sistema con `@capacitor/filesystem`, para que el tablero viva fuera del sandbox de la app.
2. **Recibir imágenes compartidas desde otras apps** ("Compartir → Moodboard"). En la PWA se resuelve declarando `share_target` en el manifiesto **y** atendiendo el POST a `./share` desde el service worker (hoy no está ninguna de las dos partes, por eso se quitó del manifiesto). En la versión nativa, con una share extension de iOS más `@capacitor/share`.
3. **Colaboración.** Escenas compartidas con CRDT sobre el mismo modelo plano de ítems; hoy el modelo ya es serializable y sin referencias cíclicas, así que el cambio es de transporte, no de datos.
4. **Más tipos de dibujo.** Polilínea, curvas, resaltador, relleno, y borrador por trazo.
5. **Recorte no rectangular.** Máscara por trazado o recorte con forma, apoyado en el recorte por fracciones que ya existe.
6. **Videos y GIF animados en el lienzo.** Reproducción en el Canvas con `requestVideoFrameCallback` y decodificación de GIF por fotogramas.
7. **Reasignar atajos desde la UI.** El registro de comandos ya guarda `shortcut`; falta persistirlos en `kv` y una pantalla para editarlos.
8. **Más idiomas.** La estructura de `src/i18n/` admite nuevos diccionarios sin tocar la app; faltan las traducciones.
9. **Exportación por lotes.** Exportar cada ítem seleccionado como archivo propio, resolviendo colisiones de nombre.
10. **Búsqueda por etiquetas y color.** Filtrar el tablero y la jerarquía por etiqueta, por tono o por parecido perceptual.
