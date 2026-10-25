# Fango 本地组件（macOS）

扩展通过 Native Messaging 连接 `com.fango.video_downloader`，本地组件使用仓库现有 Node API 下载。当前实现支持 macOS；Ego Lite 与 Chrome 的安装目录已提供，其他浏览器和操作系统未验证。

## 安装

先按照项目 README 安装 Node.js 22+、项目 `.venv` 中的 yt-dlp、FFmpeg/ffprobe。然后在仓库根目录运行：

```sh
npm run extension:build
node native/install.mjs --browser chrome
```

在浏览器的 `chrome://extensions` 中启用开发者模式，加载仓库 `dist/extension` 文件夹。源 manifest 中的公共 key 固定扩展 ID；安装程序按该 key 自动计算允许来源，不需要手动填写。自定义构建可用 `--extension-id <32位扩展ID>`。

Ego Lite 使用 `--browser ego`；同时注册使用 `--browser all`。`--browser ego` 同时写入 Ego 产品目录和 Chrome 共享目录，以兼容实际 Ego 本地组件查找路径。如果某个 Chromium 浏览器使用不同的本地组件目录，可用 `--manifest-dir <绝对路径>` 明确注册。脚本仅注册 Fango 的 manifest，不修改其他扩展或浏览器资料。

安装程序将启动器和私有运行配置写入：

```text
~/Library/Application Support/FangoVideoDownloader/
```

启动器固定本次 Node 可执行文件和仓库绝对路径；运行配置记录已找到的工具路径与安装时的 PATH。移动仓库、升级 Node 后删除原版本目录或调整工具路径时，应重新执行安装脚本。安装过程中显示缺失依赖时，需要安装后重新运行脚本。

Ego Lite 的注册文件位于 `~/Library/Application Support/Citro Labs/ego lite/NativeMessagingHosts/com.fango.video_downloader.json`，Chrome 共享目录位于 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.fango.video_downloader.json`。2026-10-25 在 macOS 的 Ego Lite 0.6.0.20 中实测：只注册产品目录时插件报告“Specified native messaging host not found”，补充 Chrome 共享目录后真实插件成功连接；所以 `--browser ego` 默认注册两处。默认目录为 `~/Downloads/Fango`，首次下载时创建；自选目录必须已存在并且可写。

## 下载生命周期

`host.mjs` 负责 Native Messaging 帧与扩展来源检查，连接一个独立的 `daemon.mjs` 进程。daemon 使用私有 Unix socket，持有唯一下载任务；关闭弹窗、扩展后台重建或断开本地端口均不会取消任务。重新连接后使用同一任务 ID 查询；重复启动同一 ID 不会重复下载。每个新任务固定当时的保存目录。

daemon 持久化目录配置、待保存的目录选择、最近任务的安全结果和已经处理过的任务 ID。原始分享文案、访问参数、封面 URL、完整页面状态及媒体签名 URL不进入该持久文件。任务输入与原始展示标题只保留在 daemon 内存；成功结果的文件路径包含清理后的标题文件名，文件命名会去除嵌入的 URL 和可识别的凭据赋值。浏览器连接全部关闭且没有执行中的下载、解析或目录选择时，daemon 在空闲约五分钟后退出，释放内存中的会话数据。daemon 退出或崩溃后原始输入需由扩展当前浏览器会话恢复，或者重新粘贴。重启时发现未完成任务会明确标为“已中断”。

系统目录选择器关闭后，结果保存在 daemon 中；即使选择过程中弹窗收起，重开也可以继续保存。取消目录选择不改变已有目录或待保存选择。确认取消下载前，daemon 等待下载核心返回，确保其清理步骤已完成。

下载成功必须同时满足核心返回有效视频校验和正时长、实际文件存在、文件大小匹配、真实文件路径在本次目标目录之内。只有已完成任务记录中的文件可以通过 Finder 定位。

## 消息协议

请求：`{id, method, params}`。成功响应：`{id, ok: true, result}`；失败响应：`{id, ok: false, error: {code, message}}`。错误消息为固定中文映射，不转发工具原始输出。事件：`{event: "state", state}`。

`state` 包含 `{task, settings: {outputDir}, pendingDirectory, choosingDirectory}`。任务状态包括 `running`、`cancelling`、`completed`、`cancelled`、`failed`、`interrupted`。

| 方法              | 参数                                     | 结果                                              |
| ----------------- | ---------------------------------------- | ------------------------------------------------- |
| `hello`           | 无                                       | `{version, protocolVersion, dependencies, state}` |
| `getState`        | 无                                       | 当前完整 state                                    |
| `resolve`         | `{input, requestId, pageMedia?}`         | 经过筛选的视频元数据                              |
| `cancelResolve`   | `{requestId}`                            | 取消指定解析请求                                  |
| `start`           | `{input, taskId, metadata?, pageMedia?}` | 接受后的完整 state，任务随后发事件                |
| `cancel`          | `{taskId}`                               | 当前完整 state，确认停止后再发终态                |
| `getSettings`     | 无                                       | `{outputDir}`                                     |
| `chooseDirectory` | 无                                       | 选择器关闭后的完整 state                          |
| `saveSettings`    | `{outputDir}`                            | 校验并保存后的完整 state                          |
| `reveal`          | `{taskId}`                               | `{revealed: true}`                                |
| `acknowledge`     | `{taskId}`                               | 将任务结果标为已查看后的完整 state                |

首次连接会立即发送 state 事件。解析、下载启动、目录选择均在本地执行，不因 popup 端口断开而中止。`saveSettings` 只接受已有目录、默认目录或本次系统选择器选中的目录。

## 会话条件与测试范围

小红书与抖音的媒体信息由扩展在浏览器页面里提取，经 `resolve` / `start` 的 `pageMedia` 参数传入本地组件；本地组件只在内存中保留它，并由核心重新校验身份和 CDN 域名后下载。它不读取 Cookie，也不会写入持久状态文件。

运行 `node --test test/native.test.mjs` 验证消息分帧、来源拒绝、真实 host 重连、单任务去重、取消确认、目录冻结与持久化、错误脱敏、结果路径约束和 daemon 重启中断标记。测试中下载媒体由桩替代；它不等同于真实平台或插件端到端验收。

卸载时删除对应浏览器下的 `com.fango.video_downloader.json` 和上述 Fango 私有运行目录即可；先等待任务结束。已保存视频位于下载目录，卸载本地组件不应删除这些视频。
