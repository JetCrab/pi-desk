package com.jetcrab.android.web;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class WebUrlPolicyTest {
    @Test
    public void keepsOnlyTheConfiguredOriginInsideWebView() {
        WebUrlPolicy policy = new WebUrlPolicy("https://example.com:443/workspace");

        assertTrue(policy.shouldOpenInApp("https://example.com/other"));
        assertFalse(policy.shouldOpenInApp("http://example.com/other"));
        assertFalse(policy.shouldOpenInApp("https://example.com:444/other"));
        assertFalse(policy.shouldOpenInApp("https://other.example.com/other"));
        assertFalse(policy.shouldOpenInApp("mailto:user@example.com"));
    }
}
