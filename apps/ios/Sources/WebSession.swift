import Combine
import OSLog
import UIKit
import WebKit

@MainActor
final class WebSession: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    let address: String
    let webView: WKWebView
    weak var presenter: UIViewController?
    @Published private(set) var progress = 0.0
    @Published private(set) var isLoading = false
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var failure: String?
    @Published var notice: String?
    @Published var sharedFile: SharedFile?

    private let startURL: URL
    private var failedURL: URL?
    private var observations: [NSKeyValueObservation] = []
    private var cancelDialog: (() -> Void)?
    private weak var dialog: UIAlertController?
    private let logger = Logger(subsystem: "com.jetcrab.ios", category: "web")
    private lazy var downloads = WebDownloads { [weak self] file in
        self?.sharedFile = file
    } onFailure: { [weak self] message in
        self?.notice = message
    }

    init(address: String) {
        self.address = address
        startURL = URL(string: address)!
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        // 保留系统的返回列表手势，网页历史由下方导航按钮控制。
        webView.allowsBackForwardNavigationGestures = false
        observations = [
            webView.observe(\.estimatedProgress, options: [.new]) { [weak self] _, _ in
                Task { @MainActor [weak self] in self?.updateState() }
            },
            webView.observe(\.isLoading, options: [.new]) { [weak self] _, _ in
                Task { @MainActor [weak self] in self?.updateState() }
            },
            webView.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in
                Task { @MainActor [weak self] in self?.updateState() }
            },
            webView.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in
                Task { @MainActor [weak self] in self?.updateState() }
            }
        ]
        webView.load(URLRequest(url: startURL))
    }

    func retry() {
        let target = failedURL ?? webView.url ?? startURL
        failure = nil
        failedURL = nil
        webView.load(URLRequest(url: target))
    }

    func openInBrowser() {
        let url = webView.url ?? startURL
        guard WebEndpoint.isHTTP(url) else { return }
        openExternal(url)
    }

    func clearSharedFile() {
        sharedFile = nil
        downloads.clearSharedFile()
    }

    func deactivate() {
        cancelPendingDialog()
        downloads.cancelAll()
        sharedFile = nil
    }

    func dispose() {
        deactivate()
        observations.removeAll()
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.removeFromSuperview()
        presenter = nil
    }

    private func updateState() {
        progress = webView.estimatedProgress
        isLoading = webView.isLoading
        canGoBack = webView.canGoBack
        canGoForward = webView.canGoForward
    }

    private func openExternal(_ url: URL) {
        UIApplication.shared.open(url, options: [:]) { [weak self] opened in
            if !opened {
                Task { @MainActor [weak self] in self?.notice = "无法打开此链接。" }
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let scheme = url.scheme?.lowercased()
        if scheme == "mailto" || scheme == "tel" {
            decisionHandler(.cancel)
            if navigationAction.navigationType == .linkActivated {
                openExternal(url)
            }
            return
        }
        if scheme == "blob", navigationAction.shouldPerformDownload,
           let source = URL(string: String(url.absoluteString.dropFirst(5))),
           WebEndpoint.hasSameOrigin(source, as: startURL) {
            decisionHandler(.download)
            return
        }
        guard WebEndpoint.isHTTP(url) else {
            // 内部空白框架可用；禁止 file、javascript 及任意自定义协议导航。
            let internalBlank = url.absoluteString == "about:blank"
                && navigationAction.targetFrame?.isMainFrame == false
            decisionHandler(internalBlank ? .allow : .cancel)
            return
        }
        if navigationAction.targetFrame?.isMainFrame != false
            && !WebEndpoint.hasSameOrigin(url, as: startURL) {
            decisionHandler(.cancel)
            openExternal(url)
            return
        }
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        downloads.receive(download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        downloads.receive(download)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        failure = nil
        cancelPendingDialog()
        updateState()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        failure = nil
        failedURL = nil
        updateState()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showFailure(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showFailure(error)
    }

    private func showFailure(_ error: Error) {
        let underlying = error as NSError
        guard !(underlying.domain == NSURLErrorDomain && underlying.code == NSURLErrorCancelled) else { return }
        failedURL = underlying.userInfo[NSURLErrorFailingURLErrorKey] as? URL
        failure = error.localizedDescription
        updateState()
        logger.error("网页加载失败：domain=\(underlying.domain, privacy: .public) code=\(underlying.code)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        failure = "网页已暂停，请重新加载。"
        logger.warning("网页进程已终止")
    }

    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(.performDefaultHandling, nil)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url, WebEndpoint.isHTTP(url) else { return nil }
        if WebEndpoint.hasSameOrigin(url, as: startURL) {
            webView.load(navigationAction.request)
        } else {
            openExternal(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: frame.securityOrigin.host, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default) { [weak self] _ in
            self?.resolveDialog()
            completionHandler()
        })
        present(alert, onCancel: completionHandler)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: frame.securityOrigin.host, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in
            self?.resolveDialog()
            completionHandler(false)
        })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { [weak self] _ in
            self?.resolveDialog()
            completionHandler(true)
        })
        present(alert) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: frame.securityOrigin.host, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in
            self?.resolveDialog()
            completionHandler(nil)
        })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { [weak self, weak alert] _ in
            self?.resolveDialog()
            completionHandler(alert?.textFields?.first?.text)
        })
        present(alert) { completionHandler(nil) }
    }

    private func present(_ alert: UIAlertController, onCancel: @escaping () -> Void) {
        guard let presenter, presenter.viewIfLoaded?.window != nil,
              presenter.presentedViewController == nil else {
            onCancel()
            return
        }
        cancelDialog = onCancel
        dialog = alert
        presenter.present(alert, animated: true)
    }

    private func resolveDialog() {
        cancelDialog = nil
        dialog = nil
    }

    private func cancelPendingDialog() {
        let completion = cancelDialog
        cancelDialog = nil
        dialog?.dismiss(animated: false)
        dialog = nil
        completion?()
    }
}
