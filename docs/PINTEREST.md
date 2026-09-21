# Importar un tablero de Pinterest

La app no puede bajar los pines por URL: el CDN de imágenes de Pinterest
(`i.pinimg.com`) responde sin cabeceras CORS, así que Safari y Chrome bloquean
la descarga desde una app web. Y la API oficial de Pinterest exige un servidor
con secreto de cliente, que es justo lo que esta app evita. Por eso el tablero
entra como **imágenes** o como un **ZIP**, y la IA se encarga después de
clasificarlo y agruparlo.

Todo empieza en el menú ⋯ → **Importar tablero de Pinterest…**. El diálogo
resume las vías y deja marcada la casilla *Organizar con IA al terminar de
importar*: la siguiente importación (archivos o arrastre) abre sola el paso 2.

## Paso 1: traer las imágenes

### iPad: arrastrar desde Pinterest (lo más rápido)

1. Abre la app de Pinterest y Moodboard una al lado de la otra (Split View o
   Slide Over). Moodboard instalada en la pantalla de inicio funciona igual
   que en Safari.
2. Entra en el tablero, mantén pulsado un pin hasta que se despegue y arrástralo
   sobre el lienzo. Sin soltar, toca otros pines con otro dedo para sumarlos
   al mismo arrastre.
3. Suelta. Cada pin entra como imagen; al soltar tres o más, se abre el paso 2.
   Si sueltas de uno en uno, ejecuta **IA: organizar por categorías** al final.

### iPhone o iPad: por Fotos

1. En Pinterest, en cada pin: Compartir → **Guardar imagen** (van a Fotos).
2. En Moodboard: ＋ → **Importar imágenes** y selecciona todas las fotos guardadas
   de una vez (en el selector de Fotos se pueden tocar varias).

### Cualquier dispositivo: un ZIP

Si ya tienes las imágenes en una carpeta (por ejemplo descargadas desde el Mac
o desde la exportación de datos de Pinterest), comprímela y elígela con
**Elegir imágenes o ZIP…**. Se importan todas las imágenes del ZIP; se ignoran
las carpetas `__MACOSX` y los archivos ocultos. Un `.moodboard` se sigue
abriendo como escena completa.

## Paso 2: organizar con IA

**IA: organizar por categorías** (menú ⋯ o menú de selección, con clave API
configurada en Ajustes):

- **Usar mis categorías**: por defecto `Poses, Texturas, Ropa`, editable y
  recordado. Lo que no encaje va a *Otros*.
- **Que la IA proponga las categorías según este tablero**: la IA elige entre
  3 y 7 categorías cortas adecuadas a lo que ve (por ejemplo *Paleta*,
  *Entorno*, *Tipografía*) y las reutiliza en el resto de lotes.
- **Crear un grupo por categoría** y **Añadir un título** sobre cada bloque.

Resultado: cada categoría queda como un bloque compacto (empaquetado óptimo)
con su título encima, los bloques se reparten según la proporción de la
pantalla, cada imagen recibe la categoría como etiqueta y todo el cambio es un
único paso de deshacer.

### Costo

Se envían miniaturas de 256 px (≈ 90 tokens por imagen) en lotes de 20 y la
respuesta es un JSON corto. Con Haiku 4.5, un tablero de 100 imágenes ronda
los 12 000 tokens de entrada y 2 500 de salida: unos 0,025 US$. El diálogo
muestra la estimación antes de llamar y el costo real después.

## Qué no hace (todavía)

- **Recibir desde la hoja Compartir de iOS.** Safari no admite `share_target`
  en apps web; llegará con la app nativa (Capacitor), que además podrá
  descargar los pines sin la limitación CORS.
- **Pegar la URL del tablero.** Requeriría un servidor intermedio para leer
  Pinterest; queda fuera por diseño mientras la app no tenga servidor.
