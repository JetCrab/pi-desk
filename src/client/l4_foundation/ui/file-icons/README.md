# 文件类型图标

`l4-file-icon.tsx` 是文件树、搜索、预览页签与聊天读取消息共用的文件类型图标入口。常用类型保留彩色图标；环境与工具配置共用中性配置图标，其他已识别代码类型回退通用代码图标，未知文件回退文档图标。目录与操作图标继续使用中性色 Lucide。

`material/` 保留 [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) 的 18 个原始 SVG，来源版本为 `cb1dfb6d9cb73b15681a93939983d75dbba7bf5b`，采用 MIT 许可，完整许可见 [`material/LICENSE`](./material/LICENSE)。

资源通过 Next 静态导入生成带内容哈希的同源地址，浏览器复用相同图标缓存。不依赖完整主题包、字体、运行时 manifest 生成器或外部 CDN。增补类型时只引入实际需要的图标，并检查明暗背景下的可辨识度。
