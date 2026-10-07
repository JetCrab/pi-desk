package com.jetcrab.android;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Build;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

final class MainUi {
    private final Context context;

    MainUi(Context context) {
        this.context = context;
    }

    int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    int color(int resource) {
        return context.getColor(resource);
    }

    TextView text(CharSequence value, int sizeSp, int colorResource) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextSize(sizeSp);
        view.setTextColor(color(colorResource));
        view.setIncludeFontPadding(false);
        view.setLineSpacing(0, 1.2f);
        return view;
    }

    void heading(TextView view) {
        view.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            view.setAccessibilityHeading(true);
        }
    }

    Button button(int label, boolean primary) {
        Button button = new Button(context);
        button.setText(label);
        styleButton(button, primary, false);
        return button;
    }

    void styleButton(Button button, boolean primary, boolean destructive) {
        button.setAllCaps(false);
        button.setTextSize(14);
        button.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        button.setMinHeight(dp(32));
        button.setMinimumHeight(dp(32));
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setPadding(dp(8), dp(6), dp(8), dp(6));
        button.setTextColor(color(destructive ? R.color.main_danger
                : primary ? R.color.main_primary_text : R.color.main_text));
        button.setBackgroundTintList(null);
        button.setBackground(interactiveBackground(primary ? R.color.main_primary
                : android.R.color.transparent, primary));
        button.setStateListAnimator(null);
    }

    RippleDrawable interactiveBackground(int surface, boolean primary) {
        GradientDrawable normal = shape(color(surface), 8);
        GradientDrawable focused = shape(color(surface), 8);
        focused.setStroke(dp(2), color(primary ? R.color.main_primary_text : R.color.main_focus));
        StateListDrawable states = new StateListDrawable();
        states.addState(new int[] {android.R.attr.state_focused}, focused);
        states.addState(new int[0], normal);
        return new RippleDrawable(ColorStateList.valueOf(color(primary
                ? R.color.main_primary_ripple : R.color.main_ripple)), states, null);
    }

    void styleInput(EditText input) {
        input.setTextSize(14);
        input.setTextColor(color(R.color.main_text));
        input.setHintTextColor(color(R.color.main_muted));
        input.setMinHeight(dp(32));
        input.setPadding(dp(10), dp(8), dp(10), dp(8));
        GradientDrawable normal = shape(color(R.color.main_background), 8);
        normal.setStroke(dp(1), color(R.color.main_input_border));
        GradientDrawable focused = shape(color(R.color.main_background), 8);
        focused.setStroke(dp(2), color(R.color.main_focus));
        StateListDrawable states = new StateListDrawable();
        states.addState(new int[] {android.R.attr.state_focused}, focused);
        states.addState(new int[0], normal);
        input.setBackgroundTintList(null);
        input.setBackground(states);
    }

    View divider() {
        View divider = new View(context);
        divider.setBackgroundColor(color(R.color.main_border));
        divider.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        return divider;
    }

    private GradientDrawable shape(int color, int radius) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(color);
        shape.setCornerRadius(dp(radius));
        return shape;
    }
}
