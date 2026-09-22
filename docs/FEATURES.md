# Funciones de Moodboard

Catálogo de lo que hace la app, función por función, con el `id` del comando (ver
`src/app.ts`) y el atajo cuando existe.

**Leyenda**

- ✅ listo.
- 🟡 parcial — existe una versión reducida.
- ❌ pendiente, o no aplica en iPhone y iPad.

Los atajos se escriben como los registra `src/core/commands.ts`: `Mod` es ⌘ en iPad con
teclado y Ctrl en escritorio. En pantalla se muestran con símbolos Apple (⌘, ⌥, ⇧).

---

## Lienzo y vista

| Función | Estado | Detalle |
|---|---|---|
| Lienzo infinito con zoom y paneo | ✅ | Zoom 0,02×–40×; `zoom_in` `Mod+=`, `zoom_out` `Mod+-`, `zoom_100` `Mod+0` |
| Ajustar todo a la vista | ✅ | `zoom_fit` `Mod+1` |
| Ajustar selección a la vista | ✅ | `zoom_selection` `Mod+2` |
| Color del lienzo (incluido transparente) | ✅ | `canvas_color`; `scene.settings.canvasColor` |
| Cuadrícula de fondo con ajuste | ✅ | `toggle_grid` `G`; al activarla se activa también el ajuste |
| Ajuste a la cuadrícula por separado | ✅ | `toggle_snap` `Shift+G` |
| Color de la cuadrícula | ✅ | Ajustes → Color de cuadrícula; `scene.settings.grid.color` |
| Cuadrícula en Ajustes y en el menú contextual | ✅ | Los mismos controles en los dos sitios |
| Cuadrícula visible con lienzo transparente | ✅ | Se dibuja siempre que `grid.enabled` |
| Mantener el encuadre al recargar la escena | ✅ | `viewport` se guarda dentro de la escena |
| Perfil de color de pantalla | ❌ | Safari administra el color; no hay API equivalente |

## Imágenes

| Función | Estado | Detalle |
|---|---|---|
| Importar archivos | ✅ | `import_images` `Mod+I` (también desde el botón ＋) |
| Importar desde URL | ✅ | `import_url`; valida que la respuesta sea `image/*` |
| Importar un tablero de Pinterest | ✅ | `import_pinterest`: por enlace (tablero, pin o `pin.it`) leyendo la página vía Jina Reader y bajando los originales por wsrv.nl, porque Pinterest no envía CORS. Rejilla de selección antes de descargar (`src/ui/pinPicker.ts`). Sin sesión Pinterest sólo entrega sus primeros 25 pines. Alternativas: arrastre en Split View, Fotos o ZIP. Encadena `ai_organize`. Ver `docs/PINTEREST.md` |
| Importar un ZIP de imágenes sueltas | ✅ | `inspectZip()`: si el ZIP no trae `scene.json` se importan sus imágenes (ignora `__MACOSX` y ocultos) |
| Pegar desde el portapapeles | ✅ | `paste` `Mod+V`; imagen, URL o texto (crea nota) |
| Arrastrar y soltar desde el navegador | ✅ | `dragenter/drop` en `src/app.ts`; archivos, URLs y texto |
| Ajustar a la cuadrícula lo que se suelta | ✅ | La colocación pasa por `snapToGrid` cuando el ajuste está activo |
| Colocar en cuadrícula durante la carga | ✅ | `importBlobs()` usa `arrangeGrid` para evitar parpadeo |
| Optimizar imágenes al importar | ✅ | Ajustes → lado máximo (2048 px por defecto) y calidad |
| Recorte con gizmo | ✅ | `crop` `C`; gizmo de recorte en `renderer.drawCropOverlay` |
| Bloqueo de proporción en el recorte | ✅ | Botón *Bloquear proporción* en la subbarra de recorte |
| Descartar recorte | ✅ | `discard_crop`; recoloca el centro sin mover a los hijos |
| Reemplazar imagen | ✅ | `replace_image`; conserva tamaño en escena, limpia el recorte |
| Administrar imágenes | ✅ | `manage_images`: tamaño por imagen, reducir a lado máximo, recodificar, descartar recortes |
| Indicador de imagen recortada en la jerarquía | ✅ | Sufijo ✂ en el nombre del ítem del árbol |
| Voltear horizontal / vertical | ✅ | `flip_h` `Shift+H`, `flip_v` `Shift+V` |
| Rotar 90° | ✅ | `rotate_cw` `R`, `rotate_ccw` `Shift+R` |
| Restablecer transformación | ✅ | `reset_transform` `Mod+R` |
| Opacidad de ítems | ✅ | `opacity` para cualquier ítem; los dibujos heredan la opacidad del pincel |
| GIF animado | 🟡 | Se importa y se detecta, pero se muestra el primer fotograma |

## Notas

| Función | Estado | Detalle |
|---|---|---|
| Crear nota | ✅ | `tool_note` `N`; auto-emparenta a la imagen o grupo seleccionado |
| Editar nota | ✅ | `edit_item` `Enter` o doble toque; editor superpuesto al ítem |
| Formato de texto | 🟡 | Markdown ligero: `**negrita**`, `*cursiva*`, viñetas `- `, enlaces `[texto](url)`. No hay editor de texto enriquecido completo |
| Viñetas en listas | 🟡 | Se renderizan; no hay comandos de lista ni corrección de retroceso en listas |
| Alineación del texto (izq./centro/der./justificado) | ✅ | `NoteItem.align`, en la barra del editor |
| Tamaño, color de texto y fondo | ✅ | Barra del editor de notas, con presets de fondo |
| Alto automático con ajuste de línea | ✅ | `NoteItem.autoHeight` + `layoutText()` |
| Elegir tipografía | 🟡 | Tipografía del sistema por ítem; no hay selector de fuentes |
| Insertar enlaces | ✅ | Sintaxis markdown en el editor |
| Emparentar la nota nueva sólo si hay imagen o grupo seleccionado | ✅ | `autoParentTarget()`, se puede apagar en Ajustes |
| Pegar una nota no la emparenta a la selección | ✅ | `pasteItems()` pega al nivel raíz salvo que se indique un padre |
| Comentario por ítem | ✅ | `comment` `Mod+Shift+M`; texto plano + etiquetas, visible como tooltip en la jerarquía |
| Texto enriquecido en el comentario | 🟡 | El comentario es texto plano |

## Dibujo

| Función | Estado | Detalle |
|---|---|---|
| Modo dibujo | ✅ | `toggle_draw` `D` (`Mod+D` ya es Duplicar, así que el dibujo queda en una sola tecla) |
| Lápiz libre | ✅ | `tool_draw_pen` |
| Líneas rectas y formas | ✅ | `tool_draw_line`, `tool_draw_arrow`, `tool_draw_rect`, `tool_draw_ellipse` |
| Color y grosor del trazo | ✅ | Subbarra de dibujo: 7 colores + selector libre + control de grosor |
| Opacidad del dibujo | ✅ | `DrawSettings.opacity`, aplicada al crear el ítem |
| Dibujo emparentado al ítem seleccionado | 🟡 | Se emparenta a imagen o grupo; sobre otro dibujo seleccionado, los trazos se suman a ese dibujo |
| Trazos cortos y cerrados bien centrados | ✅ | Los trazos se recentran con `strokesBounds()`, con tamaño mínimo de 1 unidad |
| No salir del modo dibujo al guardar | ✅ | El guardado automático no toca la herramienta activa |
| Presión de lápiz | ✅ | Apple Pencil con presión real, ver más abajo |

## Selección, jerarquía y grupos

| Función | Estado | Detalle |
|---|---|---|
| Seleccionar / deseleccionar todo | ✅ | `select_all` `Mod+A`, `deselect` `Mod+Shift+A` |
| Invertir selección | ✅ | `invert_selection` `Mod+Shift+I` |
| Selección múltiple | ✅ | Botón **multi** de la barra, ⇧ + toque, o lazo (`tool_lasso` `L`) |
| Agrupar / desagrupar | ✅ | `group` `Mod+G`, `ungroup` `Mod+Shift+U` |
| Agregar ítems a un grupo existente | ✅ | `groupSelection()` detecta un grupo en la selección y mete el resto dentro |
| Emparentar / quitar padre | ✅ | `parent` `P` (elige el ítem más grande como padre), `unparent` `Shift+P` |
| Arrastrar y soltar ítems dentro de grupos | ✅ | Ajuste *Soltar ítems dentro de grupos*; el grupo bajo el cursor se resalta |
| Tamaño correcto del grupo al mover ítems entre grupos | ✅ | El grupo no guarda caja propia: se calcula con `subtreeBounds()` |
| Panel de jerarquía | ✅ | `toggle_hierarchy` `H`: árbol, búsqueda, visibilidad, bloqueo, miniaturas |
| Comentario en el tooltip de la jerarquía | ✅ | `title` de la fila del árbol |
| Bloquear / desbloquear | ✅ | `lock` `Mod+L`, `unlock` `Mod+Shift+L`; también por fila en la jerarquía |
| Desbloquear ítems dentro de un grupo | ✅ | El botón de bloqueo está en cada fila, a cualquier profundidad |
| Ocultar / mostrar todo | ✅ | `hide` `Mod+Shift+.`, `show_all` |
| Traer al frente / enviar al fondo | ✅ | `bring_front` `Mod+]`, `send_back` `Mod+[`; `z` por nivel de jerarquía |
| El gizmo aparece al seleccionar desde la jerarquía | ✅ | El gizmo se deriva de la selección, no del gesto |
| Ocultar gizmo y barras durante la transformación | ✅ | `overlay.hideGizmo` |
| No cambiar la selección mientras carga | ✅ | La escena se carga completa antes de emitir `scene` |

## Organizar

| Función | Estado | Detalle |
|---|---|---|
| Collage en columnas verticales | ✅ | `arrange_masonry` `Mod+Shift+C`: cada imagen al ancho de una columna —dos, si es apaisada— apilada donde el collage llega menos abajo («masonry»), rellenando los claros. Es la disposición por defecto de `ai_organize` |
| Aire del collage | ✅ | Denso, equilibrado o amplio (`appSettings.collageAir`, fracción del ancho de columna): un tablero no se llena de imágenes pegadas y cuánto respira cambia según el uso |
| Símbolos y ornamentos | ✅ | `ornaments`: signos sueltos según el mood del tablero, colocados en los claros sin tapar nada (`src/features/ornaments.ts`) |
| Conectores entre referencias | ✅ | `connect_items`: flechas de borde a borde entre los ítems seleccionados, todas en un solo dibujo |
| Organizar óptimo | ✅ | `arrange_optimal` `Mod+Shift+O`: empaquetado por estanterías, prueba 9 anchos y minimiza área desperdiciada |
| Organizar en cuadrícula | ✅ | `arrange_grid` `Mod+Shift+G` |
| Organizar en fila / columna | ✅ | `arrange_horizontal` `Mod+Shift+H`, `arrange_vertical` `Mod+Shift+V` |
| Organizar aleatorio | ✅ | `arrange_random` `Mod+Alt+R`; PRNG determinista (`mulberry32`) |
| Usar la proporción de la ventana en todos los métodos | ✅ | `viewAspect()` entra como `opts.aspect` en todos los algoritmos |
| Normalizar tamaño | ✅ | `normalize_size` |
| Normalizar área | ✅ | `normalize_area` |
| Alinear (izq./der./arriba/abajo/centros) | ✅ | `align_left`, `align_right`, `align_top`, `align_bottom`, `align_center_h`, `align_center_v` |
| Distribuir | ✅ | `distribute_h`, `distribute_v` |
| Apilar sin huecos | ✅ | `stack_h`, `stack_v` |
| Separación de alineación (padding) configurable | ✅ | `scene.settings.alignPadding`, en Ajustes |
| Alinear con padding 0 sin dejar huecos | ✅ | `alignItems()` con `padding` 0 no reordena ni separa |

## Lápiz y escritura a mano

| Función | Estado | Detalle |
|---|---|---|
| Dibujar sobre el tablero | ✅ | Lápiz, línea, flecha, rectángulo y elipse, con presión del Apple Pencil |
| El lápiz dibuja sin cambiar de herramienta | ✅ | Con `pencilAlwaysDraws` (activado), el Apple Pencil traza aunque esté la herramienta de selección: el dedo sigue seleccionando y moviendo el lienzo. Antes había que entrar en modo dibujo y, si no, trazar sobre una imagen la seleccionaba |
| Escritura a mano en un solo ítem | ✅ | Los trazos seguidos y cercanos se acumulan en el mismo dibujo (`src/features/ink.ts`: 1,5 s de ventana y un margen relativo al trazo); uno lejano o tardío abre otro. Antes se pegaban al ítem seleccionado, viniera de donde viniera |
| Trazar sin marcos de por medio | ✅ | Lo dibujado no queda seleccionado: el gizmo aparecía justo donde iba la letra siguiente y el toque terminaba escalando el trazo anterior |
| Trazo fluido con el tablero lleno | ✅ | Mientras el lápiz está apoyado, la escena se congela en una instantánea y cada punto cuesta un `drawImage` más el trazo (medido con 24 imágenes y 12 notas: 1,04 ms → 0,09 ms por fotograma) |

## Selección y arrastre entre categorías

| Función | Estado | Detalle |
|---|---|---|
| Tocar para seleccionar | ✅ | La hoja primero: tocar una imagen selecciona la imagen aunque esté dentro de un grupo, y volver a tocarla sube al grupo (y al siguiente, si hay anidados). `src/features/selection.ts` |
| Arrastrar lo tocado | ✅ | Un arrastre mueve lo que ya estaba seleccionado en esa rama (un grupo seleccionado se mueve entero) y, si no había nada, la imagen tocada. Subir al grupo es sólo cosa de los toques |
| Mover entre grupos arrastrando | ✅ | Sobre el destino aparece su caja en amarillo con un relleno tenue y el rótulo **Soltar en «X»** / **Adjuntar a «X»**; al sacar algo de su grupo, **Sacar de «X»** |
| Deshacer el cambio de grupo | ✅ | Al soltar, un aviso dice dónde quedó y trae un botón **Deshacer**: el movimiento y el cambio de grupo son un único paso de historial |
| Sacar algo de su grupo | ✅ | La caja del grupo se mide sin contar lo que se arrastra, así que soltar fuera del resto de la categoría saca el ítem (antes la caja seguía al dedo y el grupo se lo quedaba siempre) |
| Lazo | ✅ | `tool_lasso` selecciona los ítems que toca, sin subir a sus grupos |

## Encuadre y rotación

| Función | Estado | Detalle |
|---|---|---|
| Ajustar a la vista / a la selección | ✅ | `zoom_fit` `Mod+1`, `zoom_selection` `Mod+2` (`src/features/viewport.ts`) |
| Encuadre que respeta las barras flotantes | ✅ | El ajuste usa el área libre entre la barra superior, la de herramientas, la subbarra y el panel de jerarquía, medidas del DOM, así que nada queda debajo de ellas ni bajo el área segura de iOS |
| Rotar el dispositivo sin perder el tablero | ✅ | Al cambiar el tamaño del lienzo (rotación, Split View, la barra de Safari) se mantiene centrado lo que estaba al centro; si se veía el tablero completo y encuadrado, se vuelve a encuadrar, y si había zoom puesto en un detalle, se respeta |

## Archivo, exportación y portapapeles

| Función | Estado | Detalle |
|---|---|---|
| Escena nueva / abrir / guardar | ✅ | `new` `Mod+N`, `open` `Mod+O`, `save` `Mod+S` |
| Guardado periódico | ✅ | Autosave cada 5 s (configurable, 0 = apagado); también al ocultar la app o cerrar la pestaña |
| El autosave no se detiene tras cancelar un guardado | ✅ | El flag `saving` se libera siempre en `finally` |
| Escenas recientes con miniaturas | ✅ | `open` muestra la grilla de recientes con miniaturas guardadas |
| Generar miniaturas al guardar, activable | ✅ | Ajuste *Generar miniaturas al guardar* |
| Pista con la escena vacía | ✅ | `#empty-hint` con la pista de inicio |
| Archivo de escena propio | ✅ | Formato abierto `.moodboard`: `export_scene_file` / `import_scene_file` |
| Exportar como imagen | ✅ | `export_png` `Mod+E` (escala, fondo, PNG/JPEG) |
| Exportar selección como imagen | ✅ | `export_selection_png` `Mod+Shift+E` |
| Exportación de imágenes con hijos | ✅ | Casilla *Incluir notas y dibujos hijos* |
| Exportar la selección a resolución máxima | ✅ | `exportSceneFile({ onlyItems })` exporta los bitmaps originales, sin reescalar |
| Exportar varias imágenes de una vez | 🟡 | La exportación es de un archivo por vez (tablero o selección); no hay exportación por lotes |
| Copiar / cortar / pegar | ✅ | `copy` `Mod+C`, `cut` `Mod+X`, `paste` `Mod+V` |
| Copiar como imagen | ✅ | `copy_as_image` `Mod+Shift+C`; si el sistema no acepta, ofrece compartir |
| Copiar como archivo | 🟡 | La hoja de compartir de iOS cumple ese rol; no hay archivo temporal |
| Duplicar | ✅ | `duplicate` `Mod+D`, conserva el padre de cada raíz |
| Tamaño máximo de imagen al copiar | ❌ | Pendiente; hoy se copia a escala 1× con tope de ~16 Mpx |

## Comandos, atajos y traducciones

| Función | Estado | Detalle |
|---|---|---|
| Paleta de comandos | ✅ | `command_palette` `Mod+K` |
| Alias `F3` para la paleta | ✅ | `command_palette2` `F3` |
| Menú contextual | ✅ | Pulsación larga o clic derecho: menú de lienzo y menú de selección |
| Lista de atajos de teclado | ✅ | `shortcuts` `Mod+/` |
| Reasignar atajos | ❌ | Pendiente: los atajos se declaran en el registro de comandos, no se editan desde la UI |
| Traducciones | 🟡 | Español (fuente de verdad) e inglés, con detección del idioma del sistema. Agregar un idioma es un archivo más en `src/i18n/` |
| Ajustes | ✅ | `settings` `Mod+,`: idioma, tema, importación, lápiz, autosave, IA, almacenamiento |

---

## Lo propio de esta app

Lo que la hace distinta de un tablero de imágenes cualquiera:

- **Paleta de color automática.** Cada imagen guarda su paleta dominante al importarse (mean-cut + fusión perceptual ΔE76 en CIE-Lab, `src/features/palette.ts`). Se puede ver con `extract_palette`, copiar los hex e insertar una nota de paleta con `add_palette_note`.
- **Hash perceptual para duplicados y similares.** dHash de 64 bits por imagen (`src/features/phash.ts`): `find_duplicates` selecciona los grupos con similitud ≥ 0,92 y `ai_find_similar` encuentra parecidos ≥ 0,8 al ítem seleccionado. Es local, instantáneo y no usa red ni IA.
- **Organizar por color.** `arrange_by_color` ordena por tono a partir del color dominante y deja al final lo que no tiene tono (grises, notas, dibujos).
- **Clave API a prueba de descuidos.** Se guarda en IndexedDB con respaldo en `localStorage` y se restaura sola si Safari vacía la base; sólo se acepta una cadena con forma de clave, así que un campo vacío o una contraseña autocompletada no la borran, guardar cualquier otra preferencia nunca escribe una clave vacía encima de la buena, y quitarla es un botón con confirmación. Se puede copiar al portapapeles para guardarla en el llavero, y quien sincronice con Drive puede pedir que viva en su carpeta `Moodboard/ajustes.json` (opción apagada por defecto) para no volver a crearla en cada dispositivo.
- **IA opcional con tu propia clave.** `ai_describe` resume el tablero en markdown (y lo inserta como nota si quieres); `ai_tag` etiqueta las imágenes seleccionadas en un solo paso de deshacer; `ai_organize` clasifica las imágenes por categorías (las tuyas o las que proponga la IA) y las recoloca como collage de columnas —las apaisadas a doble ancho y los claros rellenos—, una franja por categoría y con los bloques de alto parejo (`src/features/organize.ts`), también en un solo paso de deshacer. El nombre de la categoría no deja rótulo fijo: aparece flotando sobre el grupo al seleccionarlo. Si el modelo se niega a responder sobre alguna imagen, el lote se parte en dos y se reintenta hasta aislarla: esa queda en «Otros» y se avisa cuántas fueron, en vez de perderse la clasificación entera. Modelo por defecto `claude-haiku-4-5`, clave guardada solo en el dispositivo.
- **Símbolos, ornamentos y conectores.** Lo que distingue un moodboard de una grilla de imágenes. `ornaments` deduce el mood del tablero de sus etiquetas y nombre (catálogo local de siete repertorios: editorial, técnico, romántico, brutalista, retro, natural y nocturno), coloca los signos en los claros y en el margen sin tapar ninguna imagen, y deja elegir cuántos y de qué tamaño. Con clave API, `suggestOrnaments` lee el mood y propone su propio repertorio en una llamada de texto (la más barata de todas; sólo manda seis miniaturas de 192 px si el tablero no tiene ni etiquetas ni grupos). `connect_items` une los ítems seleccionados con flechas de borde a borde. Todo en un solo paso de deshacer.
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
