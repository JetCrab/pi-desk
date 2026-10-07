package com.jetcrab.android.web;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;

public final class WebEndpointStore {
    private static final String PREFERENCES_NAME = "jetcrab_web";
    private static final String URLS_KEY = "web_urls";

    private final SharedPreferences preferences;

    public WebEndpointStore(Context context) {
        preferences = context.getApplicationContext()
                .getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
    }

    public synchronized List<String> loadUrls() {
        String saved = preferences.getString(URLS_KEY, null);
        if (saved == null) {
            return Collections.emptyList();
        }
        JSONArray values;
        try {
            values = new JSONArray(saved);
        } catch (Exception ignored) {
            persist(Collections.emptyList());
            return Collections.emptyList();
        }

        List<String> urls = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (int index = 0; index < values.length(); index++) {
            String normalized = WebEndpoint.normalizeOrNull(values.optString(index));
            if (normalized != null && seen.add(normalized)) {
                urls.add(normalized);
            }
        }
        persist(urls);
        return Collections.unmodifiableList(new ArrayList<>(urls));
    }

    public synchronized String add(String rawUrl) {
        String url = WebEndpoint.normalizeInput(rawUrl);
        List<String> urls = mutableUrls();
        if (urls.contains(url)) {
            throw new IllegalArgumentException("该网页地址已经存在");
        }
        urls.add(url);
        persist(urls);
        return url;
    }

    public synchronized String replace(String oldRawUrl, String newRawUrl) {
        String oldUrl = WebEndpoint.normalize(oldRawUrl);
        String newUrl = WebEndpoint.normalizeInput(newRawUrl);
        List<String> urls = mutableUrls();
        int index = urls.indexOf(oldUrl);
        if (index < 0) {
            throw new IllegalArgumentException("原网页地址不存在");
        }
        if (!oldUrl.equals(newUrl) && urls.contains(newUrl)) {
            throw new IllegalArgumentException("该网页地址已经存在");
        }
        urls.set(index, newUrl);
        persist(urls);
        return newUrl;
    }

    public synchronized boolean delete(String rawUrl) {
        String url = WebEndpoint.normalize(rawUrl);
        List<String> urls = mutableUrls();
        if (!urls.remove(url)) {
            return false;
        }
        persist(urls);
        return true;
    }

    public synchronized boolean contains(String rawUrl) {
        String url = WebEndpoint.normalizeOrNull(rawUrl);
        return url != null && loadUrls().contains(url);
    }

    private List<String> mutableUrls() {
        return new ArrayList<>(loadUrls());
    }

    private void persist(List<String> urls) {
        JSONArray values = new JSONArray();
        for (String url : urls) {
            values.put(url);
        }
        preferences.edit().putString(URLS_KEY, values.toString()).apply();
    }
}
