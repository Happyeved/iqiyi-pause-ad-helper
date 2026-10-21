# iqiyi-pause-ad-helper

爱奇艺网页暂停广告处理脚本，支持画面单击和空格切换播放状态。

- **当前版本**：1.1
- **使用环境**：Firefox + Tampermonkey（油猴）

## 脚本功能

- 自动检测并关闭暂停广告，减少广告闪现。
- 支持画面单击和空格切换播放／暂停。
- 临时保护播放器尺寸和位置，适配窗口及全屏变化。
- 保留弹幕、弹幕菜单、播放器控件及弹窗的原生交互。

## 安装与更新

1. 在浏览器中安装并启用 Tampermonkey（油猴）。
2. [点击安装或更新至 v1.1](https://github.com/Happyeved/iqiyi-pause-ad-helper/raw/refs/heads/main/iqiyi-pause-ad-helper-1.1.user.js)。
3. 按油猴页面提示确认安装或更新，确认版本为 **1.1**、作者为 **Happyeved**。
4. 刷新已经打开的爱奇艺视频页面，使新版脚本生效。

## v1.1 更新说明

相对 v1.0：

- 修复弹幕点击被误判为画面单击、导致视频暂停的问题。
- 优化“反馈与修复”等弹窗的点击识别，放行关闭图标、弹窗内容和遮罩的点击。
- 收紧画面单击的接管范围，减少播放控制与网页控件之间的冲突。
- 保留暂停广告自动关闭、播放器布局保护、全屏适配和空格播放控制功能。

## 历史版本

仓库保留旧版脚本，当前安装链接指向 v1.1。

- [v1.1 当前版本](https://github.com/Happyeved/iqiyi-pause-ad-helper/blob/main/iqiyi-pause-ad-helper-1.1.user.js)
- [v1.0 历史版本](https://github.com/Happyeved/iqiyi-pause-ad-helper/blob/main/iqiyi-pause-ad-helper.user.js)
