# capacitor-icloud-sync

Plugin local de Capacitor 7 que expone a JS el **contenedor de iCloud Drive** de Moodboard
(`iCloud.cl.nicopinto.moodboard`). Todo ocurre dentro de la carpeta `Documents/` del
contenedor, que es la que el usuario ve en **Archivos → iCloud Drive → Moodboard**.

- iOS 14+ (Swift 5.9, SPM y CocoaPods).
- En web/Android `isAvailable()` responde `{ available: false, reason: 'unsupported' }`
  y el resto de los métodos lanza, para que el llamador use su propio fallback.

## Instalación

Ya está enlazado desde la raíz del repo:

```json
"dependencies": {
  "capacitor-icloud-sync": "file:plugins/capacitor-icloud-sync"
}
```

```bash
npm install          # crea el symlink en node_modules/
npx cap sync ios     # instala el pod / paquete SPM en el proyecto Xcode
```

Si se tocan los `.ts` del plugin hay que recompilar su `dist/` (está versionado porque
el app lo importa por `file:`):

```bash
cd plugins/capacitor-icloud-sync && npm run build    # == npx tsc -p .
```

## Uso

```ts
import { ICloudSync } from 'capacitor-icloud-sync';

const status = await ICloudSync.isAvailable();
// { available: true, containerPath: '/private/var/mobile/Library/Mobile Documents/iCloud~cl~nicopinto~moodboard/Documents' }
// o { available: false, reason: 'unsupported' | 'no-account' | 'no-container' }

if (status.available) {
  await ICloudSync.writeText({ path: 'scenes/tablero.json', text: JSON.stringify(scene) });

  const { entries } = await ICloudSync.list({ dir: 'scenes' });
  for (const entry of entries) {
    console.log(entry.name, entry.path, entry.isDir, entry.mtime, entry.size, entry.downloaded);
  }

  const { text } = await ICloudSync.readText({ path: 'scenes/tablero.json' });
  const { data } = await ICloudSync.readFile({ path: 'blobs/foto.jpg' });   // base64
  await ICloudSync.writeFile({ path: 'blobs/foto.jpg', data });             // base64
  await ICloudSync.remove({ path: 'blobs/foto.jpg' });

  await ICloudSync.startWatching();
  const changed = await ICloudSync.addListener('changed', ({ paths }) => {
    // rutas relativas a Documents/ que se agregaron, cambiaron o se borraron
  });
  const availability = await ICloudSync.addListener('availabilityChanged', ({ available }) => {
    // el usuario inició o cerró sesión en iCloud
  });

  // al desmontar
  await changed.remove();
  await availability.remove();
  await ICloudSync.stopWatching();
}
```

## API

Todas las rutas son **relativas a `<container>/Documents/`**, usan `/` como separador y no
pueden ser absolutas ni contener `..` (se rechaza con `INVALID_PATH`).

| Método | Devuelve | Notas |
| --- | --- | --- |
| `isAvailable()` | `{ available, reason?, containerPath? }` | La primera llamada puede tardar (resuelve el contenedor); luego queda cacheada. `containerPath` es la ruta absoluta de `Documents`. |
| `list({ dir })` | `{ entries: ICloudEntry[] }` | No recursivo. Crea `dir` si no existe. `dir: ''` o `'/'` es la raíz. |
| `exists({ path })` | `{ exists, downloaded }` | `exists` es `true` aunque el archivo aún sea un marcador en la nube. |
| `readText({ path })` | `{ text }` | UTF-8. Descarga el archivo si hace falta (espera hasta 60 s). |
| `writeText({ path, text })` | `void` | Atómico, crea las carpetas intermedias. |
| `readFile({ path })` | `{ data }` | base64 sin prefijo `data:`. Descarga si hace falta. |
| `writeFile({ path, data })` | `void` | base64 sin prefijo `data:`. Atómico. |
| `remove({ path })` | `void` | Idempotente: no falla si no existe. Borra carpetas recursivamente. |
| `startWatching()` | `void` | `NSMetadataQuery` sobre `NSMetadataQueryUbiquitousDocumentsScope`. |
| `stopWatching()` | `void` | Idempotente. |

```ts
interface ICloudEntry {
  name: string;        // nombre sin ruta
  path: string;        // ruta relativa a Documents/
  isDir: boolean;
  mtime: number;       // ms desde epoch (contentModificationDate)
  size: number;        // bytes; 0 en carpetas y en archivos no descargados
  downloaded: boolean; // false mientras el contenido siga solo en la nube
}
```

### Eventos

- `changed` → `{ paths: string[] }`: rutas relativas agregadas, modificadas o borradas.
  Al terminar el primer barrido (`NSMetadataQueryDidFinishGathering`) llega un evento con
  todo lo que ya había; después llegan los `NSMetadataQueryDidUpdate` (agrupados cada 1 s).
- `availabilityChanged` → `{ available: boolean }`: se emite con `NSUbiquityIdentityDidChange`
  (el usuario inició o cerró sesión en iCloud). El contenedor cacheado se invalida solo.

### Códigos de error

Los rechazos traen un `code`: `NO_ACCOUNT`, `NO_CONTAINER`, `INVALID_PATH`, `NOT_FOUND`,
`NOT_A_DIRECTORY`, `IS_A_DIRECTORY`, `DOWNLOAD_TIMEOUT`, `INVALID_BASE64`, `INVALID_UTF8`,
`INVALID_ARGUMENT`, o el número de un `NSError` del sistema.

## Configuración en Xcode (obligatoria)

Sin estos dos pasos el plugin responde `{ available: false, reason: 'no-container' }`.

### 1. Capability de iCloud

Target **App** → **Signing & Capabilities** → **+ Capability** → **iCloud**:

- marca **iCloud Documents** (no hace falta Key-value storage ni CloudKit);
- en *Containers*, marca (o crea con **+**) el contenedor **`iCloud.cl.nicopinto.moodboard`**;
- Xcode agrega `App.entitlements` con `com.apple.developer.ubiquity-container-identifiers`.
  El App ID en el portal de Apple Developer debe tener iCloud habilitado con ese contenedor.

### 2. `NSUbiquitousContainers` en `Info.plist`

Sin esta clave la carpeta **no aparece** en la app Archivos. En
`ios/App/App/Info.plist` (Xcode: *Info* → *Custom iOS Target Properties*):

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

Nota de Apple: si cambias esta clave después de publicar, hay que **subir el número de
build** para que iOS vuelva a leerla; en desarrollo a veces hace falta borrar la app del
dispositivo y reinstalar.

## Detalles de implementación

- El contenedor se resuelve con `FileManager.default.url(forUbiquityContainerIdentifier:)`
  siempre en `DispatchQueue.global(qos: .utility)` (la primera llamada puede bloquear) y se
  cachea hasta que cambie la identidad de iCloud.
- `ubiquityIdentityToken == nil` → `reason: 'no-account'`.
- Escrituras y borrados pasan por `NSFileCoordinator` (`.forReplacing` / `.forDeleting`) y
  `Data.write(options: .atomic)`.
- Lecturas: si `URLUbiquitousItemDownloadingStatusKey` no es `.current`, se llama a
  `startDownloadingUbiquitousItem(at:)` y se espera en bucle (0,2 s) hasta 60 s.
- `list` reconoce los marcadores `.nombre.ext.icloud` y los devuelve con el nombre real,
  `downloaded: false` y `size: 0`.

## Archivos

```
plugins/capacitor-icloud-sync/
├── package.json
├── tsconfig.json
├── Package.swift                      # SPM (capacitor-swift-pm, branch main)
├── CapacitorIcloudSync.podspec        # CocoaPods
├── src/{definitions,index,web}.ts
├── dist/esm/                          # generado por tsc y versionado
└── ios/Sources/ICloudSyncPlugin/
    ├── ICloudSyncPlugin.swift         # CAPPlugin + CAPBridgedPlugin (jsName "ICloudSync")
    └── ICloudSync.swift               # implementación
```
