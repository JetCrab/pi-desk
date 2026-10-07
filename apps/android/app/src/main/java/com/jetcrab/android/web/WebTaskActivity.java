package com.jetcrab.android.web;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

public final class WebTaskActivity extends Activity {
    private static final int IMAGE_PICK_REQUEST = 1001;

    private WebSessionStore sessionStore;
    private String activeUrl;
    private WebTaskBackDispatcher backDispatcher;
    private FrameLayout container;
    private Object platformBackCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        sessionStore = WebSessionStoreProvider.get(getApplicationContext());
        String requestedUrl = WebTaskIntent.url(getIntent());
        if (!isValidUrl(requestedUrl)) {
            finishAndRemoveTask();
            return;
        }

        activeUrl = requestedUrl;
        backDispatcher = createBackDispatcher();
        if (Build.VERSION.SDK_INT >= 33) {
            platformBackCallback = Api33Back.register(this, this::handleSystemBack);
        }
        container = new FrameLayout(this);
        container.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(container);
        attachWebView();
        sessionStore.setImagePickerLauncher(activeUrl, this::openImagePicker);
        updateRecentTaskTitle();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String requestedUrl = WebTaskIntent.url(intent);
        if (!isValidUrl(requestedUrl)) {
            finishAndRemoveTask();
            return;
        }
        backDispatcher.invalidate();
        if (!requestedUrl.equals(activeUrl)) {
            sessionStore.setImagePickerLauncher(activeUrl, null);
            activeUrl = requestedUrl;
            attachWebView();
            sessionStore.setImagePickerLauncher(activeUrl, this::openImagePicker);
        }
        setIntent(intent);
        updateRecentTaskTitle();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (backDispatcher != null) {
            backDispatcher.onTaskResumed();
        }
        if (activeUrl != null && !sessionStore.hasUrl(activeUrl)) {
            finishAndRemoveTask();
            return;
        }
        updateRecentTaskTitle();
    }

    @Override
    public void onBackPressed() {
        handleSystemBack();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != IMAGE_PICK_REQUEST || activeUrl == null) {
            return;
        }
        Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
        sessionStore.completeImageSelection(activeUrl, uri);
    }

    @Override
    protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= 33 && platformBackCallback != null) {
            Api33Back.unregister(this, platformBackCallback);
            platformBackCallback = null;
        }
        if (backDispatcher != null) {
            backDispatcher.invalidate();
        }
        if (sessionStore != null && activeUrl != null) {
            sessionStore.setImagePickerLauncher(activeUrl, null);
            if (!isChangingConfigurations()) {
                sessionStore.release(activeUrl);
            }
        }
        super.onDestroy();
    }

    private void handleSystemBack() {
        if (backDispatcher == null) {
            moveTaskToBack(true);
            return;
        }
        backDispatcher.onBackPressed();
    }

    private void attachWebView() {
        WebView webView = sessionStore.webViewFor(activeUrl);
        if (webView.getParent() instanceof ViewGroup) {
            ((ViewGroup) webView.getParent()).removeView(webView);
        }
        container.removeAllViews();
        container.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private WebTaskBackDispatcher createBackDispatcher() {
        return new WebTaskBackDispatcher(new WebTaskBackDispatcher.Actions() {
            @Override
            public boolean isJavaScriptReady() {
                WebSessionStore.WebSession session = sessionStore.session(activeUrl);
                return session != null && session.isJavaScriptReady();
            }

            @Override
            public void dispatchEscape(WebTaskBackDispatcher.ResultCallback callback) {
                WebSessionStore.WebSession session = sessionStore.session(activeUrl);
                WebView webView = session == null ? null : session.webView();
                if (webView == null) {
                    callback.onResult(null);
                    return;
                }
                try {
                    webView.evaluateJavascript(
                            WebTaskBackDispatcher.ESCAPE_DISPATCH_SCRIPT,
                            callback::onResult);
                } catch (RuntimeException ignored) {
                    callback.onResult(null);
                }
            }

            @Override
            public boolean moveTaskToBack() {
                return WebTaskActivity.this.moveTaskToBack(true);
            }
        });
    }

    private boolean isValidUrl(String url) {
        return url != null && sessionStore.hasUrl(url);
    }

    private void openImagePicker() {
        Intent picker;
        if (Build.VERSION.SDK_INT >= 33) {
            picker = new Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*");
        } else {
            picker = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("image/*");
        }
        try {
            startActivityForResult(picker, IMAGE_PICK_REQUEST);
        } catch (ActivityNotFoundException error) {
            sessionStore.completeImageSelection(activeUrl, null);
        }
    }

    private void updateRecentTaskTitle() {
        if (activeUrl == null) {
            return;
        }
        Uri uri = Uri.parse(activeUrl);
        String host = uri.getHost();
        String path = uri.getPath();
        String title = host == null || host.trim().isEmpty() ? activeUrl : host;
        if (path != null && !path.equals("/") && !path.trim().isEmpty()) {
            title += " · " + path;
        }
        setTitle(title);
        setTaskDescription(new ActivityManager.TaskDescription(title));
    }

    @android.annotation.SuppressLint({"NewApi", "InlinedApi"})
    private static final class Api33Back {
        private Api33Back() {}

        static Object register(Activity activity, Runnable action) {
            android.window.OnBackInvokedCallback callback = action::run;
            activity.getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    callback);
            return callback;
        }

        static void unregister(Activity activity, Object callback) {
            activity.getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(
                    (android.window.OnBackInvokedCallback) callback);
        }
    }
}
