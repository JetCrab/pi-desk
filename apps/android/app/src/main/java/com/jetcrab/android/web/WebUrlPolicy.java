package com.jetcrab.android.web;

import java.net.URI;
import java.util.Locale;
import java.util.Objects;

public final class WebUrlPolicy {
    private final Origin allowedOrigin;

    public WebUrlPolicy(String startUrl) {
        allowedOrigin = originOf(startUrl);
    }

    public boolean shouldOpenInApp(String url) {
        return allowedOrigin != null && allowedOrigin.equals(originOf(url));
    }

    private static Origin originOf(String value) {
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null) {
                return null;
            }
            scheme = scheme.toLowerCase(Locale.ROOT);
            host = host.toLowerCase(Locale.ROOT);
            if (!scheme.equals("http") && !scheme.equals("https")) {
                return null;
            }
            int port = uri.getPort();
            if (port < 0) {
                port = scheme.equals("http") ? 80 : 443;
            }
            return new Origin(scheme, host, port);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static final class Origin {
        private final String scheme;
        private final String host;
        private final int port;

        private Origin(String scheme, String host, int port) {
            this.scheme = scheme;
            this.host = host;
            this.port = port;
        }

        @Override
        public boolean equals(Object value) {
            if (this == value) {
                return true;
            }
            if (!(value instanceof Origin)) {
                return false;
            }
            Origin other = (Origin) value;
            return port == other.port && scheme.equals(other.scheme) && host.equals(other.host);
        }

        @Override
        public int hashCode() {
            return Objects.hash(scheme, host, port);
        }
    }
}
