import CryptoKit
import Foundation

struct InstallerPayload {
    let archive: URL
    let sha256: String
    let bundleIdentifier: String
    let version: String
    let quarantineSource: URL

    static func bundled(in bundle: Bundle) throws -> InstallerPayload {
        guard let archive = bundle.url(forResource: "PiDesk", withExtension: "zip"),
            let sha256 = bundle.object(forInfoDictionaryKey: "PayloadSHA256") as? String,
            let identifier = bundle.object(forInfoDictionaryKey: "PayloadBundleIdentifier") as? String,
            let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        else { throw InstallerFailure.message("安装器缺少应用文件，请重新下载安装包。") }
        return InstallerPayload(
            archive: archive, sha256: sha256, bundleIdentifier: identifier,
            version: version, quarantineSource: bundle.bundleURL)
    }
}

enum InstallerFailure: LocalizedError {
    case message(String)
    case cancelled

    var errorDescription: String? {
        switch self {
        case .message(let value): return value
        case .cancelled: return "安装已取消，原有应用和使用数据未被替换。"
        }
    }
}

final class InstallerCancellation {
    private let condition = NSCondition()
    private var requested = false
    private var awaitingDecision = false
    private var committing = false

    func cancel() {
        condition.lock()
        if !committing { requested = true }
        condition.broadcast()
        condition.unlock()
    }

    func beginDecision() -> Bool {
        condition.lock()
        defer { condition.unlock() }
        guard !committing && !requested && !awaitingDecision else { return false }
        awaitingDecision = true
        return true
    }

    func resolveDecision(cancel: Bool) {
        condition.lock()
        requested = requested || cancel
        awaitingDecision = false
        condition.broadcast()
        condition.unlock()
    }

    func check() throws {
        condition.lock()
        defer { condition.unlock() }
        while awaitingDecision && !requested { condition.wait() }
        if requested { throw InstallerFailure.cancelled }
    }

    func beginCommit() throws {
        condition.lock()
        defer { condition.unlock() }
        while awaitingDecision && !requested { condition.wait() }
        if requested { throw InstallerFailure.cancelled }
        committing = true
    }
}

enum InstallerProgress {
    case preparing
    case copying(Double)
    case committing
}

struct InstallerEngine {
    private let files = FileManager.default
    // 注入移动操作仅用于隔离验证提交失败与旧版本恢复，不改变安装协议。
    var move: (URL, URL) throws -> Void = { try FileManager.default.moveItem(at: $0, to: $1) }

    @discardableResult
    static func run(_ executable: String, _ arguments: [String]) throws -> String {
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = output
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard process.terminationStatus == 0 else {
            throw InstallerFailure.message(
                text.isEmpty ? "操作失败：\(URL(fileURLWithPath: executable).lastPathComponent)" : text)
        }
        return text
    }

    func install(
        payload: InstallerPayload, into directory: URL,
        cancellation: InstallerCancellation, progress: (InstallerProgress) -> Void,
        beforeCommit: () throws -> Void
    ) throws -> URL {
        progress(.preparing)
        try cancellation.check()
        try checkArchive(payload, cancellation: cancellation)
        try files.createDirectory(at: directory, withIntermediateDirectories: true)
        let directory = directory.resolvingSymlinksInPath()
        guard files.isWritableFile(atPath: directory.path) else {
            throw InstallerFailure.message("没有权限写入所选位置，请选择当前用户的“应用程序”文件夹或其他可写目录。")
        }
        let destination = directory.appendingPathComponent("Pi Desk.app", isDirectory: true)
        try validateExisting(destination, identifier: payload.bundleIdentifier)
        let staging = directory.appendingPathComponent(
            ".pi-desk-install-\(UUID().uuidString)", isDirectory: true)
        let unpacked = staging.appendingPathComponent("unpacked", isDirectory: true)
        let candidate = staging.appendingPathComponent("Pi Desk.app", isDirectory: true)
        let previous = staging.appendingPathComponent("previous.app", isDirectory: true)
        var preserveBackup = false
        defer { if !preserveBackup { try? files.removeItem(at: staging) } }
        try files.createDirectory(at: unpacked, withIntermediateDirectories: true)
        try Self.run("/usr/bin/ditto", ["-x", "-k", payload.archive.path, unpacked.path])
        try cancellation.check()
        let source = unpacked.appendingPathComponent("Pi Desk.app", isDirectory: true)
        try validate(source, payload: payload)
        try copyApplication(source, to: candidate, cancellation: cancellation, progress: progress)
        try validate(candidate, payload: payload)
        // 不删除隔离标记，也不绕过 Gatekeeper；保留下载来源的系统安全检查。
        try inheritQuarantine(from: payload.quarantineSource, to: candidate)
        try cancellation.beginCommit()
        progress(.committing)
        try beforeCommit()
        try validateExisting(destination, identifier: payload.bundleIdentifier)
        let replacing = files.fileExists(atPath: destination.path)
        if replacing { try move(destination, previous) }
        do {
            try move(candidate, destination)
        } catch {
            if replacing {
                do { try move(previous, destination) } catch {
                    preserveBackup = true
                    throw InstallerFailure.message(
                        "安装未完成，旧版本保留在：\(previous.path)。请勿删除该目录。恢复失败：\(error.localizedDescription)")
                }
            }
            throw error
        }
        return destination
    }

    private func checkArchive(_ payload: InstallerPayload, cancellation: InstallerCancellation) throws {
        let handle = try FileHandle(forReadingFrom: payload.archive)
        defer { try? handle.close() }
        var hash = SHA256()
        while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty {
            try cancellation.check()
            hash.update(data: data)
        }
        let actual = hash.finalize().map { String(format: "%02x", $0) }.joined()
        guard actual == payload.sha256 else {
            throw InstallerFailure.message("应用文件校验失败，请重新下载安装包。")
        }
    }

    private func validateExisting(_ app: URL, identifier: String) throws {
        let info = try? app.resourceValues(forKeys: [.isSymbolicLinkKey])
        guard info?.isSymbolicLink != true else {
            throw InstallerFailure.message("安装位置已有同名符号链接，请选择其他目录。")
        }
        if files.fileExists(atPath: app.path) {
            guard Bundle(url: app)?.bundleIdentifier == identifier else {
                throw InstallerFailure.message("安装位置已有其他同名文件，不会覆盖。请选择其他目录。")
            }
        }
    }

    private func validate(_ app: URL, payload: InstallerPayload) throws {
        guard let bundle = Bundle(url: app), bundle.bundleIdentifier == payload.bundleIdentifier,
            bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == payload.version,
            let executable = bundle.executableURL, files.isExecutableFile(atPath: executable.path)
        else { throw InstallerFailure.message("内置应用的身份、版本或可执行文件不正确，请重新下载安装包。") }
        try Self.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
    }

    private func copyApplication(
        _ source: URL, to destination: URL,
        cancellation: InstallerCancellation,
        progress: (InstallerProgress) -> Void
    ) throws {
        let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey]
        var enumerationError: Error?
        guard
            let enumerator = files.enumerator(
                at: source, includingPropertiesForKeys: keys,
                errorHandler: { _, error in
                    enumerationError = error
                    return false
                })
        else {
            throw InstallerFailure.message("无法读取内置应用。")
        }
        var entries: [(URL, URLResourceValues)] = []
        for case let url as URL in enumerator {
            try cancellation.check()
            let values = try url.resourceValues(forKeys: Set(keys))
            if values.isSymbolicLink == true {
                let resolved = url.resolvingSymlinksInPath().path
                guard resolved.hasPrefix(source.path + "/") else {
                    throw InstallerFailure.message("应用包含指向外部的符号链接，安装已停止。")
                }
            }
            entries.append((url, values))
        }
        if let enumerationError { throw enumerationError }
        let total = entries.reduce(Int64(0)) { result, entry in
            result
                + (entry.1.isDirectory == true || entry.1.isSymbolicLink == true
                    ? 0 : Int64(entry.1.fileSize ?? 0))
        }
        var copied: Int64 = 0
        try files.createDirectory(at: destination, withIntermediateDirectories: false)
        progress(.copying(0))
        for (url, values) in entries {
            try cancellation.check()
            let relative = String(url.path.dropFirst(source.path.count + 1))
            let target = destination.appendingPathComponent(relative)
            if values.isDirectory == true && values.isSymbolicLink != true {
                try files.createDirectory(at: target, withIntermediateDirectories: false)
            } else {
                try files.copyItem(at: url, to: target)
                if values.isSymbolicLink != true { copied += Int64(values.fileSize ?? 0) }
                progress(.copying(total == 0 ? 1 : Double(copied) / Double(total)))
            }
        }
    }

    private func inheritQuarantine(from source: URL, to destination: URL) throws {
        let name = "com.apple.quarantine"
        let length = getxattr(source.path, name, nil, 0, 0, 0)
        if length < 0 {
            guard errno == ENOATTR else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            return
        }
        var value = Data(count: length)
        let count = value.withUnsafeMutableBytes { getxattr(source.path, name, $0.baseAddress, length, 0, 0) }
        guard count == length else { throw InstallerFailure.message("无法读取安装器的下载来源标记。") }
        let result = value.withUnsafeBytes { setxattr(destination.path, name, $0.baseAddress, length, 0, 0) }
        guard result == 0 else { throw InstallerFailure.message("无法保留系统下载来源标记，安装已停止。") }
    }
}
