package com.jetcrab.android.web;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

public final class WebEndpoint {
    private WebEndpoint() {}

    public static String normalize(String rawValue) {
        String value = rawValue == null ? "" : rawValue.trim();
        if (value.isEmpty()) {
            throw new IllegalArgumentException("网页地址不能为空");
        }
        if (value.length() > 2048) {
            throw new IllegalArgumentException("网页地址过长");
        }

        final URI parsed;
        try {
            parsed = new URI(value).normalize();
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("请输入完整的 http:// 或 https:// 地址", error);
        }
        String scheme = parsed.getScheme();
        String host = parsed.getHost();
        if (scheme == null || host == null || parsed.isOpaque()) {
            throw new IllegalArgumentException("请输入包含主机名的完整网页地址");
        }
        scheme = scheme.toLowerCase(Locale.ROOT);
        host = host.toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) {
            throw new IllegalArgumentException("网页地址必须使用 http:// 或 https://");
        }
        if (parsed.getRawUserInfo() != null) {
            throw new IllegalArgumentException("网页地址不能包含账号或密码");
        }

        int port = parsed.getPort();
        if ((scheme.equals("http") && port == 80) || (scheme.equals("https") && port == 443)) {
            port = -1;
        }
        String authorityHost = host.indexOf(':') >= 0 ? "[" + host + "]" : host;
        String path = parsed.getRawPath();
        if (path == null || path.isEmpty()) {
            path = "/";
        }
        StringBuilder normalized = new StringBuilder()
                .append(scheme)
                .append("://")
                .append(authorityHost);
        if (port >= 0) {
            normalized.append(':').append(port);
        }
        normalized.append(path);
        if (parsed.getRawQuery() != null) {
            normalized.append('?').append(parsed.getRawQuery());
        }
        if (parsed.getRawFragment() != null) {
            normalized.append('#').append(parsed.getRawFragment());
        }
        try {
            return new URI(normalized.toString()).toASCIIString();
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("网页地址无法规范化", error);
        }
    }

    static String normalizeInput(String rawValue) {
        String value = rawValue == null ? "" : rawValue.trim();
        return normalize(!value.isEmpty() && !value.contains("://")
                ? "https://" + value : value);
    }

    public static String normalizeOrNull(String rawValue) {
        try {
            return normalize(rawValue);
        } catch (IllegalArgumentException ignored) {
            return null;
        }
    }
}
