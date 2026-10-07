package com.jetcrab.android.web;

import java.util.regex.Pattern;

public final class WebTaskBackDispatcher {
    private static final Pattern KEYDOWN_PREVENTED = Pattern.compile("\\\"keydown\\\"\\s*:\\s*true");
    private static final Pattern KEYUP_PREVENTED = Pattern.compile("\\\"keyup\\\"\\s*:\\s*true");

    public static final String ESCAPE_DISPATCH_SCRIPT = """
            (function() {
                if (typeof document === 'undefined' || document.readyState === 'loading') {
                    return null;
                }
                var target = document.activeElement || document.body || document.documentElement;
                if (!target) {
                    return null;
                }
                var init = { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true };
                function legacy(event) {
                    try { Object.defineProperty(event, 'keyCode', { value: 27, configurable: true }); } catch (_) {}
                    try { Object.defineProperty(event, 'which', { value: 27, configurable: true }); } catch (_) {}
                }
                var keydown = new KeyboardEvent('keydown', init);
                legacy(keydown);
                target.dispatchEvent(keydown);
                var keyup = new KeyboardEvent('keyup', init);
                legacy(keyup);
                target.dispatchEvent(keyup);
                return { keydown: keydown.defaultPrevented, keyup: keyup.defaultPrevented };
            })()
            """;

    public interface Actions {
        boolean isJavaScriptReady();
        void dispatchEscape(ResultCallback callback);
        boolean moveTaskToBack();
    }

    public interface ResultCallback {
        void onResult(String value);
    }

    private final Actions actions;
    private long requestGeneration;
    private Long activeGeneration;
    private boolean requestInFlight;

    public WebTaskBackDispatcher(Actions actions) {
        this.actions = actions;
    }

    public void onBackPressed() {
        if (requestInFlight) {
            return;
        }
        long generation = ++requestGeneration;
        activeGeneration = generation;
        requestInFlight = true;
        if (!actions.isJavaScriptReady()) {
            requestMoveToBack(generation);
            return;
        }
        final boolean[] callbackHandled = {false};
        try {
            actions.dispatchEscape(value -> {
                if (callbackHandled[0]
                        || activeGeneration == null
                        || activeGeneration != generation
                        || requestGeneration != generation) {
                    return;
                }
                callbackHandled[0] = true;
                requestInFlight = false;
                if (!wasConsumed(value)) {
                    requestMoveToBack(generation);
                } else {
                    activeGeneration = null;
                }
            });
        } catch (RuntimeException ignored) {
            requestMoveToBack(generation);
        }
    }

    public void onTaskResumed() {
        requestGeneration++;
        activeGeneration = null;
        requestInFlight = false;
    }

    public void invalidate() {
        requestGeneration++;
        activeGeneration = null;
        requestInFlight = false;
    }

    static boolean wasConsumed(String rawValue) {
        if (rawValue == null) {
            return false;
        }
        String value = rawValue.trim();
        if (value.isEmpty() || value.equals("null") || value.equals("undefined")) {
            return false;
        }
        if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
            value = value.substring(1, value.length() - 1).replace("\\\"", "\"");
        }
        return KEYDOWN_PREVENTED.matcher(value).find()
                || KEYUP_PREVENTED.matcher(value).find();
    }

    private void requestMoveToBack(long generation) {
        if (activeGeneration == null
                || activeGeneration != generation
                || requestGeneration != generation) {
            return;
        }
        activeGeneration = null;
        boolean moved;
        try {
            moved = actions.moveTaskToBack();
        } catch (RuntimeException ignored) {
            moved = false;
        }
        requestInFlight = moved;
    }
}
