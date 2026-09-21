# Importar un tablero de Pinterest

Menú ⋯ → **Importar tablero de Pinterest…**, pega el enlace y listo: los
pines entran al lienzo y, si tienes clave de IA, se abre solo el paso 2. El
mismo diálogo aparece al pegar o soltar un enlace de Pinterest en el lienzo,
o al usar *Importar desde URL* con uno.

## Paso 1: traer las imágenes

### Desde el enlace (lo normal)

Sirve cualquier enlace de tablero o de pin, incluido el acortador `pin.it`
que da la app al compartir, y los tableros compartidos por enlace de
invitación. Detalles que conviene saber:

- **Cuántos pines entran.** Pinterest sólo muestra los primeros 25 pines de
  un tablero sin iniciar sesión, y su RSS público da los 25 más recientes. La
  app une las dos fuentes, así que un tablero de hasta 40-50 pines suele
  entrar completo; de uno más grande entra esa parte, y el aviso final dice
  cuántos de cuántos. Para el resto, las vías de abajo.
- **Calidad.** Se pide el original de cada pin reducido a 1600 px de lado y
  recomprimido en JPEG: sobra para un moodboard y pesa unos 200 KB por pin.
- **Por dónde pasa.** Pinterest no envía cabeceras CORS, así que una app web
  no puede leerlo directamente. El enlace del tablero se lee a través de
  [r.jina.ai](https://r.jina.ai) (Jina Reader) y cada imagen se descarga por
  [wsrv.nl](https://wsrv.nl) (images.weserv.nl), dos servicios públicos y
  gratuitos que sí las envían. Sólo viajan el enlace y las URL públicas de
  las imágenes; nunca nada de tu cuenta. Si un día alguno deja de responder,
  el aviso lo dice y quedan las vías de abajo.
- **Privado de verdad.** Un tablero secreto sin enlace de invitación no se
  puede leer (tampoco desde un navegador sin sesión).

### iPad: arrastrar desde Pinterest

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

- **Tableros grandes completos.** Más allá de los primeros 25-50 pines
  Pinterest exige sesión; la app nativa (Capacitor) podrá leer el tablero
  con la sesión del usuario y sin la limitación CORS.
- **Recibir desde la hoja Compartir de iOS.** Safari no admite `share_target`
  en apps web; llegará con la app nativa.
