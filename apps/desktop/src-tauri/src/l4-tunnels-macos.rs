use super::{failed, perform, trusted_window, Message};
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
use tauri::{AppHandle, Manager, WebviewWindow};

struct MainThreadReply(block2::RcBlock<dyn Fn(*mut AnyObject, *mut NSString)>);

// 只转移已复制 Block 的所有权；调用始终经 run_on_main_thread 返回 WebKit 主线程。
unsafe impl Send for MainThreadReply {}

impl MainThreadReply {
    fn respond(self, result: Result<serde_json::Value, String>) {
        let _marker = MainThreadMarker::new().expect("WK 回包必须在主线程执行");
        match result {
            Ok(value) => {
                let value = NSString::from_str(&value.to_string());
                self.0.call((
                    Retained::as_ptr(&value).cast_mut().cast(),
                    std::ptr::null_mut(),
                ));
            }
            Err(error) => {
                let error = NSString::from_str(&error);
                self.0
                    .call((std::ptr::null_mut(), Retained::as_ptr(&error).cast_mut()));
            }
        }
    }
}

struct HandlerState {
    app: AppHandle,
    label: String,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = HandlerState]
    struct PiDeskTunnelsHandler;

    unsafe impl NSObjectProtocol for PiDeskTunnelsHandler {}

    unsafe impl WKScriptMessageHandlerWithReply for PiDeskTunnelsHandler {
        #[unsafe(method(userContentController:didReceiveScriptMessage:replyHandler:))]
        fn receive(
            &self,
            _controller: &WKUserContentController,
            message: &WKScriptMessage,
            reply: &block2::DynBlock<dyn Fn(*mut AnyObject, *mut NSString)>,
        ) {
            let state = self.ivars();
            let request = (|| -> Result<_, String> {
                let frame = unsafe { message.frameInfo() };
                if !unsafe { frame.isMainFrame() } {
                    return Err("只有工作台主框架可以调用插件映射".into());
                }
                let source = unsafe { frame.request().URL().and_then(|url| url.absoluteString()) }
                    .ok_or("插件映射来源无效")?;
                let window = trusted_window(&state.app, &state.label, &source.to_string())?;
                let body = unsafe { message.body() }
                    .downcast::<NSString>()
                    .map_err(|_| "插件映射参数必须是 JSON 字符串")?;
                let body = body.to_string();
                if body.len() > 4096 {
                    return Err("插件映射参数超过大小限制".into());
                }
                let message =
                    serde_json::from_str::<Message>(&body).map_err(|_| "插件映射参数无效")?;
                Ok((window, message))
            })();
            let (window, message) = match request {
                Ok(request) => request,
                Err(error) => {
                    failed(&state.app, &state.label, &error);
                    let error = NSString::from_str(&error);
                    reply.call((std::ptr::null_mut(), Retained::as_ptr(&error).cast_mut()));
                    return;
                }
            };
            // close 必须等待 TCP 回收，不能在 WebKit 主线程等待 Worker。
            let reply = MainThreadReply(reply.copy());
            let app = state.app.clone();
            let label = state.label.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let result = perform(&window, message);
                if let Err(error) = &result {
                    failed(&app, &label, error);
                }
                let _ = app.run_on_main_thread(move || reply.respond(result));
            });
        }
    }
);

pub fn install(window: &WebviewWindow) -> Result<(), String> {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let origin =
        crate::windows::workspace_origin(&app, &label).ok_or("只有有效工作台可以安装映射桥接")?;
    window
        .with_webview(move |platform| {
            let marker = MainThreadMarker::new().expect("WK 桥接必须在主线程创建");
            let handler = PiDeskTunnelsHandler::alloc(marker).set_ivars(HandlerState {
                app: app.clone(),
                label: label.clone(),
            });
            let handler: Retained<PiDeskTunnelsHandler> =
                unsafe { msg_send![super(handler), init] };
            let controller = unsafe { &*platform.controller().cast::<WKUserContentController>() };
            unsafe {
                controller.addScriptMessageHandlerWithReply_contentWorld_name(
                    ProtocolObject::from_ref(&*handler),
                    &WKContentWorld::pageWorld(marker),
                    ns_string!("piDeskTunnels"),
                );
            }
            if let Some(window) = app.get_webview_window(&label) {
                // 首次加载前的 eval 会排队到导航提交，提前发放的文档身份已被 Started 撤销。
                // 正常由 Finished 注入；仅补偿页面先完成、原生 handler 后安装的顺序。
                let ready = format!(
                    "document.readyState === 'complete' && location.origin === {}",
                    serde_json::to_string(&origin.ascii_serialization()).unwrap()
                );
                let current = window.clone();
                if let Err(error) = window.eval_with_callback(ready, move |result| {
                    if result == "true" {
                        if let Err(error) = super::inject(&current) {
                            failed(current.app_handle(), current.label(), &error);
                        }
                    }
                }) {
                    failed(&app, &label, &error.to_string());
                }
            }
        })
        .map_err(|error| format!("安装插件映射桥接失败：{error}"))
}
