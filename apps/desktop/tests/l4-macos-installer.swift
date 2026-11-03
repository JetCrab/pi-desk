import AppKit
import CryptoKit

private let files = FileManager.default
private let identifier = "com.jetcrab.desktop.installer-fixture"

private func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw InstallerFailure.message("断言失败：\(message)") }
}

private func expectFailure(_ operation: () throws -> Void) throws {
    var failed = false
    do { try operation() } catch { failed = true }
    try expect(failed, "预期操作失败")
}

private func archive(in root: URL, version: String = "1.2.3", bundleIdentifier: String = identifier) throws
    -> InstallerPayload
{
    let app = root.appendingPathComponent("source/Pi Desk.app")
    let contents = app.appendingPathComponent("Contents")
    try files.createDirectory(at: contents.appendingPathComponent("MacOS"), withIntermediateDirectories: true)
    try files.createDirectory(
        at: contents.appendingPathComponent("Resources"), withIntermediateDirectories: true)
    try files.copyItem(atPath: "/bin/echo", toPath: contents.appendingPathComponent("MacOS/fixture").path)
    let info: [String: Any] = [
        "CFBundleIdentifier": bundleIdentifier, "CFBundleExecutable": "fixture",
        "CFBundlePackageType": "APPL", "CFBundleShortVersionString": version,
    ]
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        .write(to: contents.appendingPathComponent("Info.plist"))
    try Data("fixture resource".utf8).write(to: contents.appendingPathComponent("Resources/data.txt"))
    try files.createSymbolicLink(
        atPath: contents.appendingPathComponent("Resources/alias").path,
        withDestinationPath: "data.txt")
    _ = try InstallerEngine.run("/usr/bin/codesign", ["--force", "--sign", "-", app.path])
    let zip = root.appendingPathComponent("PiDesk.zip")
    _ = try InstallerEngine.run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app.path, zip.path])
    let hash = SHA256.hash(data: try Data(contentsOf: zip)).map { String(format: "%02x", $0) }.joined()
    let marker = root.appendingPathComponent("quarantine-source")
    try Data().write(to: marker)
    return InstallerPayload(
        archive: zip, sha256: hash, bundleIdentifier: bundleIdentifier,
        version: version, quarantineSource: marker)
}

private func install(
    _ payload: InstallerPayload, _ directory: URL,
    cancellation: InstallerCancellation = InstallerCancellation(),
    progress: (InstallerProgress) -> Void = { _ in },
    beforeCommit: () throws -> Void = {}
) throws -> URL {
    try InstallerEngine().install(
        payload: payload, into: directory, cancellation: cancellation,
        progress: progress, beforeCommit: beforeCommit)
}

private func children(_ directory: URL) throws -> [String] {
    try files.contentsOfDirectory(atPath: directory.path).sorted()
}

private func labels(in view: NSView) -> [NSTextField] {
    (view as? NSTextField).map { [$0] } ?? view.subviews.flatMap { labels(in: $0) }
}

private func capture(_ controller: InstallerWindow, at url: URL) throws {
    guard let window = controller.window, let view = window.contentView?.superview else {
        throw InstallerFailure.message("无法取得原生窗口")
    }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    RunLoop.current.run(until: Date().addingTimeInterval(0.15))
    window.displayIfNeeded()
    view.layoutSubtreeIfNeeded()
    guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
        throw InstallerFailure.message("无法创建原生截图")
    }
    view.cacheDisplay(in: view.bounds, to: bitmap)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw InstallerFailure.message("无法编码截图")
    }
    try data.write(to: url)
    for button in [controller.primary, controller.secondary] {
        let bounds = button.convert(button.bounds, to: window.contentView)
        try expect(window.contentView!.bounds.contains(bounds), "主要操作不能超出窗口")
    }
}

@main
struct MacosInstallerTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let payload = try archive(in: root)
        var count = 0
        func test(_ name: String, _ operation: (URL) throws -> Void) throws {
            let directory = root.appendingPathComponent("case-\(count)")
            try files.createDirectory(at: directory, withIntermediateDirectories: true)
            try operation(directory)
            count += 1
            print("PASS \(name)")
        }
        try test("首次安装、真实进度、执行权限与内部符号链接") { directory in
            var fractions: [Double] = []
            let app = try install(
                payload, directory,
                progress: {
                    if case .copying(let value) = $0 { fractions.append(value) }
                })
            try expect(fractions.first == 0 && fractions.last == 1, "复制进度由0到1")
            try expect(fractions == fractions.sorted(), "复制进度单调")
            try expect(
                files.isExecutableFile(atPath: app.appendingPathComponent("Contents/MacOS/fixture").path),
                "保留执行权限")
            try expect(
                try String(
                    contentsOf: app.appendingPathComponent("Contents/Resources/alias"), encoding: .utf8)
                    == "fixture resource", "保留内部符号链接")
            try expect(try children(directory) == ["Pi Desk.app"], "成功后清理暂存目录")
        }
        try test("同版本覆盖不删除使用数据") { directory in
            _ = try install(payload, directory)
            let data = directory.appendingPathComponent("user-data.json")
            try Data("keep".utf8).write(to: data)
            _ = try install(payload, directory)
            try expect(try String(contentsOf: data, encoding: .utf8) == "keep", "用户数据不变")
        }
        try test("校验失败不替换已有应用") { directory in
            _ = try install(payload, directory)
            let broken = InstallerPayload(
                archive: payload.archive, sha256: "wrong", bundleIdentifier: identifier,
                version: payload.version, quarantineSource: payload.quarantineSource)
            try expectFailure { _ = try install(broken, directory) }
            try expect(try children(directory) == ["Pi Desk.app"], "原应用保留")
        }
        try test("开始前取消无文件写入") { directory in
            let cancellation = InstallerCancellation()
            cancellation.cancel()
            try expectFailure { _ = try install(payload, directory, cancellation: cancellation) }
            try expect(try children(directory).isEmpty, "取消没有写入")
        }
        try test("复制期间取消保留旧版并清理暂存") { directory in
            _ = try install(payload, directory)
            let cancellation = InstallerCancellation()
            try expectFailure {
                _ = try install(
                    payload, directory, cancellation: cancellation,
                    progress: {
                        if case .copying = $0 { cancellation.cancel() }
                    })
            }
            try expect(try children(directory) == ["Pi Desk.app"], "旧版仍在，暂存已清理")
        }
        try test("提交边界前已接受的取消不替换旧版") { directory in
            _ = try install(payload, directory)
            let cancellation = InstallerCancellation()
            var committed = false
            try expectFailure {
                _ = try install(
                    payload, directory, cancellation: cancellation,
                    progress: {
                        if case .copying(let value) = $0, value == 1 { cancellation.cancel() }
                    }, beforeCommit: { committed = true })
            }
            try expect(!committed, "取消后不请求退出旧应用")
            try expect(try children(directory) == ["Pi Desk.app"], "原应用保留")
        }
        try test("取消确认期间阻止安装提交") { directory in
            let cancellation = InstallerCancellation()
            try expect(cancellation.beginDecision(), "接纳取消确认")
            let started = DispatchSemaphore(value: 0)
            let finished = DispatchSemaphore(value: 0)
            let committed = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                defer { finished.signal() }
                _ = try? install(
                    payload, directory, cancellation: cancellation,
                    progress: { _ in started.signal() }, beforeCommit: { committed.signal() })
            }
            try expect(started.wait(timeout: .now() + 5) == .success, "安装线程已开始")
            try expect(finished.wait(timeout: .now() + 0.1) == .timedOut, "等待用户决定")
            cancellation.resolveDecision(cancel: true)
            try expect(finished.wait(timeout: .now() + 5) == .success, "取消后正常结束")
            try expect(committed.wait(timeout: .now()) == .timedOut, "不替换旧应用")
            try expect(try children(directory).isEmpty, "无应用写入")
        }
        try test("继续安装后封闭提交阶段的取消入口") { _ in
            let cancellation = InstallerCancellation()
            try expect(cancellation.beginDecision(), "接纳确认")
            cancellation.resolveDecision(cancel: false)
            try cancellation.beginCommit()
            try expect(!cancellation.beginDecision(), "提交阶段不再弹出取消确认")
            cancellation.cancel()
            try cancellation.check()
        }
        try test("退出旧应用失败不提交") { directory in
            _ = try install(payload, directory)
            try expectFailure {
                _ = try install(payload, directory, beforeCommit: { throw InstallerFailure.message("退出超时") })
            }
            try expect(try children(directory) == ["Pi Desk.app"], "退出失败保留原应用")
        }
        try test("移动新应用失败恢复旧版") { directory in
            _ = try install(payload, directory)
            var engine = InstallerEngine()
            engine.move = { source, destination in
                if source.lastPathComponent == "Pi Desk.app" && source.path.contains(".pi-desk-install-") {
                    throw InstallerFailure.message("模拟写入失败")
                }
                try files.moveItem(at: source, to: destination)
            }
            try expectFailure {
                _ = try engine.install(
                    payload: payload, into: directory, cancellation: .init(), progress: { _ in },
                    beforeCommit: {})
            }
            try expect(try children(directory) == ["Pi Desk.app"], "恢复旧版并清理暂存")
        }
        try test("恢复也失败时保留旧版备份") { directory in
            _ = try install(payload, directory)
            var engine = InstallerEngine()
            engine.move = { source, destination in
                if source.deletingLastPathComponent().lastPathComponent.hasPrefix(".pi-desk-install-") {
                    throw InstallerFailure.message("模拟目录写入失败")
                }
                try files.moveItem(at: source, to: destination)
            }
            try expectFailure {
                _ = try engine.install(
                    payload: payload, into: directory, cancellation: .init(), progress: { _ in },
                    beforeCommit: {})
            }
            let backup = try children(directory).first { $0.hasPrefix(".pi-desk-install-") }
            try expect(backup != nil, "不删除恢复失败的备份")
            try expect(
                files.fileExists(
                    atPath: directory.appendingPathComponent(backup!).appendingPathComponent(
                        "previous.app/Contents/Info.plist"
                    ).path), "旧版完整保留")
        }
        try test("拒绝覆盖其他同名文件或符号链接") { directory in
            let app = directory.appendingPathComponent("Pi Desk.app")
            try Data("not an app".utf8).write(to: app)
            try expectFailure { _ = try install(payload, directory) }
            try files.removeItem(at: app)
            try files.createSymbolicLink(at: app, withDestinationURL: root)
            try expectFailure { _ = try install(payload, directory) }
        }
        try test("拒绝身份或版本不符的内置应用") { directory in
            let wrong = InstallerPayload(
                archive: payload.archive, sha256: payload.sha256, bundleIdentifier: identifier,
                version: "9.9.9", quarantineSource: payload.quarantineSource)
            try expectFailure { _ = try install(wrong, directory) }
            try expect(try children(directory).isEmpty, "不留下错误版本")
        }
        try test("保留下载隔离标记") { directory in
            let value = "0081;66000000;PiDeskInstallerTest;00000000-0000-4000-8000-000000000000"
            _ = try InstallerEngine.run(
                "/usr/bin/xattr", ["-w", "com.apple.quarantine", value, payload.quarantineSource.path])
            let app = try install(payload, directory)
            let actual = try InstallerEngine.run("/usr/bin/xattr", ["-p", "com.apple.quarantine", app.path])
            try expect(actual == value, "不移除或修改隔离标记")
        }
        // 原生界面使用同一窗口实现与隔离的测试应用身份，不启动或停止真实 Pi Desk。
        let application = NSApplication.shared
        application.setActivationPolicy(.regular)
        let icon = NSImage(contentsOfFile: CommandLine.arguments[2])
        let screenshots = root.appendingPathComponent("screenshots")
        try files.createDirectory(at: screenshots, withIntermediateDirectories: true)
        let destination = root.appendingPathComponent("ui/这是一个用于验证安装位置省略与完整提示的长目录名称/Applications")
        let controller = InstallerWindow(payload: payload, destination: destination, icon: icon)
        controller.showWindow(nil)
        for (name, appearance) in [("ready-light", NSAppearance.Name.aqua), ("ready-dark", .darkAqua)] {
            controller.window?.appearance = NSAppearance(named: appearance)
            try capture(controller, at: screenshots.appendingPathComponent("\(name).png"))
        }
        controller.window?.appearance = NSAppearance(named: .aqua)
        controller.primary.performClick(nil)
        let deadline = Date().addingTimeInterval(30)
        while controller.primary.title != "打开 Pi Desk" && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        try expect(controller.primary.title == "打开 Pi Desk", "真实安装按钮完成安装")
        for (name, appearance) in [("complete-light", NSAppearance.Name.aqua), ("complete-dark", .darkAqua)] {
            controller.window?.appearance = NSAppearance(named: appearance)
            try capture(controller, at: screenshots.appendingPathComponent("\(name).png"))
        }
        controller.secondary.performClick(nil)
        try expect(controller.window?.isVisible == false, "完成后关闭按钮生效")
        let broken = InstallerPayload(
            archive: payload.archive, sha256: "wrong", bundleIdentifier: identifier,
            version: payload.version, quarantineSource: payload.quarantineSource)
        let failure = InstallerWindow(
            payload: broken, destination: root.appendingPathComponent("ui-failure"), icon: icon)
        failure.showWindow(nil)
        failure.primary.performClick(nil)
        while failure.primary.title != "重试安装" && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        try expect(failure.primary.title == "重试安装", "失败后保留重试入口")
        try expect(
            labels(in: failure.window!.contentView!).contains { $0.stringValue.contains("校验失败") }, "显示真实失败原因")
        failure.window?.appearance = NSAppearance(named: .aqua)
        try capture(failure, at: screenshots.appendingPathComponent("failed-light.png"))
        failure.window?.close()
        print("PASS 原生浅色/暗色、长路径、真实安装按钮、关闭和失败恢复界面")
        print("\(count + 1) 项 macOS 安装器验证通过；截图：\(screenshots.path)")
    }
}
