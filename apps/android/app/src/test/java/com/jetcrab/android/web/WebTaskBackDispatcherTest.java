package com.jetcrab.android.web;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class WebTaskBackDispatcherTest {
    @Test
    public void parsesConsumedEscapeResults() {
        assertTrue(WebTaskBackDispatcher.wasConsumed("{\"keydown\":true,\"keyup\":false}"));
        assertTrue(WebTaskBackDispatcher.wasConsumed("\"{\\\"keydown\\\":false,\\\"keyup\\\":true}\""));
        assertFalse(WebTaskBackDispatcher.wasConsumed("{\"keydown\":false,\"keyup\":false}"));
        assertFalse(WebTaskBackDispatcher.wasConsumed(null));
    }

    @Test
    public void letsThePageConsumeBackBeforeMovingTheTask() {
        FakeActions actions = new FakeActions();
        WebTaskBackDispatcher dispatcher = new WebTaskBackDispatcher(actions);

        dispatcher.onBackPressed();
        actions.callback.onResult("{\"keydown\":true,\"keyup\":false}");

        assertEquals(1, actions.dispatchCount);
        assertEquals(0, actions.moveCount);
    }

    @Test
    public void movesTaskBackWhenPageDoesNotConsumeEscape() {
        FakeActions actions = new FakeActions();
        WebTaskBackDispatcher dispatcher = new WebTaskBackDispatcher(actions);

        dispatcher.onBackPressed();
        actions.callback.onResult("{\"keydown\":false,\"keyup\":false}");

        assertEquals(1, actions.moveCount);
    }

    @Test
    public void ignoresDuplicateBackWhileJavascriptResultIsPending() {
        FakeActions actions = new FakeActions();
        WebTaskBackDispatcher dispatcher = new WebTaskBackDispatcher(actions);

        dispatcher.onBackPressed();
        dispatcher.onBackPressed();

        assertEquals(1, actions.dispatchCount);
    }

    private static final class FakeActions implements WebTaskBackDispatcher.Actions {
        int dispatchCount;
        int moveCount;
        WebTaskBackDispatcher.ResultCallback callback;

        @Override
        public boolean isJavaScriptReady() {
            return true;
        }

        @Override
        public void dispatchEscape(WebTaskBackDispatcher.ResultCallback callback) {
            dispatchCount++;
            this.callback = callback;
        }

        @Override
        public boolean moveTaskToBack() {
            moveCount++;
            return true;
        }
    }
}
