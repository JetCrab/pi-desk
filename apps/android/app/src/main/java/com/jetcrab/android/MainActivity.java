package com.jetcrab.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputType;
import android.text.SpannableString;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.text.style.ForegroundColorSpan;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ScrollView;
import android.widget.TextView;
import com.jetcrab.android.web.WebEndpointStore;
import com.jetcrab.android.web.WebSessionStoreProvider;
import com.jetcrab.android.web.WebTaskIntent;
import com.jetcrab.android.web.WebTaskRecents;
import java.util.List;

public final class MainActivity extends Activity {
    private WebEndpointStore endpointStore;
    private MainUi ui;
    private LinearLayout list;
    private Button addButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        endpointStore = new WebEndpointStore(getApplicationContext());
        ui = new MainUi(this);
        configureSystemBars();
        setContentView(createContent());
    }

    @Override
    protected void onResume() {
        super.onResume();
        renderUrls();
    }

    private View createContent() {
        LinearLayout root = column();
        root.setBackgroundColor(ui.color(R.color.main_background));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(ui.dp(16), ui.dp(16), ui.dp(16), ui.dp(12));
        TextView title = ui.text(getString(R.string.main_title), 20, R.color.main_text);
        ui.heading(title);
        header.addView(title, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        addButton = ui.button(R.string.add_url, false);
        addButton.setOnClickListener(view -> showUrlDialog(null));
        header.addView(addButton);
        root.addView(header);
        root.addView(ui.divider(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ui.dp(1)));

        ScrollView scroll = new ScrollView(this);
        scroll.setClipToPadding(false);
        scroll.setPadding(ui.dp(16), 0, ui.dp(16), ui.dp(16));
        list = column();
        scroll.addView(list, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        return root;
    }

    private void renderUrls() {
        if (list == null) {
            return;
        }
        list.removeAllViews();
        List<String> urls = endpointStore.loadUrls();
        addButton.setVisibility(urls.isEmpty() ? View.GONE : View.VISIBLE);
        if (urls.isEmpty()) {
            list.addView(createEmptyState());
            return;
        }
        for (int index = 0; index < urls.size(); index++) {
            if (index > 0) {
                list.addView(ui.divider(), new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ui.dp(1)));
            }
            list.addView(createUrlRow(urls.get(index)));
        }
    }

    private View createEmptyState() {
        LinearLayout empty = column();
        empty.setPadding(0, ui.dp(24), 0, ui.dp(24));
        TextView title = ui.text(getString(R.string.empty_title), 18, R.color.main_text);
        ui.heading(title);
        empty.addView(title);
        TextView description = ui.text(getString(R.string.empty_description), 14, R.color.main_muted);
        empty.addView(description, spacedParams(8));
        Button add = ui.button(R.string.add_url, true);
        add.setOnClickListener(view -> showUrlDialog(null));
        empty.addView(add, spacedParams(16));
        return empty;
    }

    private View createUrlRow(String url) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, ui.dp(12), 0, ui.dp(12));
        TextView address = ui.text(url, 14, R.color.main_text);
        address.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        address.setMaxLines(2);
        address.setEllipsize(TextUtils.TruncateAt.END);
        row.addView(address, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        Button open = ui.button(R.string.open_url, true);
        open.setContentDescription(getString(R.string.open_url_accessibility, url));
        open.setOnClickListener(view -> startActivity(WebTaskIntent.create(this, url)));
        LinearLayout.LayoutParams openParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        openParams.setMarginStart(ui.dp(12));
        row.addView(open, openParams);

        ImageButton more = new ImageButton(this);
        more.setImageResource(R.drawable.ic_more);
        more.setImageTintList(ColorStateList.valueOf(ui.color(R.color.main_muted)));
        more.setContentDescription(getString(R.string.more_url_accessibility, url));
        more.setTooltipText(getString(R.string.more_actions));
        more.setPadding(ui.dp(8), ui.dp(8), ui.dp(8), ui.dp(8));
        more.setBackground(ui.interactiveBackground(R.color.main_background, false));
        more.setOnClickListener(view -> showUrlMenu(more, url));
        LinearLayout.LayoutParams moreParams = new LinearLayout.LayoutParams(ui.dp(32), ui.dp(32));
        moreParams.setMarginStart(ui.dp(8));
        row.addView(more, moreParams);
        return row;
    }

    private void showUrlMenu(View anchor, String url) {
        PopupMenu menu = new PopupMenu(this, anchor, Gravity.END);
        menu.getMenu().add(0, 1, 0, R.string.refresh_url);
        menu.getMenu().add(0, 2, 1, R.string.edit_url);
        SpannableString remove = new SpannableString(getString(R.string.remove_url));
        remove.setSpan(new ForegroundColorSpan(ui.color(R.color.main_danger)), 0, remove.length(), 0);
        menu.getMenu().add(1, 3, 2, remove);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            menu.getMenu().setGroupDividerEnabled(true);
        }
        menu.setOnMenuItemClickListener(item -> {
            switch (item.getItemId()) {
                case 1:
                    WebSessionStoreProvider.get(this).refresh(url);
                    startActivity(WebTaskIntent.create(this, url));
                    return true;
                case 2:
                    showUrlDialog(url);
                    return true;
                case 3:
                    confirmDelete(url);
                    return true;
                default:
                    return false;
            }
        });
        menu.show();
    }

    private void showUrlDialog(String originalUrl) {
        LinearLayout form = column();
        form.setPadding(ui.dp(24), ui.dp(16), ui.dp(24), ui.dp(8));
        TextView label = ui.text(getString(R.string.url_label), 14, R.color.main_text);
        form.addView(label);
        EditText input = new EditText(this);
        input.setId(View.generateViewId());
        label.setLabelFor(input.getId());
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setImeOptions(EditorInfo.IME_ACTION_DONE | EditorInfo.IME_FLAG_NO_EXTRACT_UI);
        input.setHint(R.string.url_hint);
        input.setText(originalUrl == null ? "" : originalUrl);
        input.setSelectAllOnFocus(originalUrl != null);
        ui.styleInput(input);
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        inputParams.topMargin = ui.dp(4);
        form.addView(input, inputParams);
        TextView errorMessage = ui.text("", 14, R.color.main_danger);
        errorMessage.setVisibility(View.GONE);
        errorMessage.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        form.addView(errorMessage, spacedParams(4));
        form.addView(ui.text(getString(R.string.url_protocol_hint), 14, R.color.main_muted), spacedParams(8));
        if (originalUrl != null) {
            form.addView(ui.text(getString(R.string.edit_url_hint), 14, R.color.main_muted), spacedParams(8));
        }
        input.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence value, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence value, int start, int before, int count) {
                errorMessage.setVisibility(View.GONE);
            }

            @Override
            public void afterTextChanged(Editable value) {
            }
        });
        ScrollView scroll = new ScrollView(this);
        scroll.addView(form);
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setCustomTitle(dialogTitle(originalUrl == null ? R.string.add_url : R.string.edit_url))
                .setView(scroll)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(originalUrl == null ? R.string.add : R.string.save, null)
                .create();
        dialog.setOnShowListener(ignored -> {
            styleDialogButtons(dialog, false);
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
                try {
                    String nextUrl = originalUrl == null
                            ? endpointStore.add(input.getText().toString())
                            : endpointStore.replace(originalUrl, input.getText().toString());
                    if (originalUrl != null && !originalUrl.equals(nextUrl)) {
                        WebTaskRecents.remove(this, originalUrl);
                        WebSessionStoreProvider.get(this).release(originalUrl);
                    }
                    dialog.dismiss();
                    renderUrls();
                } catch (IllegalArgumentException error) {
                    errorMessage.setText(error.getMessage());
                    errorMessage.setVisibility(View.VISIBLE);
                    input.requestFocus();
                }
            });
            input.setOnEditorActionListener((view, actionId, event) -> {
                if (actionId == EditorInfo.IME_ACTION_DONE) {
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
                    return true;
                }
                return false;
            });
            input.requestFocus();
            dialog.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                    | WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
        });
        dialog.show();
    }

    private void confirmDelete(String url) {
        LinearLayout content = column();
        content.setPadding(ui.dp(24), ui.dp(16), ui.dp(24), ui.dp(8));
        TextView address = ui.text(url, 14, R.color.main_text);
        address.setTextIsSelectable(true);
        content.addView(address);
        content.addView(ui.text(getString(R.string.remove_url_hint), 14, R.color.main_muted), spacedParams(12));
        ScrollView scroll = new ScrollView(this);
        scroll.addView(content);
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setCustomTitle(dialogTitle(R.string.remove_url_title))
                .setView(scroll)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.remove, (ignored, which) -> {
                    if (endpointStore.delete(url)) {
                        WebTaskRecents.remove(this, url);
                        WebSessionStoreProvider.get(this).release(url);
                        renderUrls();
                    }
                })
                .create();
        dialog.setOnShowListener(ignored -> styleDialogButtons(dialog, true));
        dialog.show();
    }

    private TextView dialogTitle(int resource) {
        TextView title = ui.text(getString(resource), 18, R.color.main_text);
        ui.heading(title);
        title.setPadding(ui.dp(24), ui.dp(20), ui.dp(24), 0);
        return title;
    }

    private void styleDialogButtons(AlertDialog dialog, boolean destructive) {
        ui.styleButton(dialog.getButton(AlertDialog.BUTTON_NEGATIVE), false, false);
        ui.styleButton(dialog.getButton(AlertDialog.BUTTON_POSITIVE), !destructive, destructive);
        dialog.getWindow().setLayout(
                Math.min(ui.dp(440), getResources().getDisplayMetrics().widthPixels - ui.dp(32)),
                ViewGroup.LayoutParams.WRAP_CONTENT);
        ViewGroup.MarginLayoutParams params = (ViewGroup.MarginLayoutParams)
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).getLayoutParams();
        params.setMarginStart(ui.dp(8));
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setLayoutParams(params);
    }

    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private LinearLayout.LayoutParams spacedParams(int topMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = ui.dp(topMargin);
        return params;
    }

    private void configureSystemBars() {
        int background = ui.color(R.color.main_background);
        getWindow().setStatusBarColor(background);
        getWindow().setNavigationBarColor(background);
        boolean darkMode = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        getWindow().getDecorView().setSystemUiVisibility(darkMode ? 0
                : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    }
}
