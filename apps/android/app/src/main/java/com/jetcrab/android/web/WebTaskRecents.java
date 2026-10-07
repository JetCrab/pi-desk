package com.jetcrab.android.web;

import android.app.ActivityManager;
import android.content.Context;

public final class WebTaskRecents {
    private WebTaskRecents() {}

    public static void remove(Context context, String url) {
        ActivityManager manager = context.getApplicationContext()
                .getSystemService(ActivityManager.class);
        if (manager == null) {
            return;
        }
        for (ActivityManager.AppTask task : manager.getAppTasks()) {
            if (WebTaskIntent.matches(task.getTaskInfo().baseIntent, url)) {
                task.finishAndRemoveTask();
            }
        }
    }
}
