# Fetchy

[![License: AGPL-3.0](docs/assets/badges/license.svg)](LICENSE)
![Node >= 22](docs/assets/badges/node.svg)
![Platform: macOS](docs/assets/badges/platform.svg)

用 CLI、浏览器扩展或 macOS 桌面端把视频、音频和可离线阅读的帖子存进本地资料库。

[English](README.md)

## 演示

https://github.com/user-attachments/assets/e5ebb617-7dd1-4369-b044-b7e8900cb662

## 特性

- **从页面或链接开始。** 点工具栏图标，Fetchy 在当前页右侧打开。也可以粘贴一条链接。支持短链的平台也可以粘贴含单条链接的分享文案。
- **下载在本机执行。** 扩展把下载交给本地组件，无需注册 Fetchy 账号。
- **经过校验的 MP4。** 每个输出都经 ffprobe 校验。yt-dlp 下载输出 H.264 / yuv420p 视频，有音轨时使用 AAC。浏览器引擎保留源编码，包括 HEVC。文件名使用视频标题，重名自动加序号，不覆盖已有文件。
- **关掉右侧栏也继续。** 保存由独立本地进程持有，关掉右侧栏或浏览器都不会中断。批量保存的每一条单独记录结果，可以单独重试。
- **一套核心。** 扩展、CLI 和 Node API 共用同一个 `resolveVideo` / `downloadVideo` 契约和稳定的错误码。

## 支持的平台

| 平台         | 接受的输入                                                                      | 引擎             | 说明                                                     |
| ------------ | ------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------- |
| YouTube      | `youtube.com/watch`、`youtu.be`、Shorts                                         | yt-dlp           | 优先原生 H.264/AAC，网络错误时有限尝试 HLS               |
| B站          | `bilibili.com/video/BV…`、`av…`、分 P `?p=`                                     | yt-dlp           | DASH 音视频合并为 MP4                                    |
| 小红书       | 含 `xsec_token` 的完整分享链接，或含单个链接的分享文案                          | 页面读取（扩展） | 直接从你浏览器里的笔记页读取媒体；CLI 退回 yt-dlp        |
| 抖音         | `v.douyin.com` 短链、`modal_id` 链接、详情页                                    | 页面读取（扩展） | 先展开短链；CLI 退回 yt-dlp                              |
| X（Twitter） | `x.com/<用户名>/status/<帖子 ID>`，也支持 `twitter.com` 和 `/i/web/status/<ID>` | yt-dlp           | 含单个可提取视频的公开帖子                               |
| Instagram    | `instagram.com/reel/<作品短码>/`                                                | yt-dlp           | 单个公开 Reel，含作者主页下的详情链接和 `/reels/<短码>/` |

另有 Facebook、TikTok、Bluesky、Reddit、Pinterest、微博、视频托管和音乐站点的单链适配。各站已验证的成品、图文和收藏历史范围见[完整平台表](docs/platforms.md)。

## 桌面端和本地资料库

在 macOS 14 及以上运行 `npm run desktop:build` 即可构建可双击的 Fetchy.app。桌面端只有一个窗口，分三个区：资料库（封面或列表显示，可多选后打开、在访达中显示、重命名或删除）、带右侧栏的内置浏览器、账号。在「账号」里登录一次，扩展、命令行和桌面端下载时都会用到。资料库需要 Node 22.13 或更高版本。[桌面端设置](docs/desktop.md) · [收藏清单与命令](docs/library.md)

```sh
fetchy '<链接>'                      # 保存到资料库，同 fetchy get
fetchy get '<链接>' -o ./downloads   # 另存一份到目录；--audio 只要音频
fetchy get -i links.txt              # 每行一个链接，逐条输出 JSON
fetchy info '<链接>'
fetchy login bilibili                # 在桌面端登录；另有 logout、accounts
fetchy folders bilibili              # 列出收藏夹；fetchy sync <收藏夹链接> 保存整个收藏夹
fetchy list                          # 另有 search <关键词>、retry [任务ID]
```

在源码目录里用 `node bin/fetchy.mjs` 代替 `fetchy`。`fetchy help all` 列出旧命令 `resolve`、`download`、`browse`、`batch` 和 `library …`，它们仍可使用。`get` 输出包含任务 ID 和本地路径的 JSON，遇到部分保存或失败时返回非零。用当前浏览器的登录状态保存图文或收藏夹，可在原帖或列表页打开扩展。离线页面保留可读正文、附件顺序及缺失项。[通用网页与验证](docs/web-media.md)

## 环境要求

| 工具               | 用途                              | macOS 安装             |
| ------------------ | --------------------------------- | ---------------------- |
| Node.js 22.13+     | 所有功能                          | `brew install node`    |
| FFmpeg + ffprobe   | 合并、重封装、校验                | `brew install ffmpeg`  |
| Python 3.10+       | 运行固定版本的 yt-dlp             | `brew install python`  |
| yt-dlp（固定版本） | 所有 CLI 下载及扩展的 yt-dlp 下载 | `npm run deps:install` |

随时运行 `npm run doctor` 查看哪些工具已找到、哪些缺失。

`npm run deps:install` 将 `requirements.txt` 中固定版本的 yt-dlp 安装到项目的 `.venv`。
它是 Node 核心调用的外部下载器，单独执行 `npm install` 不会安装它。此命令适用于
macOS、Linux 和 Windows，也可以重复执行以应用依赖更新。需要指定 Python 时，使用
`npm run deps:install -- --python /path/to/python3`。Node、Python 和 FFmpeg 仍由系统包管理器安装。

native host 安装脚本目前只支持 **macOS**。下载核心和 CLI 也能在 Linux 和 Windows 上运行。

## 快速开始

```sh
git clone https://github.com/0xFANGO/fetchy.git
cd fetchy
npm install
npm run deps:install
npm run doctor

# 下载到 ./downloads
node bin/fetchy.mjs download 'https://www.bilibili.com/video/BV19Pnb6REhD/'
```

CLI 以 JSON 输出结果，包含文件绝对路径、大小和校验信息；阶段信息写入 stderr。`Ctrl+C` 可干净地取消，不会留下半截文件。

## 浏览器扩展

下载扩展 ZIP 后，注册同版本的本地组件。有桌面端 ZIP 的版本可以直接用 App 里的安装脚本，旧版本的安装脚本在对应的源码包里。[最新 Release](https://github.com/0xFANGO/fetchy/releases/latest) · [安装与更新](docs/extension-install.md)

从源码构建扩展时运行：

```sh
npm run extension:build                 # 构建当前源码，输出到 dist/extension
npm run native:install -- --browser chrome # 注册 native host；Ego Lite 用 --browser ego
```

1. 打开 `chrome://extensions/`，开启开发者模式，点击「加载已解压的扩展程序」，选择 `dist/extension`（或 Release 解压出来的 `extension` 文件夹）。
2. 把扩展固定到工具栏。
3. 在任意页面点图标，Fetchy 在 Chrome 右侧栏打开。

在帖子页，右侧栏显示标题、作者、正文是否完整、图片和视频数。「保存这篇帖子」保存全部内容，「只下载视频」只保存视频文件。在收藏夹页，「再读一屏」「自动读到底」在当前页前台滚动或翻页，你自己往下翻时列表也会增加。勾选后点「保存所选」，本机组件立即接下清单并自行下载每个文件，关掉右侧栏或浏览器都不影响。

只下载视频时默认保存到 `~/Downloads/Fetchy`。点击右侧栏底部的目录即可更改。

Fetchy 读取页面时不打开新标签页。小红书和抖音视频直接从已打开的视频页读取播放数据。短链需要先在浏览器里打开。用的是你当前浏览器的登录态。申请的权限：`activeTab`、`storage`、`nativeMessaging`、`scripting`、`sidePanel`，以及 `xiaohongshu.com`、`rednote.com`、`douyin.com` 和 `iesdouyin.com` 的站点访问权限。

各浏览器和站点的实测结果见[扩展验证记录](docs/extension-validation.md)。注册本地组件、登录及故障排查见[安装说明](docs/extension-install.md)。

读取部分站点的收藏夹时，扩展可能请求该站点的访问权限。[扩展收藏操作](docs/extension-library.md)

## 原有视频命令

```sh
node bin/fetchy.mjs resolve  <url>   # 只解析规格，不下载
node bin/fetchy.mjs download <url>   # 下载
```

| 选项                    | 默认值        | 说明                                                        |
| ----------------------- | ------------- | ----------------------------------------------------------- |
| `--output <目录>`       | `./downloads` | 成片直接保存到此目录，同名文件自动加序号                    |
| `--engine auto\|yt-dlp` | `auto`        | 命令行全部平台使用 yt-dlp；浏览器引擎只能由扩展触发         |
| `--max-height <像素>`   | 不限          | 实际帧高度上限（1080×1920 竖屏的高度是 1920）               |
| `--transport auto\|hls` | `auto`        | YouTube 强制使用 HLS                                        |
| `--timeout-ms <毫秒>`   | 30 分钟       | 整个任务的超时                                              |
| `--cookies-file <文件>` | 无            | 仅 yt-dlp 引擎使用的 Netscape Cookie 文件，使用临时私有副本 |

`npm run download -- <url>` 和 `npm run resolve -- <url>` 是同样命令的快捷方式。

## Node API

```js
import {resolveVideo, downloadVideo} from './src/index.mjs';

const url = 'https://www.bilibili.com/video/BV19Pnb6REhD/';

const info = await resolveVideo(url);
console.log(info.title, info.durationSeconds, info.formats.length);

const result = await downloadVideo(url, {
	outputDir: './downloads',
	maxHeight: 1080,
	onProgress: ({stage}) => console.log(stage),
});
console.log(result.filepath, result.validation);
```

选项：`outputDir`、`engine`、`maxHeight`、`transport`、`timeoutMs`、`signal`（`AbortSignal`）、`onProgress`、`cookiesFile`，以及工具路径 `ytDlpPath`、`ffmpegLocation`、`ffprobePath`。`pageMedia` 用于传入 `extractPageMedia` 从小红书或抖音页面读到的结果，传入后这两个平台会走浏览器引擎；扩展会自动填入。

`resolveVideo` 返回可展示的元数据（`platform`、`id`、`title`、`thumbnailUrl`、`durationSeconds`、`formats`），不暴露签名媒体 URL。
`downloadVideo` 重新解析链接、下载、校验，返回 `{filepath, bytes, validation, conversion, …}`。
失败抛出带稳定 `code` 的 `EngineError`，例如 `invalid_url`、`unsupported_platform`、`network_error`、`auth_required`、`verification_required`、`drm`、`no_formats`、`dependency_missing`、`timeout`、`cancelled`。

## 工作原理

```
extension/   Manifest V3 右侧栏 + worker        ─┐
bin/         CLI                                 ├─▶ src/index.mjs ─▶ yt-dlp 引擎（yt-dlp + FFmpeg）
native/      Native Messaging host + daemon     ─┘                  └─▶ 浏览器引擎（扩展从页面读取媒体）
```

小红书和抖音由 service worker 把 `src/page-extract.mjs` 注入视频页，只取回目标视频的标题、封面和带签名的媒体地址；native host 从这些地址下载并校验文件。右侧栏只是视图。native host 把每个任务交给独立的 daemon 进程执行，所以关闭右侧栏、service worker 重建或端口断开都不会取消传输。批量保存从清单开始。原帖页面统一由 `src/library/post-pages.mjs` 解析，无论它来自扩展在当前页的同站请求，还是 daemon 用桌面端登录读取，所有媒体文件都由 daemon 下载。持久化的任务记录不含原始输入、token 或签名 URL。

## 开发

```sh
npm test              # 离线契约测试；MP4 相关用例需要 FFmpeg
npm run check         # oxfmt --check + oxlint
npm run fmt           # 格式化
```

参与方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。设计文档、平台调研和真实验证记录在 [docs/](docs/)。

## 许可证

[AGPL-3.0](LICENSE)。可以自由使用、修改和分享；分发修改版或以服务形式提供时，必须以相同许可证公开源码。

本工具用于保存你有权保留的内容，仅限个人使用。请遵守各平台的服务条款，尊重内容创作者的权利。许可证只覆盖代码，不覆盖任何下载下来的内容。

平台名称和标志归各自所有者所有，Fetchy 与这些平台无关联，也未获其认可。图标来自 [Simple Icons](https://simpleicons.org)（CC0）。
