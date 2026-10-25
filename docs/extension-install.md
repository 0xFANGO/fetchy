# Fango 扩展安装与使用

版本：0.2.0。首版实现环境为 macOS + Chromium Manifest V3；本次面向 Ego Lite。真实验收进度见 [扩展验证记录](extension-validation.md)，不能将离线测试等同于四个平台真实下载均通过。

## 1. 安装依赖与构建

需要 Node.js 22+、Python 3.10+、FFmpeg（含 ffprobe）。小红书/抖音使用已经安装并运行的 Ego Lite，命令 `ego-browser` 必须可用。

在项目根目录运行：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm test
npm run extension:build
npm run native:install -- --browser ego
```

随时可以运行 `npm run doctor` 查看哪些工具已找到、哪些缺失以及对应的安装提示。Node 运行时没有额外 npm 依赖，`npm install` 只安装格式化与 lint 工具。安装脚本记录当前 Node、yt-dlp、FFmpeg 和 Ego 命令的绝对路径及运行 PATH，因此从浏览器启动时不依赖终端初始化脚本。`missingDependencies` 应为空；如非空，安装相应依赖后重新执行安装命令。

`--browser ego` 会同时注册 Ego 产品目录和 Chrome 共享目录，兼容本次实测的 Ego Lite 查找路径。Chrome 可使用 `--browser chrome` 只注册共享目录；`--browser all` 同样注册两处。提供 Chrome 注册选项不代表已完成 Chrome 实测。Windows/Linux 不提供首版安装支持。

## 2. 导入扩展

1. 在 Ego Lite 打开 `chrome://extensions/`。
2. 打开开发者模式，点击「Load unpacked / 加载已解压的扩展程序」。
3. 选择项目中的 **`dist/extension`** 文件夹。不要选择项目根目录或源码 `extension` 文件夹。
4. 在扩展菜单中将「Fango 视频下载」固定到工具栏。
5. 打开具体视频页，点击 Fango 图标。首次连接后显示默认保存目录；没有具体视频时可粘贴链接。

固定扩展 ID 为 `hmgmpigkcmalkhcmjfikpkeabbfbhdoh`，由 manifest 中的公开密钥确定。它用于本地来源限制，并非私钥或访问凭据。自定义扩展 ID 时须用 `--extension-id <实际ID>` 重新注册 host。

使用 `--browser ego` 后，本机 host 注册文件写入以下两处：

```text
~/Library/Application Support/Citro Labs/ego lite/NativeMessagingHosts/com.fango.video_downloader.json
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.fango.video_downloader.json
```

2026-10-25 在 macOS + Ego Lite 0.6.0.20 中实测：只写入 Ego 产品目录时，插件报告找不到本地组件；补充 Chrome 共享目录后成功连接。因此安装 Ego 版本时也应保留共享目录中的 Fango 注册文件。这只注册 Fango 的 host，不修改其他扩展或浏览器资料。

其他 Chromium 衍生浏览器可能使用不同注册目录，可显式传入 `--manifest-dir <绝对目录>`。该参数会替换默认目录列表，只在指定目录注册；不能据此声称其他浏览器已验证。

## 3. 下载与目录

识别成功后核对封面、标题和平台，点击「下载视频」。解析不会自动下载。下载期间可以关闭弹窗、打开设置或切换页面；重新打开会恢复原任务。只有实际文件经过核心校验，才显示「已保存」。点击「在文件夹中显示」会在 Finder 中定位本次输出文件。

默认目录为 `~/Downloads/Fango`，按需创建。设置中点击「选择文件夹」，在系统窗口选择后，回到插件点击「保存」。选择器可能收起弹窗，重开后仍会保留待保存目录。取消选择不会改变已保存位置。下载中修改目录只影响下一次任务。

每次下载在独立 `video-*` 子目录写入文件。校验成功后，成片命名为 `视频标题.mp4`，保留中文并清理非法字符、截短过长标题，缺少可用标题时以内容 ID 等信息兜底；同目录重名自动加序号，不覆盖用户已有文件。完成界面与 Finder 定位使用命名后的实际路径。取消会等待执行端停止并清理后再显示「已取消」。当前只保留当前任务和最近结果，没有队列或历史列表。

## 4. 会话与可用性

| 平台          | 实际执行路径                                         | 会话前提                                                                     |
| ------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| YouTube / B站 | 本地 yt-dlp + FFmpeg/ffprobe                         | 当前默认匿名路径；扩展不导出浏览器 Cookie                                    |
| 小红书 / 抖音 | Ego Browser 引擎在新任务空间打开目标页并提取匹配视频 | Ego Lite 已运行，核心实际打开的页面能够访问目标；遇到登录/验证须在该页面处理 |

插件传入的是具体目标 URL。核心在识别时和下载重新解析时分别创建任务空间，使用 `ego-browser` 的默认浏览器上下文，未显式指定 profile。插件不会把当前标签页、profile 或 Cookie 传给核心；即使插件安装在 Ego Lite，也不能假定核心任务页面与当前标签页拥有完全相同的登录状态。Chrome 的登录态同样不能直接用于 Ego 路径。

正常解析完成后，核心关闭本次任务页面；发生需要处理的页面错误时会保留可接管的 Ego 页面。请在**本地组件实际打开的目标视频页面**完成登录或验证，再返回插件重试。仅在其他窗口或 profile 登录可能不起作用。无需填写空间编号，也不会自动绕过验证。

支持单个已完成视频；不支持合集、直播、图文、DRM、批量下载、清晰度选择和去水印。原有核心输出格式边界保持不变，详见 [实现边界](limitations.md)。

## 5. 连接与恢复

- **无法连接本地组件**：确认 `native:install -- --browser ego` 已成功，安装输出包含上述两个注册目录，重新打开弹窗并点击「重新连接」。若曾只手动注册 Ego 产品目录，请重新运行安装命令补齐共享目录。
- **缺依赖**：按提示安装 Node、yt-dlp、FFmpeg/ffprobe 或 Ego，再运行注册命令。
- **任务暂时断开**：先重连，插件会查询稳定任务 ID；不会自动重复发起下载。
- **电脑/本地进程重启**：无法恢复的任务显示中断；没有断点续传。浏览器仍在同一会话时保留原目标以重试；整个浏览器会话结束后，为避免长期保存访问凭据，可能需要重新粘贴原链接。
- **目录或磁盘错误**：重新选择可写目录或释放空间，再重试。不会静默改存其他目录。
- **已保存文件被移走/删除**：定位操作会明确报错，不会将根目录冒充输出文件。

## 6. 更新与卸载

修改扩展后运行 `npm run extension:build`，在扩展管理页点击 Fango 的重新加载。重载可能中断解析，但正在执行的下载由独立本地进程管理。移动项目、升级 Node 或修改依赖路径后重新运行 `native:install`。

本地 daemon 已启动时会缓存代码和运行配置。开发更新本地核心/桥接、依赖路径或注册配置后，应先等待或取消当前下载，再重启本地 daemon，下次连接会加载新版。也可关闭浏览器连接，确认无执行中的任务后等待约五分钟，daemon 会自行退出；随后重新打开浏览器和插件。具体位置和生命周期见 [native/README](../native/README.md)。不要在下载过程中强行停止。

卸载扩展可从扩展管理页移除；本地注册文件与 `~/Library/Application Support/FangoVideoDownloader` 需另行按 [本地组件说明](../native/README.md) 清理。卸载不自动删除用户下载的视频。

## 7. 数据与权限

扩展只申请 `activeTab`、`storage`、`nativeMessaging`。不注入任意网页脚本，不申请全站 Cookie 或下载权限。当前输入、临时封面及任务上下文只在本机内存和 `chrome.storage.session` 中保留；目录和脱敏任务结果写入权限受限的本地状态文件。原始分享输入、token、签名媒体 URL 和原始标题字段不写入持久任务记录；成功文件路径包含清理后的标题文件名。命名时也去除标题中嵌入的 URL 与可识别的访问凭据赋值。

host 仅允许注册的扩展来源。文件定位只能操作记录中的成功输出；目录保存只能使用当前/默认/系统选择器选中的路径。所有页面文本按普通文本渲染，执行进程使用参数数组，不将 URL 或标题拼成 shell 命令。

实现参考：[Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)、[Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)、[Action API](https://developer.chrome.com/docs/extensions/reference/api/action)。
