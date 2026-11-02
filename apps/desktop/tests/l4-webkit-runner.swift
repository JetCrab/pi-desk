import AppKit
import Foundation
import WebKit

// 故意不实现原生 confirm：回归必须覆盖桌面壳缺少该处理器的实际边界。
final class TestUI: NSObject, WKUIDelegate {}

final class FixtureScheme: NSObject, WKURLSchemeHandler {
    let directory: URL

    init(directory: URL) {
        self.directory = directory
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        do {
            guard let url = task.request.url else { return }
            let data: Data
            let mime: String
            switch url.path {
            case "/fixture.js":
                data = try Data(contentsOf: directory.appendingPathComponent("fixture.js"))
                mime = "text/javascript"
            case "/style.css":
                data = try Data(contentsOf: directory.appendingPathComponent("style.css"))
                mime = "text/css"
            default:
                data = Data("<!doctype html><html><head><meta charset='utf-8'><link rel='stylesheet' href='/style.css'></head><body><div id='root'></div><script src='/fixture.js'></script></body></html>".utf8)
                mime = "text/html"
            }
            task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: "utf-8"))
            task.didReceive(data)
            task.didFinish()
        } catch {
            task.didFailWithError(error)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class WebKitTest: NSObject {
    let ui = TestUI()
    let view: WKWebView
    var finished = false
    var passed = false
    var polling = false
    var timer: Timer?

    init(directory: URL, scene: String?, dark: Bool, width: CGFloat) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        if #available(macOS 14.0, *) {
            configuration.preferences.inactiveSchedulingPolicy = .none
        }
        configuration.setURLSchemeHandler(FixtureScheme(directory: directory), forURLScheme: "tauri")
        configuration.userContentController.addUserScript(WKUserScript(
            source: "window.addEventListener('error', e => console.error(e.message));",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: 760), configuration: configuration)
        super.init()
        view.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        view.uiDelegate = ui
        let query = scene.map { "?scene=\($0)" } ?? ""
        view.load(URLRequest(url: URL(string: "tauri://localhost/\(query)")!))
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in self?.poll(directory: directory) }
    }

    func poll(directory: URL) {
        guard !polling else { return }
        polling = true
        view.evaluateJavaScript("window.__desktopTest?.done ? JSON.stringify(window.__desktopTest.results) : null") { [self] value, _ in
            polling = false
            guard let json = value as? String else { return }
            timer?.invalidate()
            print(json)
            do {
                let suffix = CommandLine.arguments.dropFirst(2).joined(separator: "-")
                let name = suffix.isEmpty ? "results.json" : "results-\(suffix).json"
                try json.write(to: directory.appendingPathComponent(name), atomically: true, encoding: .utf8)
                let results = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]]
                passed = results?.isEmpty == false && results?.allSatisfy { $0["passed"] as? Bool == true } == true
            } catch {
                fputs("Results could not be read: \(error)\n", stderr)
            }
            if CommandLine.arguments.count > 2, passed {
                view.takeSnapshot(with: nil) { [self] image, error in
                    do {
                        guard let tiff = image?.tiffRepresentation,
                              let bitmap = NSBitmapImageRep(data: tiff),
                              let png = bitmap.representation(using: .png, properties: [:]) else {
                            throw error ?? NSError(domain: "WebKitSnapshot", code: 1)
                        }
                        let name = CommandLine.arguments.dropFirst(2).joined(separator: "-")
                        try png.write(to: directory.appendingPathComponent("\(name).png"))
                    } catch {
                        passed = false
                        fputs("Snapshot failed: \(error)\n", stderr)
                    }
                    finished = true
                }
            } else {
                finished = true
            }
        }
    }
}

guard CommandLine.arguments.count == 2 || CommandLine.arguments.count == 5 else {
    fputs("Usage: webkit-runner <fixture-directory> [stop|pi light|dark width]\n", stderr)
    exit(1)
}
NSApplication.shared.setActivationPolicy(.prohibited)
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let scene = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : nil
let dark = CommandLine.arguments.count > 3 && CommandLine.arguments[3] == "dark"
let width = CommandLine.arguments.count > 4 ? Double(CommandLine.arguments[4]) ?? 1000 : 1000
let test = WebKitTest(directory: directory, scene: scene, dark: dark, width: CGFloat(width))
let deadline = Date().addingTimeInterval(90)
while !test.finished && Date() < deadline {
    RunLoop.main.run(until: Date().addingTimeInterval(0.02))
}
if !test.finished {
    test.view.evaluateJavaScript("JSON.stringify({current:window.__desktopTest?.current,results:window.__desktopTest?.results,html:document.body.innerText.slice(0,2000)})") { value, _ in
        fputs("WebKit timeout: \(value ?? "nil")\n", stderr)
    }
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
}
test.timer?.invalidate()
test.view.stopLoading()
exit(test.finished && test.passed ? 0 : 1)
