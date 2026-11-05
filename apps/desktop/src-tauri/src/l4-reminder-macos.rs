use super::{failed, perform, trusted_window, Request};
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, ProtocolObject},
    DeclaredClass, MainThreadOnly,
};
use objc2_foundation::{ns_string, MainThreadMarker, NSObject, NSObjectProtocol, NSString};
use objc2_web_kit::{
    WKContentWorld, WKScriptMessage, WKScriptMessageHandlerWithReply, WKUserContentController,
};
use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewWindow};

struct HandlerState {
    app: AppHandle,
    label: String,
    origin: url::Origin,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = HandlerState]
    struct PiDeskReminderHandler;

    unsafe impl NSObjectProtocol for PiDeskReminderHandler {}

    unsafe impl WKScriptMessageHandlerWithReply for PiDeskReminderHandler {
        #[unsafe(method(userContentController:didReceiveScriptMessage:replyHandler:))]
        fn receive(
            &self,
            _controller: &WKUserContentController,
            message: &WKScriptMessage,
            reply: &block2::DynBlock<dyn Fn(*mut AnyObject, *mut NSString)>,
        ) {
            let result = self.handle(message);
            match result {
                Ok(value) => {
                    let value = NSString::from_str(&value.to_string());
                    reply.call((
                        Retained::as_ptr(&value).cast_mut().cast(),
                        std::ptr::null_mut(),
                    ));
                }
                Err(error) => {
                    failed(&self.ivars().app, &self.ivars().label, &error);
                    let error = NSString::from_str(&error);
                    reply.call((std::ptr::null_mut(), Retained::as_ptr(&error).cast_mut()));
                }
            }
        }
    }
);

impl PiDeskReminderHandler {
    fn handle(&self, message: &WKScriptMessage) -> Result<Value, String> {
        let state = self.ivars();
        // WKFrameInfo 由 WebKit 提供，不接受页面传入的来源或窗口 label。
        let frame = unsafe { message.frameInfo() };
        if !unsafe { frame.isMainFrame() } {
            return Err("只有工作台主框架可以发送提醒".into());
        }
        let source = unsafe { frame.request().URL().and_then(|url| url.absoluteString()) }
            .ok_or("提醒来源无效")?;
        let window = trusted_window(&state.app, &state.label, &source.to_string(), &state.origin)?;
        let body = unsafe { message.body() }
            .downcast::<NSString>()
            .map_err(|_| "提醒参数必须是 JSON 字符串")?;
        let request =
            serde_json::from_str::<Request>(&body.to_string()).map_err(|_| "提醒参数无效")?;
        perform(&window, request)
    }
}

pub fn install(window: &WebviewWindow) -> Result<(), String> {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let origin =
        crate::windows::reminder_origin(&app, &label).ok_or("只有工作台窗口可以安装提醒桥接")?;
    let script = super::script(&origin);
    window
        .with_webview(move |platform| {
            let marker = MainThreadMarker::new().expect("WK 桥接必须在主线程创建");
            let handler = PiDeskReminderHandler::alloc(marker).set_ivars(HandlerState {
                app: app.clone(),
                label: label.clone(),
                origin,
            });
            let handler: Retained<PiDeskReminderHandler> =
                unsafe { msg_send![super(handler), init] };
            let controller = unsafe { &*platform.controller().cast::<WKUserContentController>() };
            unsafe {
                controller.addScriptMessageHandlerWithReply_contentWorld_name(
                    ProtocolObject::from_ref(&*handler),
                    &WKContentWorld::pageWorld(marker),
                    ns_string!("piDeskReminder"),
                );
            }
            // 原生 Promise 回包随文档释放；controller 持有的 handler 随 WebView 销毁。
            if let Some(window) = app.get_webview_window(&label) {
                if let Err(error) = window.eval(script) {
                    failed(&app, &label, &error.to_string());
                }
            }
        })
        .map_err(|error| format!("安装桌面提醒桥接失败：{error}"))
}
