# Sincronizar tus tableros entre iPhone y iPad

Moodboard funciona sin conexión y sin servidor. Si además quieres que tus
tableros aparezcan en todos tus dispositivos, puedes guardarlos en **tu propio
Google Drive**.

No hay base de datos, no hay cuentas que crear, no hay claves que pegar: un
solo botón.

---

## Para ti, que usas la app

### Conectar

1. Toca el icono de **nube** de la barra superior.
2. Pulsa **Conectar con Google** y elige tu cuenta.
3. Google te va a preguntar si le das permiso a Moodboard para *"ver, editar,
   crear y eliminar solo los archivos específicos de Google Drive que uses con
   esta aplicación"*. Acepta.

Listo. En unos segundos el icono de nube se pone azul (**Al día**) y tus
tableros empiezan a aparecer en el otro dispositivo. En el segundo dispositivo
se repite exactamente lo mismo: abrir la nube y conectar con la misma cuenta.

### Qué vas a ver en tu Drive

En la raíz de tu Google Drive aparece una carpeta llamada **Moodboard** con
dos subcarpetas:

```
Moodboard/
├── scenes/   un archivo .json por tablero
└── blobs/    las imágenes, una sola vez cada una
```

Puedes mirarla, pero no hace falta que toques nada. Si borras la carpeta a
mano, la app la vuelve a crear en la siguiente sincronización y sube de nuevo
lo que tenga guardado en el dispositivo.

**Moodboard no puede ver el resto de tu Drive.** El permiso que pide
(`drive.file`) solo alcanza a los archivos que la propia app crea.

### Qué pasa sin conexión

Nada malo: la app es offline-first. Sigues trabajando igual y el icono de nube
queda en **Sin conexión**. Cuando vuelve la red, todo se sube y se baja solo.

Si editaste el mismo tablero en los dos dispositivos mientras estabas sin
conexión, al reconectar se **fusionan**: de cada ítem queda la edición más
reciente, y lo que borraste no reaparece. El encuadre (zoom y desplazamiento)
nunca se sincroniza: es de cada dispositivo.

Borrar un tablero en un dispositivo lo borra también en el otro.

### Google puede pedirte reconectar cada cierto tiempo

El permiso que da Google dura **una hora**. Normalmente la app lo renueva sola
y en silencio, sin que te enteres.

En **Safari de iPhone y iPad**, las protecciones contra rastreo a veces
bloquean esa renovación silenciosa. Cuando pasa, el icono de nube queda en
**Sin conectar** con el aviso *"Vuelve a conectar con Google"*: abre el
diálogo de la nube y pulsa otra vez **Conectar con Google**. No pierdes nada:
tus tableros están guardados en el dispositivo y en tu Drive.

### Desconectar

Icono de nube → **Desconectar**. La app le pide a Google que retire el
permiso y olvida la sesión de este dispositivo.

Tus tableros locales **se conservan** y los archivos **siguen en tu Drive**
(si quieres borrarlos, elimina la carpeta `Moodboard` desde Google Drive).

### Si el icono de nube dice "No disponible"

Significa que esta versión de la app se compiló sin el ID de cliente de
Google, así que no trae la sincronización habilitada. Tus tableros siguen
guardados en el dispositivo. Quien publica la app tiene que seguir la sección
de abajo.

---

## Para quien publica la app: crear el ID de cliente

Es un trámite de una sola vez. El resultado es un **ID de cliente OAuth** que
se fija en la build; los usuarios finales no ven nada de esto.

El ID de cliente es **público por diseño** (viaja dentro del JavaScript de la
app). No es un secreto y no hay que esconderlo. Lo que protege los datos es el
consentimiento del usuario y el ámbito `drive.file`.

### 1. Crear el proyecto

1. Entra a <https://console.cloud.google.com/>.
2. Arriba, en el selector de proyectos → **Proyecto nuevo**.
3. Ponle un nombre (por ejemplo `Moodboard`) → **Crear**.
4. Asegúrate de tener ese proyecto seleccionado antes de seguir.

### 2. Habilitar la API de Drive

1. Menú lateral → **APIs y servicios** → **Biblioteca**.
2. Busca **Google Drive API** → ábrela → **Habilitar**.

### 3. Pantalla de consentimiento OAuth

1. Menú lateral → **APIs y servicios** → **Pantalla de consentimiento de
   OAuth**.
2. Tipo de usuario: **Externo** → **Crear**.
3. Rellena lo mínimo:
   - **Nombre de la aplicación**: `Moodboard`
   - **Correo de asistencia al usuario**: tu correo
   - **Datos de contacto del desarrollador**: tu correo
4. **Guardar y continuar**.
5. En **Permisos** (scopes) → **Agregar o quitar permisos** y marca estos dos:
   - `https://www.googleapis.com/auth/drive.file`
   - `https://www.googleapis.com/auth/userinfo.email`

   **Actualizar** → **Guardar y continuar**.
6. En **Usuarios de prueba** → **Agregar usuarios** → tu propio correo de
   Gmail (el mismo con el que vas a usar la app). **Guardar y continuar**.

Puedes dejar la app **en modo de prueba**: así funciona de inmediato, sin
pasar por la verificación de Google. La única limitación es que solo entran
los correos que agregaste como usuarios de prueba (hasta 100) y que cada
cierto tiempo Google te pedirá volver a dar el permiso.

Si algún día quieres que entre cualquiera, hay que pulsar **Publicar
aplicación**; con el ámbito `drive.file` Google no exige la verificación
completa, aunque sí muestra una pantalla de advertencia hasta que la hagas.

### 4. Crear el ID de cliente

1. Menú lateral → **APIs y servicios** → **Credenciales**.
2. **Crear credenciales** → **ID de cliente de OAuth**.
3. **Tipo de aplicación**: **Aplicación web**.
4. **Nombre**: `Moodboard web` (da igual, es interno).
5. **Orígenes de JavaScript autorizados** → **Agregar URI**, uno por cada
   sitio desde el que se abre la app:
   - `https://aphz.github.io`
   - `http://localhost:5173`

   > Solo el **origen** (esquema + dominio + puerto), sin la ruta
   > `/moodboard/`. No hace falta rellenar *URI de redireccionamiento*: la app
   > usa el flujo de token de Google Identity Services, que no redirige.
6. **Crear**. Copia el **ID de cliente**: termina en
   `.apps.googleusercontent.com`.

### 5. Fijarlo en la build

La app lee `import.meta.env.VITE_GOOGLE_CLIENT_ID`.

**En local**: copia `.env.example` a `.env` y pega ahí el ID.

```bash
cp .env.example .env
# edita .env y deja algo como:
# VITE_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
npm run dev
```

**En GitHub Pages**: en `.github/workflows/pages.yml`, pásaselo al paso de
build como variable de entorno:

```yaml
      - run: npm run build
        env:
          VITE_GOOGLE_CLIENT_ID: ${{ vars.VITE_GOOGLE_CLIENT_ID }}
```

y define `VITE_GOOGLE_CLIENT_ID` en **Settings → Secrets and variables →
Actions → Variables** del repositorio. (Como el ID es público, una *variable*
basta; también sirve un *secret* con `${{ secrets.… }}`, pero no aporta nada.)

### Probarlo sin recompilar

Si todavía no fijaste la variable, la app deja pegar el ID a mano: icono de
nube → **Avanzado** → *ID de cliente de Google (desarrollador)*. Se guarda en
los ajustes de ese dispositivo (`appSettings.googleClientId`) y sirve para
probar antes de tocar la build. La variable de entorno, si existe, siempre
tiene prioridad.

---

## Cómo funciona por dentro

- **Autenticación**: Google Identity Services (`accounts.google.com/gsi/client`),
  cargado bajo demanda. `initTokenClient` devuelve un `access_token` que se
  guarda en memoria y en IndexedDB (clave `gdriveToken`) para sobrevivir a una
  recarga dentro de la hora. Al vencer se renueva con
  `requestAccessToken({ prompt: '' })`; si esa renovación falla, la app pasa a
  "Sin conectar" y pide volver a conectar.
- **Almacenamiento**: API REST de Drive v3 con `fetch`. Cada tablero es un
  `<sceneId>.json` en `Moodboard/scenes` con
  `appProperties: { kind: 'scene', sceneId, updatedAt }`; cada bitmap es un
  `<blobId>.<ext>` en `Moodboard/blobs` con
  `appProperties: { kind: 'blob', blobId }`. Como los `blobId` son únicos, una
  imagen se sube una sola vez y nunca hay conflictos.
- **Subidas**: `multipart` en un solo viaje (`POST` para crear, `PATCH` sobre
  el mismo endpoint de subida para actualizar).
- **Fusión**: al comparar `modifiedTime` con lo anotado en la última
  sincronización, si cambiaron los dos lados se llama a `mergeScenes`
  (`src/sync/merge.ts`): por ítem gana el `mtime` mayor y los borrados viajan
  como "lápidas" para que nada resucite.
- **Borrado**: lógico. Se marca `appProperties.deleted = '1'` y se refresca
  `modifiedTime`; el otro dispositivo lo ve y borra su copia local. A los 30
  días el archivo se elimina de verdad.
- **Cambios en vivo**: cada 10 s, con la app visible, se consulta
  `changes.list` a partir de `changes.getStartPageToken`; una vez por minuto
  se reconcilia la lista completa (`files.list`) por si el flujo de cambios
  de Drive llega con retraso. Además se sincroniza al volver a la app
  (`visibilitychange`), al recuperar el foco, al recuperar la red y al abrir
  el listado de tableros.
- **Subida de lo local**: 2 s después del último cambio del tablero abierto,
  y nunca dos subidas en menos de 6 s (Drive limita las escrituras por
  archivo). La reconciliación periódica no relee de IndexedDB los tableros
  que no cambiaron ni en Drive ni en el dispositivo.
- **Errores**: un 401 renueva el token una vez; los 403 por cuota, los 429 y
  los 5xx se reintentan con espera exponencial (3 intentos). El usuario solo
  ve mensajes traducidos.

## Límites y privacidad

- Todo ocurre **en el dispositivo**: no hay servidor intermedio ni terceros.
  Los datos van de tu app a tu Drive.
- El espacio lo pone **tu cuenta de Google** (15 GB gratis compartidos con
  Gmail y Fotos). Si te queda corto, baja el tamaño de las imágenes en
  *Ajustes → Optimizar al importar*.
- Con la app en modo de prueba, solo entran los correos agregados como
  usuarios de prueba.
- La sincronización es **opcional**: sin conectar, Moodboard funciona
  completo y sin conexión, y ni siquiera carga el script de Google.

## Problemas frecuentes

| Síntoma | Causa probable |
| --- | --- |
| El icono de nube dice **No disponible** | La build no trae `VITE_GOOGLE_CLIENT_ID`. Ver "Fijarlo en la build". |
| Al conectar, Google dice `Error 400: redirect_uri_mismatch` o `origin_mismatch` | Falta el origen exacto en **Orígenes de JavaScript autorizados** (por ejemplo `https://aphz.github.io` o `http://localhost:5173`), o pusiste la ruta completa en vez del origen. |
| `Error 403: access_denied` | Tu correo no está en **Usuarios de prueba** de la pantalla de consentimiento. |
| "Vuelve a conectar con Google" cada cierto rato en el iPhone | Safari bloqueó la renovación silenciosa. Es normal: vuelve a pulsar Conectar. |
| Las imágenes no aparecen en el otro dispositivo | Todavía se están subiendo, o el dispositivo de origen no ha vuelto a abrirse desde que las importaste. Pulsa **Sincronizar ahora** allá. |
| Estado **Error** en el icono de nube | Abre el diálogo de la nube: muestra el detalle traducido. |
| Borré la carpeta `Moodboard` de Drive | La app la vuelve a crear y sube lo que tenga local. Lo que solo estaba en Drive se pierde. |
