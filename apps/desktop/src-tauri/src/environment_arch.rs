#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsArchitecture {
    X86,
    X64,
}

pub(crate) fn from_processor_architecture(value: u16) -> Result<WindowsArchitecture, String> {
    match value {
        0 => Ok(WindowsArchitecture::X86),
        9 => Ok(WindowsArchitecture::X64),
        _ => Err(format!(
            "当前 Windows 架构（processorArchitecture={value}）不支持自动下载，请手动选择可运行的本机环境"
        )),
    }
}

pub(crate) fn native_architecture() -> Result<WindowsArchitecture, String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{GetNativeSystemInfo, SYSTEM_INFO};

        let mut info = SYSTEM_INFO::default();
        // WOW64 的进程架构不代表操作系统架构；只读取原生系统信息。
        unsafe {
            GetNativeSystemInfo(&mut info);
            from_processor_architecture(info.Anonymous.Anonymous.wProcessorArchitecture)
        }
    }
    #[cfg(not(windows))]
    {
        Err("自动准备运行环境仅支持 Windows，请手动选择本机环境".into())
    }
}
