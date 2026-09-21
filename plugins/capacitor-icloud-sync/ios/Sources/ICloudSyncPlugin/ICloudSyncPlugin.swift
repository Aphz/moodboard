import Capacitor
import Foundation

/// Puente JS ↔ iCloud Drive. Todo el trabajo de disco corre en una cola de fondo;
/// el contenedor ubicuo se resuelve una vez y queda cacheado.
@objc(ICloudSyncPlugin)
public class ICloudSyncPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "ICloudSyncPlugin"
    public let jsName = "ICloudSync"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exists", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startWatching", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopWatching", returnType: CAPPluginReturnPromise)
    ]

    private let implementation = ICloudSync()
    private var identityObserver: NSObjectProtocol?

    override public func load() {
        identityObserver = NotificationCenter.default.addObserver(
            forName: NSNotification.Name.NSUbiquityIdentityDidChange,
            object: nil,
            queue: OperationQueue.main
        ) { [weak self] _ in
            guard let self = self else {
                return
            }
            self.implementation.invalidateCache()
            let available = FileManager.default.ubiquityIdentityToken != nil
            self.notifyListeners("availabilityChanged", data: ["available": available])
        }
    }

    deinit {
        if let observer = identityObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - Métodos expuestos a JS

    @objc func isAvailable(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .utility).async {
            call.resolve(self.implementation.availability())
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        let dir = call.getString("dir") ?? ""
        run(call) {
            let entries = try self.implementation.list(dir: dir)
            return ["entries": entries]
        }
    }

    @objc func exists(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Falta el parámetro \"path\".", "INVALID_ARGUMENT")
            return
        }
        run(call) {
            return try self.implementation.exists(at: path)
        }
    }

    @objc func readText(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Falta el parámetro \"path\".", "INVALID_ARGUMENT")
            return
        }
        run(call) {
            let data = try self.implementation.readData(at: path)
            guard let text = String(data: data, encoding: String.Encoding.utf8) else {
                throw ICloudSyncError.invalidUTF8(path)
            }
            return ["text": text]
        }
    }

    @objc func writeText(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Falta el parámetro \"path\".", "INVALID_ARGUMENT")
            return
        }
        guard let text = call.getString("text") else {
            call.reject("Falta el parámetro \"text\".", "INVALID_ARGUMENT")
            return
        }
        run(call) {
            let data = Data(text.utf8)
            try self.implementation.writeData(data, at: path)
            return nil
        }
    }

    @objc func readFile(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Falta el parámetro \"path\".", "INVALID_ARGUMENT")
            return
        }
        run(call) {
            let data = try self.implementation.readData(at: path)
            return ["data": data.base64EncodedString()]
        }
    }

    @objc func writeFile(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Falta el parámetro \"path\".", "INVALID_ARGUMENT")
            return
        }
        guard let base64 = call.getString("data") else {
            call.reject("Falta el parámetro \"data\".", "INVALID_ARGUMENT")
            return
        }
        run(call) {
            guard let data = Data(base64Encoded: base64, options: Data.Base64DecodingOptions.ignoreUnknownCharacters) else {
                throw ICloudSyncError.invalidBase64
            }
            try self.implementation.writeData(data, at: path)
            return nil
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Falta el parámetro \"path\".", "INVALID_ARGUMENT")
            return
        }
        run(call) {
            try self.implementation.remove(at: path)
            return nil
        }
    }

    @objc func startWatching(_ call: CAPPluginCall) {
        run(call) { [weak self] in
            guard let plugin = self else {
                return nil
            }
            try plugin.startMetadataWatch()
            return nil
        }
    }

    /// Separado del closure anterior para no anidar dos capturas de `self`.
    private func startMetadataWatch() throws {
        try implementation.startWatching { [weak self] paths in
            self?.notifyListeners("changed", data: ["paths": paths])
        }
    }

    @objc func stopWatching(_ call: CAPPluginCall) {
        implementation.stopWatching()
        call.resolve()
    }

    // MARK: - Utilidades

    /// Ejecuta `work` fuera del hilo principal y resuelve/rechaza la llamada.
    /// Devolver `nil` resuelve la promesa sin datos.
    private func run(_ call: CAPPluginCall, _ work: @escaping () throws -> [String: Any]?) {
        DispatchQueue.global(qos: .utility).async {
            do {
                if let result = try work() {
                    call.resolve(result)
                } else {
                    call.resolve()
                }
            } catch let error as ICloudSyncError {
                call.reject(error.message, error.code, error)
            } catch {
                let nsError = error as NSError
                call.reject(nsError.localizedDescription, String(nsError.code), error)
            }
        }
    }
}
