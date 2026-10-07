# 文件类型图标

`l4-file-icon.tsx` 是宿主文件类型图标入口。特殊文件名优先于扩展名，未知类型回退 Lucide 文档图标；操作图标继续使用 Lucide。

`material/` 保留 [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) 的 18 个原始 SVG，来源版本为 `cb1dfb6d9cb73b15681a93939983d75dbba7bf5b`，采用 MIT 许可，完整许可见 [`material/LICENSE`](./material/LICENSE)。

资源通过 Next 静态导入生成带内容哈希的同源地址，浏览器复用相同图标缓存。不依赖完整主题包、字体、运行时 manifest 生成器或外部 CDN。增补类型时只引入实际需要的图标，并检查明暗背景下的可辨识度。
