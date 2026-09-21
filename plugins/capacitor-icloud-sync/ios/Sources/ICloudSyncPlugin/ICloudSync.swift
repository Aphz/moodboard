import Foundation

/// Errores del acceso a iCloud Drive. `code` viaja a JS como `code` del rechazo.
enum ICloudSyncError: LocalizedError {
    case noAccount
    case noContainer
    case invalidPath(String)
    case notFound(String)
    case notADirectory(String)
    case isADirectory(String)
    case downloadTimeout(String)
    case invalidBase64
    case invalidUTF8(String)

    var code: String {
        switch self {
        case .noAccount:
            return "NO_ACCOUNT"
        case .noContainer:
            return "NO_CONTAINER"
        case .invalidPath:
            return "INVALID_PATH"
        case .notFound:
            return "NOT_FOUND"
        case .notADirectory:
            return "NOT_A_DIRECTORY"
        case .isADirectory:
            return "IS_A_DIRECTORY"
        case .downloadTimeout:
            return "DOWNLOAD_TIMEOUT"
        case .invalidBase64:
            return "INVALID_BASE64"
        case .invalidUTF8:
            return "INVALID_UTF8"
        }
    }

    var message: String {
        switch self {
        case .noAccount:
            return "No hay una cuenta de iCloud activa en este dispositivo."
        case .noContainer:
            return "No se pudo abrir el contenedor de iCloud \(ICloudSync.containerIdentifier). Revisa el capability de iCloud Documents y que iCloud Drive esté encendido."
        case .invalidPath(let path):
            return "Ruta inválida: \"\(path)\". Debe ser relativa a Documents y no puede contener \"..\"."
        case .notFound(let path):
            return "No existe: \"\(path)\"."
        case .notADirectory(let path):
            return "No es una carpeta: \"\(path)\"."
        case .isADirectory(let path):
            return "Es una carpeta, no un archivo: \"\(path)\"."
        case .downloadTimeout(let path):
            return "Se agotó el tiempo de espera descargando \"\(path)\" desde iCloud."
        case .invalidBase64:
            return "El campo \"data\" no es base64 válido."
        case .invalidUTF8(let path):
            return "El contenido de \"\(path)\" no es texto UTF-8 válido."
        }
    }

    var errorDescription: String? {
        return message
    }
}

/// Implementación del acceso al contenedor de iCloud Drive de la app.
///
/// Todas las rutas públicas son relativas a `<container>/Documents/`.
/// Ningún método toca el hilo principal salvo el manejo de `NSMetadataQuery`,
/// que se agenda explícitamente en `DispatchQueue.main`.
final class ICloudSync {

    static let containerIdentifier = "iCloud.cl.nicopinto.moodboard"
    static let downloadTimeout: TimeInterval = 60.0
    private static let pollInterval: TimeInterval = 0.2
    private static let placeholderSuffix = ".icloud"

    private let lock = NSLock()
    private var cachedContainerURL: URL?

    // Solo se tocan desde el hilo principal.
    private var query: NSMetadataQuery?
    private var queryObservers: [NSObjectProtocol] = []

    // MARK: - Contenedor

    /// Se llama cuando cambia la identidad de iCloud: el contenedor anterior ya no sirve.
    func invalidateCache() {
        lock.lock()
        cachedContainerURL = nil
        lock.unlock()
    }

    /// Resuelve (y cachea) la URL del contenedor ubicuo.
    /// La primera llamada puede tardar: debe invocarse fuera del hilo principal.
    func containerURL() throws -> URL {
        lock.lock()
        let cached = cachedContainerURL
        lock.unlock()
        if let cached = cached {
            return cached
        }
        if FileManager.default.ubiquityIdentityToken == nil {
            throw ICloudSyncError.noAccount
        }
        guard let resolved = FileManager.default.url(forUbiquityContainerIdentifier: ICloudSync.containerIdentifier) else {
            throw ICloudSyncError.noContainer
        }
        lock.lock()
        cachedContainerURL = resolved
        lock.unlock()
        return resolved
    }

    /// `<container>/Documents`, creada si no existía (es la carpeta visible en Archivos).
    func documentsURL() throws -> URL {
        let docs = try containerURL().appendingPathComponent("Documents", isDirectory: true)
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: docs.path, isDirectory: &isDir) {
            if !isDir.boolValue {
                throw ICloudSyncError.noContainer
            }
        } else {
            try FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true, attributes: nil)
        }
        return docs
    }

    func availability() -> [String: Any] {
        if FileManager.default.ubiquityIdentityToken == nil {
            return ["available": false, "reason": "no-account"]
        }
        do {
            let docs = try documentsURL()
            return ["available": true, "containerPath": docs.path]
        } catch {
            return ["available": false, "reason": "no-container"]
        }
    }

    // MARK: - Rutas

    private func components(of path: String, allowEmpty: Bool) throws -> [String] {
        var parts: [String] = []
        for raw in path.split(separator: "/", omittingEmptySubsequences: true) {
            let part = String(raw)
            if part == "." {
                continue
            }
            if part == ".." {
                throw ICloudSyncError.invalidPath(path)
            }
            parts.append(part)
        }
        if parts.isEmpty && !allowEmpty {
            throw ICloudSyncError.invalidPath(path)
        }
        return parts
    }

    private func resolve(_ path: String, allowEmpty: Bool) throws -> URL {
        let base = try documentsURL()
        var url = base
        for part in try components(of: path, allowEmpty: allowEmpty) {
            url.appendPathComponent(part)
        }
        // Cinturón y tirantes: la ruta final nunca puede salir de Documents.
        let basePath = base.standardizedFileURL.path
        let targetPath = url.standardizedFileURL.path
        if targetPath != basePath {
            let prefix = basePath.hasSuffix("/") ? basePath : basePath + "/"
            if !targetPath.hasPrefix(prefix) {
                throw ICloudSyncError.invalidPath(path)
            }
        } else if !allowEmpty {
            throw ICloudSyncError.invalidPath(path)
        }
        return url
    }

    func resolveDirectory(_ path: String) throws -> URL {
        return try resolve(path, allowEmpty: true)
    }

    func resolveFile(_ path: String) throws -> URL {
        return try resolve(path, allowEmpty: false)
    }

    /// Ruta relativa a `base`, o `nil` si la URL queda fuera.
    /// Prueba varias formas del path porque `/var` y `/private/var` se alternan
    /// y los ítems borrados ya no se pueden resolver contra el disco.
    func relativePath(of url: URL, inside base: URL) -> String? {
        var basePaths: [String] = [base.path, base.standardizedFileURL.path, base.resolvingSymlinksInPath().path]
        basePaths.append("/private" + base.path)
        let itemPaths: [String] = [url.path, url.standardizedFileURL.path, url.resolvingSymlinksInPath().path]
        for basePath in basePaths {
            let prefix = basePath.hasSuffix("/") ? basePath : basePath + "/"
            for itemPath in itemPaths {
                if itemPath == basePath {
                    return ""
                }
                if itemPath.hasPrefix(prefix) {
                    return String(itemPath.dropFirst(prefix.count))
                }
            }
        }
        return nil
    }

    // MARK: - Estado de descarga

    private func placeholderURL(for url: URL) -> URL {
        let name = url.lastPathComponent
        return url.deletingLastPathComponent().appendingPathComponent("." + name + ICloudSync.placeholderSuffix)
    }

    private func downloadingStatus(of url: URL) -> URLUbiquitousItemDownloadingStatus? {
        var probe = URL(fileURLWithPath: url.path)
        probe.removeAllCachedResourceValues()
        guard let values = try? probe.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]) else {
            return nil
        }
        return values.ubiquitousItemDownloadingStatus
    }

    /// `true` si el contenido local está al día (`.current`).
    func isDownloaded(_ url: URL) -> Bool {
        guard let status = downloadingStatus(of: url) else {
            // Sin metadatos ubicuos: si el archivo está en disco, se puede leer.
            return FileManager.default.fileExists(atPath: url.path)
        }
        return status == URLUbiquitousItemDownloadingStatus.current
    }

    /// El ítem existe aunque todavía sea un marcador `.nombre.icloud`.
    func itemExists(_ url: URL) -> Bool {
        let manager = FileManager.default
        if manager.fileExists(atPath: url.path) {
            return true
        }
        return manager.fileExists(atPath: placeholderURL(for: url).path)
    }

    /// Pide la descarga y espera (máx. 60 s) a que el archivo esté disponible.
    func ensureDownloaded(_ url: URL, relativePath path: String) throws {
        let manager = FileManager.default
        if !itemExists(url) {
            throw ICloudSyncError.notFound(path)
        }
        if manager.fileExists(atPath: url.path) && isDownloaded(url) {
            return
        }
        try manager.startDownloadingUbiquitousItem(at: url)
        let deadline = Date().addingTimeInterval(ICloudSync.downloadTimeout)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: ICloudSync.pollInterval)
            if manager.fileExists(atPath: url.path) && isDownloaded(url) {
                return
            }
        }
        throw ICloudSyncError.downloadTimeout(path)
    }

    // MARK: - Lectura / escritura

    func readData(at path: String) throws -> Data {
        let url = try resolveFile(path)
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue {
            throw ICloudSyncError.isADirectory(path)
        }
        try ensureDownloaded(url, relativePath: path)

        var data: Data?
        var accessorError: Error?
        var coordinatorError: NSError?
        let coordinator = NSFileCoordinator(filePresenter: nil)
        coordinator.coordinate(readingItemAt: url, options: [], error: &coordinatorError) { readingURL in
            do {
                data = try Data(contentsOf: readingURL)
            } catch {
                accessorError = error
            }
        }
        if let error = coordinatorError {
            throw error
        }
        if let error = accessorError {
            throw error
        }
        guard let result = data else {
            throw ICloudSyncError.notFound(path)
        }
        return result
    }

    func writeData(_ data: Data, at path: String) throws {
        let url = try resolveFile(path)
        let parent = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true, attributes: nil)

        var accessorError: Error?
        var coordinatorError: NSError?
        let coordinator = NSFileCoordinator(filePresenter: nil)
        coordinator.coordinate(writingItemAt: url, options: .forReplacing, error: &coordinatorError) { writingURL in
            do {
                try data.write(to: writingURL, options: .atomic)
            } catch {
                accessorError = error
            }
        }
        if let error = coordinatorError {
            throw error
        }
        if let error = accessorError {
            throw error
        }
    }

    /// Borrado idempotente: si la ruta no existe, no hace nada.
    func remove(at path: String) throws {
        let url = try resolveFile(path)
        let manager = FileManager.default
        var target = url
        if !manager.fileExists(atPath: url.path) {
            let placeholder = placeholderURL(for: url)
            if manager.fileExists(atPath: placeholder.path) {
                target = placeholder
            } else {
                return
            }
        }

        var accessorError: Error?
        var coordinatorError: NSError?
        let coordinator = NSFileCoordinator(filePresenter: nil)
        coordinator.coordinate(writingItemAt: target, options: .forDeleting, error: &coordinatorError) { deletingURL in
            do {
                try FileManager.default.removeItem(at: deletingURL)
            } catch {
                accessorError = error
            }
        }
        if let error = coordinatorError {
            throw error
        }
        if let error = accessorError {
            throw error
        }
    }

    func exists(at path: String) throws -> [String: Any] {
        let url = try resolveFile(path)
        let manager = FileManager.default
        if manager.fileExists(atPath: url.path) {
            return ["exists": true, "downloaded": isDownloaded(url)]
        }
        if manager.fileExists(atPath: placeholderURL(for: url).path) {
            return ["exists": true, "downloaded": false]
        }
        return ["exists": false, "downloaded": false]
    }

    // MARK: - Listado

    func list(dir: String) throws -> [[String: Any]] {
        let manager = FileManager.default
        let base = try documentsURL()
        let url = try resolveDirectory(dir)

        var isDir: ObjCBool = false
        if manager.fileExists(atPath: url.path, isDirectory: &isDir) {
            if !isDir.boolValue {
                throw ICloudSyncError.notADirectory(dir)
            }
        } else {
            try manager.createDirectory(at: url, withIntermediateDirectories: true, attributes: nil)
            return []
        }

        let keys: [URLResourceKey] = [
            .isDirectoryKey,
            .contentModificationDateKey,
            .fileSizeKey,
            .ubiquitousItemDownloadingStatusKey
        ]
        let children = try manager.contentsOfDirectory(at: url, includingPropertiesForKeys: keys, options: [])

        var entries: [[String: Any]] = []
        for child in children {
            let rawName = child.lastPathComponent
            var name = rawName
            var itemURL = child
            var isPlaceholder = false

            if rawName.hasPrefix(".") {
                if rawName.hasSuffix(ICloudSync.placeholderSuffix) {
                    // ".foto.png.icloud" -> "foto.png" (aún no descargado)
                    let start = rawName.index(rawName.startIndex, offsetBy: 1)
                    let end = rawName.index(rawName.endIndex, offsetBy: -ICloudSync.placeholderSuffix.count)
                    if start >= end {
                        continue
                    }
                    name = String(rawName[start..<end])
                    itemURL = url.appendingPathComponent(name)
                    isPlaceholder = true
                } else {
                    continue // .DS_Store y demás ocultos
                }
            }

            // Ojo: `values?.isDirectory` es doblemente opcional, por eso se
            // desenvuelve en dos pasos en lugar de con `??`.
            let values: URLResourceValues? = try? child.resourceValues(forKeys: Set(keys))

            var isDirectory = false
            if !isPlaceholder, let resourceValues = values {
                if let flag = resourceValues.isDirectory {
                    isDirectory = flag
                }
            }

            var mtime: Double = 0
            if let resourceValues = values {
                if let modified = resourceValues.contentModificationDate {
                    mtime = (modified.timeIntervalSince1970 * 1000.0).rounded()
                }
            }

            var size = 0
            if !isDirectory && !isPlaceholder, let resourceValues = values {
                if let bytes = resourceValues.fileSize {
                    size = bytes
                }
            }

            var downloaded = true
            if isPlaceholder {
                downloaded = false
            } else if !isDirectory {
                downloaded = isDownloaded(itemURL)
            }

            let relative = relativePath(of: itemURL, inside: base) ?? name
            entries.append([
                "name": name,
                "path": relative,
                "isDir": isDirectory,
                "mtime": mtime,
                "size": size,
                "downloaded": downloaded
            ])
        }
        return entries
    }

    // MARK: - NSMetadataQuery

    /// Arranca la observación. Lanza si el contenedor no está disponible.
    /// Debe llamarse fuera del hilo principal (resuelve el contenedor).
    func startWatching(onChanged: @escaping ([String]) -> Void) throws {
        let base = try documentsURL()
        let center = NotificationCenter.default
        DispatchQueue.main.async {
            if self.query != nil {
                return
            }
            let metadataQuery = NSMetadataQuery()
            metadataQuery.searchScopes = [NSMetadataQueryUbiquitousDocumentsScope]
            metadataQuery.predicate = NSPredicate(format: "%K LIKE '*'", NSMetadataItemFSNameKey)
            metadataQuery.notificationBatchingInterval = 1.0

            let gathering = center.addObserver(
                forName: NSNotification.Name.NSMetadataQueryDidFinishGathering,
                object: metadataQuery,
                queue: OperationQueue.main
            ) { [weak self] notification in
                self?.handleGathering(notification, base: base, onChanged: onChanged)
            }
            let updated = center.addObserver(
                forName: NSNotification.Name.NSMetadataQueryDidUpdate,
                object: metadataQuery,
                queue: OperationQueue.main
            ) { [weak self] notification in
                self?.handleUpdate(notification, base: base, onChanged: onChanged)
            }

            self.queryObservers = [gathering, updated]
            self.query = metadataQuery
            metadataQuery.start()
        }
    }

    func stopWatching() {
        DispatchQueue.main.async {
            guard let metadataQuery = self.query else {
                return
            }
            metadataQuery.stop()
            for token in self.queryObservers {
                NotificationCenter.default.removeObserver(token)
            }
            self.queryObservers = []
            self.query = nil
        }
    }

    private func handleGathering(_ notification: Notification, base: URL, onChanged: ([String]) -> Void) {
        guard let metadataQuery = notification.object as? NSMetadataQuery else {
            return
        }
        metadataQuery.disableUpdates()
        var paths: [String] = []
        let total = metadataQuery.resultCount
        var index = 0
        while index < total {
            if let item = metadataQuery.result(at: index) as? NSMetadataItem,
               let path = relativePath(ofItem: item, base: base) {
                paths.append(path)
            }
            index += 1
        }
        metadataQuery.enableUpdates()
        let unique = dedupe(paths)
        if !unique.isEmpty {
            onChanged(unique)
        }
    }

    private func handleUpdate(_ notification: Notification, base: URL, onChanged: ([String]) -> Void) {
        guard let info = notification.userInfo else {
            return
        }
        let keys = [
            NSMetadataQueryUpdateChangedItemsKey,
            NSMetadataQueryUpdateAddedItemsKey,
            NSMetadataQueryUpdateRemovedItemsKey
        ]
        var paths: [String] = []
        for key in keys {
            guard let items = info[key] as? [NSMetadataItem] else {
                continue
            }
            for item in items {
                if let path = relativePath(ofItem: item, base: base) {
                    paths.append(path)
                }
            }
        }
        let unique = dedupe(paths)
        if !unique.isEmpty {
            onChanged(unique)
        }
    }

    private func relativePath(ofItem item: NSMetadataItem, base: URL) -> String? {
        guard let url = item.value(forAttribute: NSMetadataItemURLKey) as? URL else {
            return nil
        }
        guard let relative = relativePath(of: url, inside: base) else {
            return nil
        }
        if relative.isEmpty {
            return nil
        }
        return relative
    }

    private func dedupe(_ paths: [String]) -> [String] {
        var seen = Set<String>()
        var unique: [String] = []
        for path in paths {
            if seen.contains(path) {
                continue
            }
            seen.insert(path)
            unique.append(path)
        }
        return unique
    }
}
