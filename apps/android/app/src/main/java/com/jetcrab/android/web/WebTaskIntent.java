package com.jetcrab.android.web;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;

public final class WebTaskIntent {
    private static final String SCHEME = "pi-desk";
    private static final String HOST = "web";

    private WebTaskIntent() {}

    public static Intent create(Context context, String rawUrl) {
        String url = WebEndpoint.normalize(rawUrl);
        Uri data = new Uri.Builder()
                .scheme(SCHEME)
                .authority(HOST)
                .appendPath("url")
                .appendPath(url)
                .build();
        return new Intent(context, WebTaskActivity.class)
                .setAction(Intent.ACTION_VIEW)
                .setData(data)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT);
    }

    public static String url(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null
                || !(SCHEME.equals(data.getScheme()) || "jetcrab".equals(data.getScheme()))
                || !HOST.equals(data.getHost())
                || data.getPathSegments().size() != 2
                || !"url".equals(data.getPathSegments().get(0))) {
            return null;
        }
        return WebEndpoint.normalizeOrNull(data.getPathSegments().get(1));
    }

    public static boolean matches(Intent intent, String rawUrl) {
        String expected = WebEndpoint.normalizeOrNull(rawUrl);
        return expected != null && expected.equals(url(intent));
    }
}
