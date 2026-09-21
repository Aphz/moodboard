# Empaquetar para iOS con Capacitor 7

La app es una PWA que ya funciona instalándola desde Safari. Este documento cubre el
otro camino: generar el proyecto Xcode con Capacitor y subirlo a TestFlight / App Store.

## Requisitos

- **macOS** con **Xcode 15 o superior** (con Xcode 16 se compila contra el SDK de iOS 18; Capacitor 7 lo soporta sin cambios).
- **Command Line Tools** y **CocoaPods** (`sudo gem install cocoapods` o `brew install cocoapods`).
- **Node 22** (la misma versión que usa el CI).
- **Destino mínimo iOS 14**, que es el mínimo de Capacitor 7. iPhone y iPad; `preferredContentMode: 'mobile'` ya viene fijado en `capacitor.config.ts`.
- Cuenta de **Apple Developer Program** (99 USD/año) para firmar y distribuir.

Capacitor ya está en `devDependencies` (`@capacitor/cli` y `@capacitor/core`, ^7.0.0) y
`capacitor.config.ts` ya apunta a `webDir: 'dist'`.

## Pasos

```bash
# 1. Compilar la web (tsc --noEmit + vite build → dist/)
npm run build

# 2. Crear el proyecto nativo (solo la primera vez; crea ios/, que está en .gitignore)
npx cap add ios

# 3. Copiar dist/ al proyecto nativo y actualizar plugins/pods
npx cap sync

# 4. Abrir en Xcode
npx cap open ios
```

Hay atajos equivalentes en `package.json`: `npm run cap:add:ios`, `npm run cap:sync`,
`npm run cap:open:ios`.

**Cada vez que cambies el código web**: `npm run build && npx cap sync`. `sync` es
`copy` + `update`: copia `dist/` y reinstala los pods de los plugins. Si solo cambió la
web y no los plugins, basta `npx cap copy ios`.

## Bundle id y firma

El identificador ya está fijado en `capacitor.config.ts`:

```ts
appId: 'cl.nicopinto.moodboard',
appName: 'Moodboard',
webDir: 'dist'
```

`npx cap add ios` lo usa como `PRODUCT_BUNDLE_IDENTIFIER` del target. Si lo cambias
después, hay que editarlo también en Xcode (target **App** → *General* → *Identity*),
porque `cap sync` no reescribe el proyecto existente.

En Xcode, con el target **App** seleccionado:

1. **Signing & Capabilities** → marca *Automatically manage signing* y elige tu *Team*.
2. Confirma que el *Bundle Identifier* sea `cl.nicopinto.moodboard` y que exista una App ID con ese identificador en App Store Connect.
3. **General** → *Deployment Info*: destino mínimo iOS 14, orientaciones *Portrait* y *Landscape* (el tablero se usa en ambas), y *Requires full screen* si no quieres Split View.
4. **Info** → agrega las descripciones de uso que correspondan a lo que habilites: `NSPhotoLibraryUsageDescription` y `NSPhotoLibraryAddUsageDescription` si guardas exportaciones en Fotos. Sin estas cadenas, App Review rechaza la app.

## Iconos y splash

Los íconos de la PWA están en `public/icons/` (`icon-192.png`, `icon-512.png`,
`maskable-512.png`, `apple-touch-icon.png`, `icon.svg`) y los usa el manifiesto generado
por `vite-plugin-pwa`. El proyecto nativo necesita su propio set:

- Manual: `ios/App/App/Assets.xcassets/AppIcon.appiconset` — arrastra un PNG de 1024×1024 sin transparencia ni bordes redondeados (Xcode 15+ genera el resto desde el *single size*).
- Automático: `@capacitor/assets` (`npx @capacitor/assets generate --ios`) a partir de un `assets/icon.png` de 1024×1024 y un `assets/splash.png` de 2732×2732. Genera también el `Splash.imageset`.
- Color de fondo del splash y de la web view: `#1e1e1e`, ya declarado en `capacitor.config.ts` (`ios.backgroundColor`) y en el `theme_color` del manifiesto.

## Plugins recomendados

Ninguno está instalado: la app usa solo APIs web. Estos tres mejoran la versión nativa.
Se instalan con `npm i @capacitor/share @capacitor/filesystem @capacitor/haptics` seguido
de `npx cap sync`.

### `@capacitor/share`

- **Qué mejora**: en la web se usa `navigator.share({ files })`, que en iOS funciona pero exige gesto del usuario y falla en silencio en algunos contextos. El plugin abre el *share sheet* nativo de forma consistente.
- **Qué cambiaría en el código**: `shareOrDownload()` en `src/features/exportImage.ts` es el único punto de contacto. Hoy intenta `navigator.canShare({ files })` → `navigator.share()` y, si no, descarga con un `<a download>`. Bastaría con detectar plataforma nativa (`Capacitor.isNativePlatform()`) y, en ese caso, escribir el blob a un archivo temporal con Filesystem y pasar su URI a `Share.share({ files: [uri] })`. El resto de la app no se entera: todos los comandos de exportar y compartir pasan por esa función.

### `@capacitor/filesystem`

- **Qué mejora**: guardar y abrir `.moodboard` y las exportaciones en **Archivos**/iCloud Drive, fuera del sandbox de IndexedDB. También resuelve el archivo temporal que necesita Share.
- **Qué cambiaría en el código**: `exportSceneFile()` / `importSceneFile()` en `src/features/sceneFile.ts` ya trabajan con `Blob` y son agnósticos del destino; se agregaría una capa fina que convierta `Blob` ⇄ base64 y escriba en `Directory.Documents`. Conviene además activar `UIFileSharingEnabled` y `LSSupportsOpeningDocumentsInPlace` en el `Info.plist` para que las escenas aparezcan en la app Archivos.

### `@capacitor/haptics`

- **Qué mejora**: hoy la pulsación larga llama a `navigator.vibrate(8)` (`src/input/gestures.ts`), que **Safari en iOS no implementa**: la retroalimentación táctil simplemente no ocurre. Con el plugin se obtiene el *Taptic Engine* real.
- **Qué cambiaría en el código**: reemplazar esa llamada por `Haptics.impact({ style: ImpactStyle.Light })` detrás de un helper propio, y usarlo también al enganchar en la cuadrícula y al terminar una transformación. Un solo punto de llamada hoy, así que el cambio es local.

Otros que pueden interesar más adelante: `@capacitor/status-bar` (color de la barra de
estado), `@capacitor/keyboard` (ajustar el editor de notas cuando sube el teclado) y
`@capacitor/app` (guardar al pasar a segundo plano; hoy ya se cubre con `visibilitychange`
y `pagehide`).

## iCloud

La sincronización con **iCloud Drive** no usa `@capacitor/filesystem`: vive en un plugin
local del repo, `plugins/capacitor-icloud-sync` (paquete `capacitor-icloud-sync`, enlazado
desde `package.json` con `file:`). Expone a JS el *ubiquity container*
`iCloud.cl.nicopinto.moodboard`, y trabaja siempre dentro de su carpeta `Documents/`, que
es la que el usuario ve en **Archivos → iCloud Drive → Moodboard**.

```bash
npm install            # enlaza node_modules/capacitor-icloud-sync
npx cap sync ios       # instala el pod/paquete SPM del plugin
```

```ts
import { ICloudSync } from 'capacitor-icloud-sync';

const status = await ICloudSync.isAvailable();
// { available: false, reason: 'unsupported' }  → web / Android
// { available: false, reason: 'no-account' }   → sin sesión de iCloud
// { available: false, reason: 'no-container' } → falta el capability o iCloud Drive está apagado
// { available: true, containerPath: '…/Documents' }

await ICloudSync.writeText({ path: 'scenes/tablero.json', text });
const { entries } = await ICloudSync.list({ dir: 'scenes' });
await ICloudSync.startWatching();
const sub = await ICloudSync.addListener('changed', ({ paths }) => { /* rutas relativas */ });
```

La API completa (`isAvailable`, `list`, `exists`, `readText`, `writeText`, `readFile`,
`writeFile`, `remove`, `startWatching`, `stopWatching`, eventos `changed` y
`availabilityChanged`) está documentada en
[`plugins/capacitor-icloud-sync/README.md`](../plugins/capacitor-icloud-sync/README.md).
Los archivos binarios viajan en base64; las rutas son relativas a `Documents/` y no pueden
contener `..`. Las lecturas descargan el archivo si todavía está solo en la nube (espera
hasta 60 s) y las escrituras son atómicas y coordinadas con `NSFileCoordinator`.

### Qué hay que hacer en Xcode

Sin estos dos pasos el plugin responde `{ available: false, reason: 'no-container' }` y la
carpeta no aparece en Archivos.

1. Target **App** → **Signing & Capabilities** → **+ Capability** → **iCloud**; marca
   **iCloud Documents** y, en *Containers*, el contenedor **`iCloud.cl.nicopinto.moodboard`**
   (créalo con **+** si no existe). El App ID en el portal de Apple Developer debe tener
   iCloud habilitado con ese mismo contenedor. Xcode genera `App.entitlements` con
   `com.apple.developer.ubiquity-container-identifiers`.
2. En `ios/App/App/Info.plist`, la clave **`NSUbiquitousContainers`** — es la que hace
   visible la carpeta en la app Archivos:

   ```xml
   <key>NSUbiquitousContainers</key>
   <dict>
     <key>iCloud.cl.nicopinto.moodboard</key>
     <dict>
       <key>NSUbiquitousContainerIsDocumentScopePublic</key>
       <true/>
       <key>NSUbiquitousContainerName</key>
       <string>Moodboard</string>
       <key>NSUbiquitousContainerSupportedFolderLevels</key>
       <string>Any</string>
     </dict>
   </dict>
   ```

   Si cambias esta clave después de instalar, sube el número de *build* (iOS solo la vuelve
   a leer con un build nuevo); en desarrollo puede hacer falta borrar la app y reinstalar.

Para probarlo hace falta un dispositivo o simulador con sesión de iCloud iniciada y iCloud
Drive encendido. Si tocas los `.ts` del plugin, recompila su `dist/` con
`cd plugins/capacitor-icloud-sync && npm run build` (está versionado porque el app lo
importa por `file:`).

## TestFlight

1. En **App Store Connect**, crea la app con el bundle id `cl.nicopinto.moodboard`.
2. En Xcode: *Product* → *Destination* → **Any iOS Device (arm64)**, y luego *Product* → **Archive**.
3. En el **Organizer** que se abre al terminar: *Distribute App* → **App Store Connect** → *Upload*.
4. Espera el procesamiento (unos minutos). Completa el cuestionario de **Export Compliance**: la app usa HTTPS estándar y, si activas las funciones IA, llamadas TLS a `api.anthropic.com`; normalmente aplica la exención de criptografía estándar.
5. **TestFlight** → agrega testers internos (hasta 100, sin revisión) o un grupo externo (requiere revisión de Apple).
6. Sube el número de versión antes de cada archivo nuevo: `version` en `package.json` para la web y *Version*/*Build* en Xcode (el build debe ser único por versión).

Notas para App Review:

- Las funciones IA están apagadas por defecto y requieren que el usuario ingrese su propia clave API: conviene explicarlo en las notas de revisión y dejar claro en la ficha que no hay compras dentro de la app.
- La app no recopila datos: en la ficha de privacidad corresponde declarar *Data Not Collected*. La clave API se guarda solo en el dispositivo.

## Probar en el iPad sin Mac

No necesitas Xcode para iterar: el iPad puede abrir el servidor de desarrollo por la red local.

```bash
npm run dev -- --host      # el script ya incluye --host, esto solo lo hace explícito
```

Vite imprime algo como `Network: http://192.168.1.42:5173/`. Abre esa IP en Safari en el
iPad (misma red Wi-Fi). Para instalarla como app: **Compartir → Añadir a pantalla de inicio**.

### Cuidado con el contexto seguro

Por `http://` en una IP de la LAN, Safari trata la página como **contexto no seguro** y
varias APIs quedan limitadas o ausentes:

- `navigator.clipboard.read()` — pegar imágenes desde el portapapeles del sistema. Sin contexto seguro no existe; la app cae al portapapeles interno (que sí funciona) y al evento `paste`.
- `createImageBitmap` / `OffscreenCanvas` — presentes en Safari moderno, pero su disponibilidad y la del *service worker* dependen del contexto seguro. Sin ellas, `decodeImage()` cae a `<img>` + object URL y `imageTools` usa un `<canvas>` normal: más lento, pero funciona.
- **Service worker** y por lo tanto todo lo offline: solo se registra en HTTPS o `localhost`. En `http://` de red local no hay caché offline ni aviso de actualización.
- `navigator.share({ files })` — la hoja de compartir requiere contexto seguro.

Tres formas de tener HTTPS en desarrollo:

1. **Túnel HTTPS** (lo más simple): `cloudflared tunnel --url http://localhost:5173` o `ngrok http 5173`. Te entrega una URL `https://…` pública que abres en el iPad. Recuerda agregar el host del túnel a `server.allowedHosts` en `vite.config.ts` si Vite lo rechaza.
2. **Certificado local**: `mkcert` + el plugin `@vitejs/plugin-basic-ssl` (o `server.https` con el par de clave/certificado). Hay que instalar la CA de mkcert en el iPad: Ajustes → General → VPN y gestión de dispositivos → instalar el perfil, y luego Ajustes → General → Información → Ajustes de confianza de certificados → confiar en la CA.
3. **Safari Web Inspector por cable**: conecta el iPad por USB, activa Ajustes → Safari → Avanzado → Inspector web, y depura desde Safari del Mac (*Desarrollo* → tu iPad). No resuelve el contexto seguro, pero sí la depuración.

Para probar el build de producción con el service worker: `npm run build && npm run preview`
(también sirve con `--host`), y ábrelo detrás de HTTPS por túnel o certificado local.
