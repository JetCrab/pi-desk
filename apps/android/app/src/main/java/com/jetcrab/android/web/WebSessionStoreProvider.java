package com.jetcrab.android.web;

import android.content.Context;

public final class WebSessionStoreProvider {
    private static volatile WebSessionStore instance;

    private WebSessionStoreProvider() {}

    public static WebSessionStore get(Context context) {
        WebSessionStore current = instance;
        if (current != null) {
            return current;
        }
        synchronized (WebSessionStoreProvider.class) {
            if (instance == null) {
                instance = new WebSessionStore(context.getApplicationContext());
            }
            return instance;
        }
    }
}
