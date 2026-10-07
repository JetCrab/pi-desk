# Pi Desk iOS

iOS 17+ 的原生 SwiftUI 客户端，支持 iPhone 与 iPad。添加自己的 Pi Desk 服务地址后，在 WKWebView 中使用网页的登录、聊天、文件和插件功能；手机不运行 Node 或 Pi。连接列表使用 UserDefaults，登录 Cookie 由系统 WKWebsiteDataStore 管理。

`project.yml` 是唯一工程配置源；生成的 `PiDesk.xcodeproj` 不提交。无需第三方 Swift SDK。在安装 Xcode 的 macOS 上，从仓库根目录执行：

```sh
brew install xcodegen
xcodegen generate --spec apps/ios/project.yml
xcodebuild -project apps/ios/PiDesk.xcodeproj -scheme PiDesk \
  -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath apps/ios/temp/DerivedData-simulator \
  CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apps/ios/PiDesk.xcodeproj -scheme PiDesk \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath apps/ios/temp/PiDesk.xcarchive \
  -derivedDataPath apps/ios/temp/DerivedData-device \
  CODE_SIGNING_ALLOWED=NO archive
```

固定产物为 `PiDesk.app`，Bundle ID 为 `com.jetcrab.ios`，版本为 `1.0.0 (1)`。未签名模拟器 App 与未签名设备 Archive 只用于构建验证，不能作为真机安装包；这里不生成 IPA。后续签名可通过 xcodebuild 注入 `DEVELOPMENT_TEAM`、`CODE_SIGN_STYLE` 和 `PROVISIONING_PROFILE_SPECIFIER`，源码不保存团队或证书。

无协议的地址补 `http://`，支持保留服务路径，拒绝重复地址、账号密码及非法端口。同源网页留在应用，跨源顶层链接交给系统浏览器；仅用户点击的 `mailto:` / `tel:` 交给系统，不执行其他外部协议。文件选择采用 WKWebView 的系统选择器，JS 对话框采用原生确认框；不提供相机或麦克风采集权限，不注入原生桥接，不绕过 TLS 校验。

最多保留三个网页实例；删除、修改连接及内存警告可释放实例，系统 Cookie 不随网页实例释放。下载一次处理一个文件，完成后系统分享，离开网页或关闭分享后删除临时文件，应用重新启动时清理遗留下载。

本轮仅进行 JSON、Plist、YAML 和资源静态检查。实际 Swift 编译、模拟器运行、真机安装、网页交互与视觉效果须由 macOS 云端构建及后续设备验证确认。
