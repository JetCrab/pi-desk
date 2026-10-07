use std::path::PathBuf;

pub(crate) fn pick_file(
    title: &str,
    extensions: &[&str],
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Option<PathBuf> {
    let dialog = rfd::FileDialog::new()
        .set_title(title)
        .add_filter("运行环境", extensions);
    #[cfg(windows)]
    {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::thread;
        use std::time::Duration;
        use windows_sys::Win32::System::Threading::GetCurrentThreadId;
        use windows_sys::Win32::UI::WindowsAndMessaging::EnumThreadWindows;

        let thread_id = unsafe { GetCurrentThreadId() };
        let done = AtomicBool::new(false);
        struct Done<'a>(&'a AtomicBool);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        thread::scope(|scope| {
            scope.spawn(|| {
                while !done.load(Ordering::Acquire) {
                    if cancelled() {
                        // 只关闭当前选择线程创建的文件对话框，不接触宿主或其他应用窗口。
                        unsafe {
                            EnumThreadWindows(thread_id, Some(close_dialog), 0);
                        }
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            });
            let _done = Done(&done);
            if cancelled() {
                None
            } else {
                dialog.pick_file()
            }
        })
    }
    #[cfg(not(windows))]
    {
        if cancelled() {
            None
        } else {
            dialog.pick_file()
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn pick_directory(
    title: &str,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Option<PathBuf> {
    if cancelled() {
        return None;
    }
    rfd::FileDialog::new().set_title(title).pick_folder()
}

#[cfg(windows)]
unsafe extern "system" fn close_dialog(
    window: windows_sys::Win32::Foundation::HWND,
    _: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::core::BOOL {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetClassNameW, PostMessageW, WM_CLOSE};
    let mut class = [0u16; 32];
    let length = GetClassNameW(window, class.as_mut_ptr(), class.len() as i32);
    if length > 0 && String::from_utf16_lossy(&class[..length as usize]) == "#32770" {
        PostMessageW(window, WM_CLOSE, 0, 0);
    }
    1
}
