# Fetchy 扩展安装与使用

支持环境为 macOS + Chromium Manifest V3；真实验证在 Ego Lite 上完成，Chrome 走同样的流程。真实验收进度见 [扩展验证记录](extension-validation.md)，不能将离线测试等同于四个平台真实下载均通过。

## 1. 安装依赖与构建

需要 Node.js 22+、Python 3.10+、FFmpeg（含 ffprobe）。小红书/抖音不需要额外软件：扩展直接从你浏览器里的视频页读取媒体信息。

在项目根目录运行：

```bash
npm run deps:install
npm test
npm run extension:build
npm run native:install -- --browser chrome
```

`npm run deps:install` 按 `requirements.txt` 将 yt-dlp 安装到项目 `.venv`，不修改全局 Python 环境；依赖更新后可重复执行。默认查找系统 Python，需要指定版本时使用 `npm run deps:install -- --python /path/to/python3`。

随时可以运行 `npm run doctor` 查看哪些工具已找到、哪些缺失或无法运行，以及对应的安装提示。Node 运行时没有额外 npm 依赖，`npm install` 只安装格式化与 lint 工具。安装脚本记录当前 Node、yt-dlp、FFmpeg 命令的绝对路径及运行 PATH，因此从浏览器启动时不依赖终端初始化脚本。`missingDependencies` 应为空；如非空，安装相应依赖后重新执行安装命令。

`--browser chrome` 只注册 Chrome 共享目录；Ego Lite 用户使用 `--browser ego`（或默认的 `--browser all`），同时注册 Ego 产品目录和 Chrome 共享目录。提供 Chrome 注册选项不代表已完成 Chrome 实测。Windows/Linux 不提供 native host 安装支持。注册路径、自定义 `--extension-id` / `--manifest-dir` 及 Ego Lite 实测说明见 [本地组件说明](../native/README.md)。

## 2. 导入扩展

每个 [GitHub Release](https://github.com/0xFANGO/fetchy/releases) 都附带预构建的 `fetchy-extension-<版本>.zip`，下载解压后可跳过 `npm run extension:build`，直接加载解压出的 `extension` 文件夹（本地组件仍需从本仓库注册）。

1. 在浏览器打开 `chrome://extensions/`。
2. 打开开发者模式，点击「Load unpacked / 加载已解压的扩展程序」。
3. 选择项目中的 **`dist/extension`**（或 Release 解压出的 `extension` 文件夹）。不要选择项目根目录或源码 `extension` 文件夹。
4. 在扩展菜单中将「Fetchy 视频下载」固定到工具栏。
5. 打开具体视频页，点击 Fetchy 图标。首次连接后显示默认保存目录；没有具体视频时可粘贴链接。

固定扩展 ID 为 `hmgmpigkcmalkhcmjfikpkeabbfbhdoh`，由 manifest 中的公开密钥确定（用于本地来源限制，并非私钥或访问凭据）。

## 3. 下载与目录

识别成功后核对封面、标题和平台，点击「下载视频」。解析不会自动下载。下载期间可以关闭弹窗或切换页面；重新打开会恢复原任务。只有实际文件经过核心校验，才显示「已保存」。点击「在文件夹中显示」会在 Finder 中定位本次输出文件。

默认目录为 `~/Downloads/Fetchy`，按需创建。点击弹窗底部目录旁的「更改」，在系统窗口确认后自动保存，无需再点保存。选择器可能收起弹窗，重开后会显示新目录；取消选择不会改变已保存位置。显示任务期间不可更改目录，可在下一次下载前修改。

校验成功后，成片以清理后的视频标题直接保存到所选目录（同名自动加序号，不覆盖已有文件），并清理临时工作目录。取消会等待执行端停止并清理后再显示「已取消」。当前只保留当前任务和最近结果，没有队列或历史列表。输出编码、校验与命名边界详见 [实现边界](limitations.md)。

## 4. 会话与可用性

| 平台          | 实际执行路径                                                                          | 会话前提                                                      |
| ------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| YouTube / B站 | 本地 yt-dlp + FFmpeg/ffprobe                                                          | 当前默认匿名路径；扩展不导出浏览器 Cookie                     |
| 小红书 / 抖音 | 扩展把提取器注入你浏览器里的视频页，取回目标视频的媒体地址；本地组件从 CDN 下载并校验 | 当前浏览器能正常播放该视频；遇到登录/验证在浏览器里完成后重试 |

识别和下载时扩展各读取一次页面：如果某个标签页正打开这个视频，直接在那个标签页里读取。抖音 `/video/<id>` 页缺少初始详情时，从当前播放器读取匹配 ID 的视频数据。没有可用的目标页时，扩展在后台打开一个不激活的临时标签页（抖音使用 `jingxuan?modal_id=<id>`），读取完成后关闭；校验失败后的自动重试也使用临时页获取新地址。读取只取回目标视频的标题、封面和媒体地址，不读取 Cookie，也不会把其他页面内容传给本地组件。本地组件再次校验媒体身份与 CDN 域名后才会下载。

请在**当前浏览器**完成登录或验证后重试。短链（`v.douyin.com`、`xhslink.com`）会先在后台标签页中展开。

支持单个已完成视频；不支持合集、直播、图文、DRM、批量下载、清晰度选择和去水印，详见 [实现边界](limitations.md)。

## 5. 连接与恢复

- **无法连接本地组件**：确认 `npm run native:install -- --browser chrome`（Ego Lite 为 `--browser ego`）已成功——Chrome 应输出 Chrome 共享注册目录，Ego Lite 应同时输出 Ego 产品目录和 Chrome 共享目录——然后重新打开弹窗并点击「重新连接」。若曾只手动注册 Ego 产品目录，请重新运行安装命令补齐共享目录。
- **缺依赖**：按提示安装 Node、yt-dlp、FFmpeg/ffprobe，再运行注册命令。
- **页面还没有加载出这个视频**：等视频可以播放后再点识别或下载；后台标签页最多等待约 20 秒。
- **任务暂时断开**：先重连，插件会查询稳定任务 ID；不会自动重复发起下载。
- **电脑/本地进程重启**：无法恢复的任务显示中断；没有断点续传。浏览器仍在同一会话时保留原目标以重试；整个浏览器会话结束后，为避免长期保存访问凭据，可能需要重新粘贴原链接。
- **目录或磁盘错误**：重新选择可写目录或释放空间，再重试。不会静默改存其他目录。
- **已保存文件被移走/删除**：定位操作会明确报错，不会将根目录冒充输出文件。

## 6. 更新与卸载

修改扩展后运行 `npm run extension:build`，在扩展管理页点击 Fetchy 的重新加载。重载可能中断解析，但正在执行的下载由独立本地进程管理。移动项目、升级 Node 或修改依赖路径后重新运行 `npm run native:install`。

本地 daemon 已启动时会缓存代码和运行配置。开发更新本地核心/桥接、依赖路径或注册配置后，应先等待或取消当前下载，再重启本地 daemon，下次连接会加载新版；也可关闭浏览器连接，确认无执行中的任务后等待约五分钟由其自行退出。不要在下载过程中强行停止。

卸载扩展可从扩展管理页移除；本地注册文件与运行目录的清理见 [本地组件说明](../native/README.md)。卸载不自动删除用户下载的视频。

## 7. 数据与权限

扩展申请 `activeTab`、`storage`、`nativeMessaging`、`scripting`，以及 `xiaohongshu.com`、`douyin.com`、`iesdouyin.com` 的站点权限。脚本只注入这三个站点的视频页，且只执行仓库内的 `src/page-extract.mjs`；不申请 Cookie 或下载权限。

当前输入、临时封面及任务上下文只在本机内存和 `chrome.storage.session` 中保留；所有页面文本按普通文本渲染。本地组件来源校验、持久化脱敏与进程安全边界见 [本地组件说明](../native/README.md) 和 [SECURITY.md](../SECURITY.md)。

实现参考：[Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)、[Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)、[Action API](https://developer.chrome.com/docs/extensions/reference/api/action)。
