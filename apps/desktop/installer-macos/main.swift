import AppKit

final class InstallerDelegate: NSObject, NSApplicationDelegate {
    private var controller: InstallerWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let payload = try InstallerPayload.bundled(in: .main)
            controller = InstallerWindow(
                payload: payload,
                icon: NSImage(named: NSImage.Name("AppIcon")) ?? NSApp.applicationIconImage)
            controller?.showWindow(nil)
            NSApp.activate(ignoringOtherApps: true)
        } catch {
            let alert = NSAlert()
            alert.messageText = "无法打开 Pi Desk 安装器"
            alert.informativeText = error.localizedDescription
            alert.runModal()
            NSApp.stop(nil)
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        controller?.requestClose()
        return .terminateCancel
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        controller?.showWindow(nil)
        return true
    }
}

let application = NSApplication.shared
let delegate = InstallerDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
let menu = NSMenu()
let applicationMenu = NSMenu()
applicationMenu.addItem(
    withTitle: "退出 Pi Desk 安装器", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
let item = NSMenuItem()
item.submenu = applicationMenu
menu.addItem(item)
application.mainMenu = menu
application.run()
