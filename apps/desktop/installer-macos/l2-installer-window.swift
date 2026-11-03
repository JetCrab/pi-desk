import AppKit

private final class InstallerPrimaryButton: NSButton {
    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 8, yRadius: 8)
        let ink = isEnabled ? NSColor.labelColor : NSColor.quaternaryLabelColor
        ink.withAlphaComponent(cell?.isHighlighted == true ? 0.8 : 1).setFill()
        shape.fill()
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 14, weight: .medium),
            .foregroundColor: isEnabled ? NSColor.textBackgroundColor : NSColor.disabledControlTextColor,
        ]
        let text = NSAttributedString(string: title, attributes: attributes)
        let size = text.size()
        text.draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2))
        if window?.firstResponder === self {
            NSColor.keyboardFocusIndicatorColor.setStroke()
            shape.lineWidth = 2
            shape.stroke()
        }
    }
}

final class InstallerWindow: NSWindowController, NSWindowDelegate {
    private let payload: InstallerPayload
    private var destination: URL
    private var installed: URL?
    private var cancellation = InstallerCancellation()
    private var working = false
    private var committing = false
    private var closeAfterCancellation = false
    private var failure: String?
    private let heading = NSTextField(labelWithString: "安装 Pi Desk")
    private let subtitle = NSTextField(labelWithString: "")
    private let location = NSTextField(labelWithString: "")
    private let status = NSTextField(wrappingLabelWithString: "")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let progress = NSProgressIndicator()
    private let change = NSButton(title: "更改…", target: nil, action: nil)
    private let errorDetails = NSButton(title: "查看错误详情", target: nil, action: nil)
    let primary: NSButton = InstallerPrimaryButton(title: "安装", target: nil, action: nil)
    let secondary = NSButton(title: "取消", target: nil, action: nil)

    init(payload: InstallerPayload, destination: URL? = nil, icon: NSImage?) {
        self.payload = payload
        self.destination = destination ?? Self.defaultDestination()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 540),
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        super.init(window: window)
        window.title = "Pi Desk 安装器"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = .windowBackgroundColor
        window.isReleasedWhenClosed = false
        window.delegate = self
        buildContent(icon: icon)
        window.center()
        render()
    }

    required init?(coder: NSCoder) { nil }

    private static func defaultDestination() -> URL {
        let files = FileManager.default
        let shared = URL(fileURLWithPath: "/Applications", isDirectory: true)
        let personal = files.homeDirectoryForCurrentUser.appendingPathComponent(
            "Applications", isDirectory: true)
        if files.fileExists(atPath: personal.appendingPathComponent("Pi Desk.app").path) { return personal }
        return files.isWritableFile(atPath: shared.path) ? shared : personal
    }

    private func buildContent(icon: NSImage?) {
        guard let content = window?.contentView else { return }
        let image = NSImageView()
        image.image = icon
        image.imageScaling = .scaleProportionallyUpOrDown
        image.setAccessibilityLabel("Pi Desk")
        heading.font = .systemFont(ofSize: 24, weight: .semibold)
        subtitle.font = .systemFont(ofSize: 13)
        subtitle.textColor = .secondaryLabelColor
        subtitle.stringValue = "版本 \(payload.version) · macOS"
        location.font = .systemFont(ofSize: 13)
        location.lineBreakMode = .byTruncatingMiddle
        location.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        status.font = .systemFont(ofSize: 14, weight: .medium)
        status.alignment = .center
        detail.font = .systemFont(ofSize: 12)
        detail.textColor = .secondaryLabelColor
        detail.alignment = .center
        detail.maximumNumberOfLines = 6
        progress.style = .bar
        progress.minValue = 0
        progress.maxValue = 1
        progress.isDisplayedWhenStopped = false
        change.target = self
        change.action = #selector(changeDirectory)
        errorDetails.target = self
        errorDetails.action = #selector(showErrorDetails)
        errorDetails.isHidden = true
        primary.target = self
        primary.action = #selector(primaryAction)
        primary.bezelStyle = .rounded
        primary.controlSize = .large
        primary.isBordered = false
        primary.keyEquivalent = "\r"
        secondary.target = self
        secondary.action = #selector(secondaryAction)
        secondary.bezelStyle = .rounded
        secondary.controlSize = .large
        secondary.keyEquivalent = "\u{1b}"
        let pathTitle = NSTextField(labelWithString: "安装位置")
        pathTitle.font = .systemFont(ofSize: 12)
        pathTitle.textColor = .secondaryLabelColor
        let pathRow = NSStackView(views: [location, change])
        pathRow.spacing = 12
        pathRow.alignment = .centerY
        let pathContents = NSStackView(views: [pathTitle, pathRow])
        pathContents.orientation = .vertical
        pathContents.alignment = .leading
        pathContents.spacing = 6
        let pathBox = NSBox()
        pathBox.boxType = .custom
        pathBox.borderColor = .separatorColor
        pathBox.fillColor = .controlBackgroundColor
        pathBox.cornerRadius = 10
        pathBox.contentViewMargins = NSSize(width: 14, height: 10)
        pathBox.contentView = NSView()
        pathBox.contentView?.addSubview(pathContents)
        pathContents.translatesAutoresizingMaskIntoConstraints = false
        if let boxContent = pathBox.contentView {
            NSLayoutConstraint.activate([
                pathContents.leadingAnchor.constraint(equalTo: boxContent.leadingAnchor),
                pathContents.trailingAnchor.constraint(equalTo: boxContent.trailingAnchor),
                pathContents.topAnchor.constraint(equalTo: boxContent.topAnchor),
                pathContents.bottomAnchor.constraint(equalTo: boxContent.bottomAnchor),
                pathRow.widthAnchor.constraint(equalTo: pathContents.widthAnchor),
            ])
        }
        let security = NSTextField(
            wrappingLabelWithString:
                "此版本未经 Apple 公证。首次打开可能需要在“系统设置 → 隐私与安全性”中选择“仍要打开”。")
        security.font = .systemFont(ofSize: 12)
        security.textColor = .secondaryLabelColor
        security.alignment = .center
        let actions = NSStackView(views: [secondary, primary])
        actions.spacing = 12
        actions.distribution = .fillEqually
        let stack = NSStackView(views: [
            image, heading, subtitle, pathBox, progress, status, detail, errorDetails, actions, security,
        ])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.setCustomSpacing(6, after: heading)
        stack.setCustomSpacing(24, after: subtitle)
        stack.setCustomSpacing(8, after: progress)
        stack.setCustomSpacing(8, after: status)
        stack.setCustomSpacing(20, after: detail)
        stack.setCustomSpacing(20, after: actions)
        content.addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        for view in [image, pathBox, progress, status, detail, actions, security] {
            view.translatesAutoresizingMaskIntoConstraints = false
        }
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 48),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 36),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -36),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24),
            image.widthAnchor.constraint(equalToConstant: 76),
            image.heightAnchor.constraint(equalToConstant: 76),
            pathBox.widthAnchor.constraint(equalTo: stack.widthAnchor),
            progress.widthAnchor.constraint(equalTo: stack.widthAnchor),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            detail.widthAnchor.constraint(equalTo: stack.widthAnchor),
            security.widthAnchor.constraint(equalTo: stack.widthAnchor),
            actions.widthAnchor.constraint(equalTo: stack.widthAnchor),
            primary.heightAnchor.constraint(greaterThanOrEqualToConstant: 36),
            secondary.heightAnchor.constraint(equalTo: primary.heightAnchor),
        ])
    }

    private func render() {
        location.stringValue = (destination.path as NSString).abbreviatingWithTildeInPath
        location.toolTip = destination.path
        change.isEnabled = !working && installed == nil
        primary.isEnabled = !working
        secondary.isEnabled = !committing
        primary.title = installed != nil ? "打开 Pi Desk" : failure != nil ? "重试安装" : "安装"
        secondary.title = installed != nil || failure != nil ? "关闭" : working ? "取消安装" : "取消"
        errorDetails.isHidden = failure == nil
        if let failure {
            heading.stringValue = installed == nil ? "安装未完成" : "应用已安装"
            status.stringValue = failure
            status.textColor = .labelColor
            status.maximumNumberOfLines = 4
            status.toolTip = failure
            detail.stringValue = installed == nil ? "原有配置、包和会话数据不会被删除。" : "也可以从安装位置手动打开应用。"
        } else if installed != nil {
            heading.stringValue = "安装完成"
            status.stringValue = "Pi Desk 已准备好"
            detail.stringValue = "打开应用后，可继续准备 Node.js、Pi 等本机运行环境。"
        } else if !working {
            heading.stringValue = "安装 Pi Desk"
            status.stringValue = "将 Pi Desk 安装到你的 Mac"
            detail.stringValue = "仅安装桌面应用，保留已有配置与会话。\n替换前会请求退出正在运行的 Pi Desk。"
        }
        if !working {
            progress.stopAnimation(nil)
            progress.isHidden = true
        }
        window?.defaultButtonCell = primary.cell as? NSButtonCell
    }

    @objc private func showErrorDetails() {
        guard let failure else { return }
        let alert = NSAlert()
        alert.messageText = installed == nil ? "安装未完成" : "无法打开应用"
        alert.informativeText = failure
        alert.addButton(withTitle: "关闭")
        alert.addButton(withTitle: "复制详情")
        if alert.runModal() == .alertSecondButtonReturn {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(failure, forType: .string)
        }
    }

    @objc private func changeDirectory() {
        guard let window else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = destination
        panel.prompt = "选择安装位置"
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.destination = url
            self?.failure = nil
            self?.render()
        }
    }

    @objc private func primaryAction() {
        if let installed {
            NSWorkspace.shared.openApplication(at: installed, configuration: .init()) {
                [weak self] _, error in
                DispatchQueue.main.async {
                    if let error {
                        self?.failure = error.localizedDescription
                        self?.render()
                    } else {
                        self?.window?.close()
                    }
                }
            }
            return
        }
        guard !working else { return }
        let existing = destination.appendingPathComponent("Pi Desk.app")
        if FileManager.default.fileExists(atPath: existing.path) || !runningApplications().isEmpty {
            let alert = NSAlert()
            alert.messageText = "安装并替换 Pi Desk？"
            alert.informativeText =
                "将安装版本 \(payload.version)，保留已有配置、包和会话数据。正在运行的 Pi Desk 会正常退出；它托管的服务和任务可能中断，未保存的运行状态不会自动恢复。"
            alert.addButton(withTitle: "继续安装")
            alert.addButton(withTitle: "取消")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        working = true
        failure = nil
        closeAfterCancellation = false
        cancellation = InstallerCancellation()
        render()
        let payload = payload
        let destination = destination
        let cancellation = cancellation
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            let result = Result {
                try InstallerEngine().install(
                    payload: payload, into: destination, cancellation: cancellation,
                    progress: { update in DispatchQueue.main.sync { self.update(update) } },
                    beforeCommit: { try self.stopRunningApplications() })
            }
            DispatchQueue.main.async {
                self.working = false
                self.committing = false
                switch result {
                case .success(let url): self.installed = url
                case .failure(let error): self.failure = error.localizedDescription
                }
                self.render()
                if self.closeAfterCancellation { self.window?.close() }
            }
        }
    }

    private func update(_ update: InstallerProgress) {
        progress.isHidden = false
        switch update {
        case .preparing:
            heading.stringValue = "正在准备"
            status.stringValue = "正在校验并展开应用…"
            progress.isIndeterminate = true
            progress.startAnimation(nil)
        case .copying(let fraction):
            heading.stringValue = "正在安装"
            progress.isIndeterminate = false
            progress.doubleValue = fraction
            status.stringValue = "正在复制应用 · \(Int(fraction * 100))%"
        case .committing:
            committing = true
            heading.stringValue = "即将完成"
            status.stringValue = "正在退出旧应用并完成安装…"
            detail.stringValue = "请稍候，此时不要退出安装器。"
            progress.isIndeterminate = true
            progress.startAnimation(nil)
            secondary.isEnabled = false
        }
    }

    private func runningApplications() -> [NSRunningApplication] {
        NSRunningApplication.runningApplications(withBundleIdentifier: payload.bundleIdentifier)
    }

    private func stopRunningApplications() throws {
        let applications = DispatchQueue.main.sync { runningApplications() }
        for application in applications {
            let accepted = DispatchQueue.main.sync { application.terminate() }
            guard accepted else { throw InstallerFailure.message("无法请求 Pi Desk 退出。请从 Pi Desk 菜单中退出应用后重试。") }
        }
        let deadline = Date().addingTimeInterval(60)
        while applications.contains(where: { !$0.isTerminated }) {
            guard Date() < deadline else {
                throw InstallerFailure.message("Pi Desk 尚未退出，原应用未被替换。请先完成或取消系统安装、关闭文件选择框，再从 Pi Desk 菜单退出后重试。")
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        guard DispatchQueue.main.sync(execute: { runningApplications().isEmpty }) else {
            throw InstallerFailure.message("检测到 Pi Desk 再次启动，原应用未被替换。请退出后重试。")
        }
    }

    @objc private func secondaryAction() { requestClose() }

    func requestClose() {
        guard working else {
            window?.close()
            return
        }
        guard !committing && cancellation.beginDecision() else {
            NSSound.beep()
            return
        }
        let alert = NSAlert()
        alert.messageText = "取消安装？"
        alert.informativeText = "原有应用和使用数据不会被替换。"
        alert.addButton(withTitle: "继续安装")
        alert.addButton(withTitle: "取消安装")
        let cancelled = alert.runModal() == .alertSecondButtonReturn
        if cancelled {
            closeAfterCancellation = true
            secondary.isEnabled = false
            status.stringValue = "正在取消安装…"
        }
        cancellation.resolveDecision(cancel: cancelled)
        if cancelled && !working { window?.close() }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if working {
            requestClose()
            return false
        }
        return true
    }

    func windowWillClose(_ notification: Notification) { NSApp.stop(nil) }
}
