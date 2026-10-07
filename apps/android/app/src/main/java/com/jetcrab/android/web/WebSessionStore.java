package com.jetcrab.android.web;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import java.util.HashMap;
import java.util.Map;

public final class WebSessionStore {
    private static final String LOG_TAG = "PiDeskWeb";
    private static final long POPUP_TIMEOUT_MILLIS = 10_000L;

    private final Context applicationContext;
    private final WebEndpointStore endpointStore;
    private final Map<String, WebSession> sessions = new HashMap<>();
    private final Map<String, Runnable> imagePickerLaunchers = new HashMap<>();
    private final Map<String, ValueCallback<Uri[]>> pendingImageSelections = new HashMap<>();

    public WebSessionStore(Context context) {
        applicationContext = context.getApplicationContext();
        endpointStore = new WebEndpointStore(applicationContext);
    }

    public synchronized boolean hasUrl(String rawUrl) {
        return endpointStore.contains(rawUrl);
    }

    public synchronized WebSession session(String rawUrl) {
        String url = WebEndpoint.normalize(rawUrl);
        if (!endpointStore.contains(url)) {
            return null;
        }
        WebSession session = sessions.get(url);
        if (session == null) {
            session = new WebSession(url);
            sessions.put(url, session);
        }
        return session;
    }

    public synchronized WebView webViewFor(String rawUrl) {
        WebSession session = session(rawUrl);
        if (session == null) {
            throw new IllegalStateException("网页地址已被删除");
        }
        if (session.webView == null) {
            session.webView = createWebView(session);
        }
        return session.webView;
    }

    public synchronized void refresh(String rawUrl) {
        WebSession session = session(rawUrl);
        if (session == null) {
            throw new IllegalStateException("网页地址已被删除");
        }
        if (session.webView == null) {
            session.webView = createWebView(session);
        } else {
            session.webView.reload();
        }
    }

    public synchronized void setImagePickerLauncher(String rawUrl, Runnable launcher) {
        String url = WebEndpoint.normalize(rawUrl);
        if (launcher == null) {
            imagePickerLaunchers.remove(url);
        } else {
            imagePickerLaunchers.put(url, launcher);
        }
    }

    public synchronized void completeImageSelection(String rawUrl, Uri uri) {
        String url = WebEndpoint.normalize(rawUrl);
        ValueCallback<Uri[]> callback = pendingImageSelections.remove(url);
        if (callback != null) {
            callback.onReceiveValue(uri == null ? null : new Uri[] {uri});
        }
    }

    public synchronized void release(String rawUrl) {
        String url = WebEndpoint.normalize(rawUrl);
        completeImageSelection(url, null);
        imagePickerLaunchers.remove(url);
        WebSession session = sessions.remove(url);
        if (session != null) {
            session.destroy();
        }
    }

    public synchronized void destroyAll() {
        for (String url : pendingImageSelections.keySet().toArray(new String[0])) {
            completeImageSelection(url, null);
        }
        imagePickerLaunchers.clear();
        for (WebSession session : sessions.values()) {
            session.destroy();
        }
        sessions.clear();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView createWebView(WebSession session) {
        WebView webView = new WebView(applicationContext);
        webView.setBackgroundColor(Color.TRANSPARENT);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.setWebChromeClient(createWebChromeClient(session));
        webView.setWebViewClient(createWebViewClient(session));
        webView.loadUrl(session.url);
        return webView;
    }

    private WebChromeClient createWebChromeClient(WebSession session) {
        return new WebChromeClient() {
            @Override
            public boolean onCreateWindow(
                    WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                if (!isUserGesture || !(resultMsg.obj instanceof WebView.WebViewTransport)) {
                    return false;
                }
                WebView popup = createExternalPopupWebView();
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onShowFileChooser(
                    WebView webView,
                    ValueCallback<Uri[]> filePathCallback,
                    FileChooserParams fileChooserParams) {
                synchronized (WebSessionStore.this) {
                    completeImageSelection(session.url, null);
                    pendingImageSelections.put(session.url, filePathCallback);
                    Runnable launcher = imagePickerLaunchers.get(session.url);
                    if (launcher == null) {
                        completeImageSelection(session.url, null);
                        return false;
                    }
                    launcher.run();
                    return true;
                }
            }
        };
    }

    private WebView createExternalPopupWebView() {
        WebView popup = new WebView(applicationContext);
        Handler mainHandler = new Handler(Looper.getMainLooper());
        Runnable timeoutCleanup = popup::destroy;
        popup.setWebViewClient(new WebViewClient() {
            private boolean handled;

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (handled) {
                    return true;
                }
                handled = true;
                mainHandler.removeCallbacks(timeoutCleanup);
                Uri uri = request.getUrl();
                if (isHttpUrl(uri)) {
                    openExternalHttpUrl(uri);
                }
                mainHandler.post(popup::destroy);
                return true;
            }
        });
        // WebChromeClient 不提供目标 URL；短生命周期 WebView 只接收首次导航。
        mainHandler.postDelayed(timeoutCleanup, POPUP_TIMEOUT_MILLIS);
        return popup;
    }

    private WebViewClient createWebViewClient(WebSession session) {
        return new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                session.javaScriptReady = false;
                super.onPageStarted(view, url, favicon);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!isHttpUrl(uri)) {
                    return true;
                }
                if (session.urlPolicy.shouldOpenInApp(uri.toString())) {
                    return false;
                }
                openExternalHttpUrl(uri);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                session.javaScriptReady = true;
                super.onPageFinished(view, url);
            }
        };
    }

    private boolean isHttpUrl(Uri uri) {
        String scheme = uri.getScheme();
        return scheme != null
                && (scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"));
    }

    private void openExternalHttpUrl(Uri uri) {
        Intent intent = new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            applicationContext.startActivity(intent);
            Log.i(LOG_TAG, "stage=external-open url=" + uri);
        } catch (ActivityNotFoundException error) {
            Log.w(LOG_TAG, "stage=external-open-failed url=" + uri, error);
            Toast.makeText(applicationContext, "无法打开外部链接", Toast.LENGTH_SHORT).show();
        }
    }

    public static final class WebSession {
        public final String url;
        final WebUrlPolicy urlPolicy;
        WebView webView;
        volatile boolean javaScriptReady;

        WebSession(String url) {
            this.url = url;
            urlPolicy = new WebUrlPolicy(url);
        }

        public WebView webView() {
            return webView;
        }

        public boolean isJavaScriptReady() {
            return javaScriptReady;
        }

        void destroy() {
            if (webView == null) {
                return;
            }
            if (webView.getParent() instanceof ViewGroup) {
                ((ViewGroup) webView.getParent()).removeView(webView);
            }
            webView.destroy();
            webView = null;
            javaScriptReady = false;
        }
    }
}
