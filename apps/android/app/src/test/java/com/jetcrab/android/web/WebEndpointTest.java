package com.jetcrab.android.web;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public final class WebEndpointTest {
    @Test
    public void normalizesEquivalentOriginsAndDefaultPorts() {
        assertEquals("https://example.com/", WebEndpoint.normalize(" HTTPS://EXAMPLE.COM:443 "));
        assertEquals("http://example.com/", WebEndpoint.normalize("http://EXAMPLE.com:80"));
    }

    @Test
    public void preservesIdentityBearingPathQueryAndFragment() {
        assertEquals(
                "https://example.com/a/?tab=one#composer",
                WebEndpoint.normalize("https://example.com/a/?tab=one#composer"));
        assertEquals("https://example.com/a", WebEndpoint.normalize("https://example.com/a"));
        assertEquals("https://example.com/a/", WebEndpoint.normalize("https://example.com/a/"));
    }

    @Test
    public void normalizesUserInputAndPreservesExplicitHttpSchemes() {
        assertEquals("https://example.com/", WebEndpoint.normalizeInput("example.com"));
        assertEquals(
                "http://example.com/path",
                WebEndpoint.normalizeInput("http://EXAMPLE.com/path"));
        assertEquals(
                "https://example.com/path",
                WebEndpoint.normalizeInput("https://EXAMPLE.com/path"));
    }

    @Test
    public void equivalentUserInputNormalizesToTheSameIdentity() {
        assertEquals(
                WebEndpoint.normalizeInput("https://example.com/"),
                WebEndpoint.normalizeInput("EXAMPLE.com:443"));
    }

    @Test
    public void rejectsInvalidSchemesAndEmptyUserInput() {
        assertThrows(IllegalArgumentException.class, () -> WebEndpoint.normalizeInput("ftp://example.com"));
        assertThrows(IllegalArgumentException.class, () -> WebEndpoint.normalizeInput("  "));
        assertThrows(IllegalArgumentException.class, () -> WebEndpoint.normalizeInput(null));
    }

    @Test
    public void rejectsUnsupportedOrCredentialBearingUrls() {
        assertThrows(IllegalArgumentException.class, () -> WebEndpoint.normalize("example.com"));
        assertThrows(IllegalArgumentException.class, () -> WebEndpoint.normalize("ftp://example.com"));
        assertThrows(
                IllegalArgumentException.class,
                () -> WebEndpoint.normalize("https://user@example.com"));
    }
}
