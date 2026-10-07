import SwiftUI
import WebKit

@MainActor
struct BrowserView: View {
    let connection: Connection
    let onEdit: () -> Void
    let onDelete: () -> Void
    @StateObject private var session: WebSession

    init(connection: Connection, sessions: WebSessionStore,
         onEdit: @escaping () -> Void, onDelete: @escaping () -> Void) {
        self.connection = connection
        self.onEdit = onEdit
        self.onDelete = onDelete
        _session = StateObject(wrappedValue: sessions.session(for: connection))
    }

    var body: some View {
        VStack(spacing: 0) {
            if session.isLoading {
                ProgressView(value: session.progress)
                    .progressViewStyle(.linear)
                    .accessibilityLabel("网页加载进度")
            }
            WebContentView(session: session)
                .overlay {
                    if let failure = session.failure {
                        ContentUnavailableView {
                            Label("无法打开网页", systemImage: "wifi.exclamationmark")
                        } description: {
                            Text(failure)
                        } actions: {
                            Button("重试") { session.retry() }
                                .buttonStyle(.borderedProminent)
                        }
                        .background(Color(uiColor: .systemBackground))
                    }
                }
        }
        .navigationTitle(connection.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .bottomBar) {
                Button("后退", systemImage: "chevron.backward") { session.webView.goBack() }
                    .disabled(!session.canGoBack)
                Button("前进", systemImage: "chevron.forward") { session.webView.goForward() }
                    .disabled(!session.canGoForward)
                Spacer()
                if session.isLoading {
                    Button("停止加载", systemImage: "xmark") { session.webView.stopLoading() }
                } else {
                    Button("刷新", systemImage: "arrow.clockwise") { session.retry() }
                }
                Menu {
                    Button("编辑连接", systemImage: "pencil", action: onEdit)
                    Button("在浏览器中打开", systemImage: "safari") { session.openInBrowser() }
                    Divider()
                    Button("删除连接", systemImage: "trash", role: .destructive, action: onDelete)
                } label: {
                    Label("更多", systemImage: "ellipsis.circle")
                }
            }
        }
        .sheet(item: $session.sharedFile, onDismiss: session.clearSharedFile) { file in
            ShareFileView(url: file.url)
        }
        .alert("无法完成操作", isPresented: Binding(
            get: { session.notice != nil },
            set: { if !$0 { session.notice = nil } }
        )) {
            Button("好", role: .cancel) {}
        } message: {
            Text(session.notice ?? "")
        }
        .onDisappear { session.deactivate() }
    }
}

@MainActor
private struct WebContentView: UIViewControllerRepresentable {
    let session: WebSession

    func makeUIViewController(context: Context) -> WebContentController {
        WebContentController(session: session)
    }

    func updateUIViewController(_ controller: WebContentController, context: Context) {}

    static func dismantleUIViewController(_ controller: WebContentController, coordinator: ()) {
        controller.detach()
    }
}

@MainActor
private final class WebContentController: UIViewController {
    private let session: WebSession

    init(session: WebSession) {
        self.session = session
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("WebContentController is created programmatically")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let webView = session.webView
        webView.removeFromSuperview()
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        session.presenter = self
    }

    func detach() {
        if session.presenter === self {
            session.deactivate()
            session.presenter = nil
            session.webView.removeFromSuperview()
        }
    }
}

@MainActor
private struct ShareFileView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
