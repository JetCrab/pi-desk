import Foundation
import OSLog
import WebKit

struct SharedFile: Identifiable {
    let id = UUID()
    let url: URL
}

@MainActor
final class WebDownloads: NSObject, WKDownloadDelegate {
    private var active: WKDownload?
    private var directory: URL?
    private var destination: URL?
    private let onReady: (SharedFile) -> Void
    private let onFailure: (String) -> Void
    private let logger = Logger(subsystem: "com.jetcrab.ios", category: "downloads")
    private static let prefix = "pi-desk-download-"

    init(onReady: @escaping (SharedFile) -> Void, onFailure: @escaping (String) -> Void) {
        self.onReady = onReady
        self.onFailure = onFailure
        super.init()
    }

    static func clearAbandonedFiles() {
        let files = try? FileManager.default.contentsOfDirectory(
            at: FileManager.default.temporaryDirectory, includingPropertiesForKeys: nil
        )
        for file in files ?? [] where file.lastPathComponent.hasPrefix(prefix) {
            removeDirectory(file)
        }
    }

    func receive(_ download: WKDownload) {
        guard active == nil, directory == nil else {
            download.cancel { _ in }
            onFailure("请先完成当前文件的下载或分享。")
            return
        }
        active = download
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard active === download else {
            completionHandler(nil)
            return
        }
        do {
            let folder = FileManager.default.temporaryDirectory
                .appendingPathComponent(Self.prefix + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            directory = folder
            let candidate = (suggestedFilename as NSString).lastPathComponent
            let name = candidate.isEmpty || candidate == "." || candidate == ".." ? "download" : candidate
            let file = folder.appendingPathComponent(name)
            destination = file
            completionHandler(file)
        } catch {
            completionHandler(nil)
            cancelAll()
            logger.error("创建下载文件失败：\(error.localizedDescription, privacy: .public)")
            onFailure("无法保存下载文件。")
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard active === download, let destination else { return }
        active = nil
        download.delegate = nil
        onReady(SharedFile(url: destination))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        guard active === download else { return }
        active = nil
        download.delegate = nil
        clearSharedFile()
        logger.error("网页下载失败：\(error.localizedDescription, privacy: .public)")
        onFailure(error.localizedDescription)
    }

    func cancelAll() {
        guard let download = active else {
            clearSharedFile()
            return
        }
        let folder = directory
        active = nil
        directory = nil
        destination = nil
        download.delegate = nil
        download.cancel { _ in
            Task { @MainActor in
                if let folder { Self.removeDirectory(folder) }
            }
        }
    }

    func clearSharedFile() {
        if let directory { Self.removeDirectory(directory) }
        directory = nil
        destination = nil
    }

    private static func removeDirectory(_ directory: URL) {
        do {
            try FileManager.default.removeItem(at: directory)
        } catch {
            let logger = Logger(subsystem: "com.jetcrab.ios", category: "downloads")
            logger.warning("清理下载文件失败：\(error.localizedDescription, privacy: .public)")
        }
    }
}
