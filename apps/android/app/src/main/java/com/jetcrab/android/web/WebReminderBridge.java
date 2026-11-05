package com.jetcrab.android.web;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;
import com.jetcrab.android.R;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.stream.Collectors;
import org.json.JSONException;
import org.json.JSONObject;

final class WebReminderBridge {
    interface PermissionHost {
        boolean requestNotificationPermission(Runnable result);

        void cancelNotificationPermissionRequest();
    }

    private static final String LOG_TAG = "PiDeskReminder";
    private static final String CHANNEL_ID = "completion-silent";
    private static final String PREFERENCES = "reminders";
    private static final String PERMISSION_REQUESTED = "notification-permission-requested";

    private final Context context;
    private final String url;
    private final String origin;
    private final WebUrlPolicy urlPolicy;
    private final NotificationManager notifications;
    private PermissionHost permissionHost;
    private WebView webView;
    private WebMessagePort port;
    private WebMessagePort transferPort;
    private String token;
    private String permissionRequestId;

    WebReminderBridge(Context context, String url) {
        this.context = context;
        this.url = url;
        URI endpoint = URI.create(url);
        origin = endpoint.getScheme() + "://" + endpoint.getRawAuthority();
        urlPolicy = new WebUrlPolicy(url);
        notifications = context.getSystemService(NotificationManager.class);
    }

    void setPermissionHost(PermissionHost host) {
        disconnect();
        permissionHost = host;
        connect();
    }

    void onPageStarted() {
        disconnect();
        webView = null;
    }

    void onPageFinished(WebView view, String finishedUrl) {
        if (!urlPolicy.shouldOpenInApp(finishedUrl)
                || !urlPolicy.shouldOpenInApp(view.getUrl())) {
            return;
        }
        webView = view;
        connect();
    }

    void destroy() {
        disconnect();
        permissionHost = null;
        webView = null;
        notifications.cancel(url, 0);
    }

    private void connect() {
        if (permissionHost == null || webView == null || port != null
                || !urlPolicy.shouldOpenInApp(webView.getUrl())) {
            return;
        }
        final String script;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                context.getAssets().open("reminder.js"), StandardCharsets.UTF_8))) {
            script = reader.lines().collect(Collectors.joining("\n"));
        } catch (IOException error) {
            Log.e(LOG_TAG, "无法读取安卓提醒桥脚本", error);
            return;
        }

        String connectionToken = UUID.randomUUID().toString();
        WebView view = webView;
        WebMessagePort[] channel = view.createWebMessageChannel();
        WebMessagePort nativePort = channel[0];
        port = nativePort;
        transferPort = channel[1];
        token = connectionToken;
        nativePort.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override
            public void onMessage(WebMessagePort source, WebMessage message) {
                if (port == source && urlPolicy.shouldOpenInApp(view.getUrl())) {
                    handleMessage(source, message.getData());
                }
            }
        });
        String injected = script
                .replace("__PI_DESK_ORIGIN__", JSONObject.quote(origin))
                .replace("__PI_DESK_TOKEN__", JSONObject.quote(connectionToken));
        try {
            view.evaluateJavascript(injected, result -> {
                if (port != nativePort) {
                    return;
                }
                if (!"true".equals(result) || !urlPolicy.shouldOpenInApp(view.getUrl())) {
                    disconnect();
                    return;
                }
                try {
                    // postWebMessage 只向主 frame 传 port，且必须匹配配置地址的精确 origin。
                    view.postWebMessage(
                            new WebMessage(connectionToken, new WebMessagePort[] {transferPort}),
                            Uri.parse(origin));
                    transferPort = null;
                } catch (RuntimeException error) {
                    disconnect();
                    Log.e(LOG_TAG, "初始化安卓提醒安全通道失败", error);
                }
            });
        } catch (RuntimeException error) {
            disconnect();
            Log.e(LOG_TAG, "注入安卓提醒桥失败", error);
        }
    }

    private void disconnect() {
        if (permissionHost != null) {
            permissionHost.cancelNotificationPermissionRequest();
        }
        permissionRequestId = null;
        if (webView != null && token != null) {
            webView.evaluateJavascript(
                    "window.dispatchEvent(new Event("
                            + JSONObject.quote("pi-desk-reminder-dispose-" + token) + "))",
                    null);
        }
        if (transferPort != null) {
            transferPort.close();
            transferPort = null;
        }
        if (port != null) {
            port.close();
            port = null;
        }
        token = null;
    }

    private void handleMessage(WebMessagePort source, String data) {
        String id = null;
        try {
            if (data == null || data.length() > 16384) {
                throw new JSONException("提醒请求过长或为空");
            }
            JSONObject message = new JSONObject(data);
            Object rawId = message.get("id");
            if (!(rawId instanceof String)) {
                throw new JSONException("提醒请求缺少标识");
            }
            id = (String) rawId;
            JSONObject request = message.getJSONObject("request");
            String action = request.getString("action");
            switch (action) {
                case "permission":
                    Object shouldRequest = request.get("request");
                    if (!(shouldRequest instanceof Boolean)) {
                        throw new JSONException("权限请求必须指定布尔值 request");
                    }
                    if ((Boolean) shouldRequest && Build.VERSION.SDK_INT >= 33
                            && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                                    != PackageManager.PERMISSION_GRANTED) {
                        requestPermission(source, id);
                    } else {
                        respond(source, id, permissionState(), null);
                    }
                    break;
                case "notify":
                    Object title = request.get("title");
                    Object body = request.get("body");
                    if (!(title instanceof String) || !(body instanceof String)) {
                        throw new JSONException("通知标题和正文必须为字符串");
                    }
                    showNotification((String) title, (String) body);
                    respond(source, id, null, null);
                    break;
                case "clear":
                    notifications.cancel(url, 0);
                    respond(source, id, null, null);
                    break;
                default:
                    throw new JSONException("不支持的安卓提醒操作");
            }
        } catch (JSONException | RuntimeException error) {
            Log.w(LOG_TAG, "处理安卓提醒请求失败", error);
            if (id != null) {
                respond(source, id, null, error.getMessage());
            }
        }
    }

    private void requestPermission(WebMessagePort source, String id) {
        if (permissionRequestId != null) {
            respond(source, id, null, "通知权限申请正在处理中");
            return;
        }
        permissionRequestId = id;
        boolean started = permissionHost.requestNotificationPermission(() -> {
            if (port == source && id.equals(permissionRequestId)) {
                permissionRequestId = null;
                respond(source, id, permissionState(), null);
            }
        });
        if (started) {
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
                    .putBoolean(PERMISSION_REQUESTED, true).apply();
        } else {
            permissionRequestId = null;
            respond(source, id, permissionState(), null);
        }
    }

    private String permissionState() {
        if (Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                    .getBoolean(PERMISSION_REQUESTED, false) ? "denied" : "default";
        }
        NotificationChannel channel = notifications.getNotificationChannel(CHANNEL_ID);
        return notifications.areNotificationsEnabled()
                && (channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE)
                ? "granted" : "denied";
    }

    private void showNotification(String title, String body) {
        if (!"granted".equals(permissionState())) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, context.getString(R.string.completion_notification_channel),
                NotificationManager.IMPORTANCE_HIGH);
        channel.setSound(null, null);
        channel.enableVibration(false);
        notifications.createNotificationChannel(channel);
        PendingIntent openTask = PendingIntent.getActivity(
                context, 0, WebTaskIntent.create(context, url),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(openTask)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_STATUS)
                .build();
        notifications.notify(url, 0, notification);
    }

    private void respond(WebMessagePort target, String id, String result, String error) {
        if (port != target) {
            return;
        }
        try {
            JSONObject response = new JSONObject().put("id", id);
            if (error == null) {
                response.put("result", result == null ? JSONObject.NULL : result);
            } else {
                response.put("error", error);
            }
            target.postMessage(new WebMessage(response.toString()));
        } catch (JSONException | RuntimeException failure) {
            Log.w(LOG_TAG, "返回安卓提醒结果失败", failure);
        }
    }
}
