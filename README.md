# Fango Video Downloader

输入 YouTube、小红书、抖音或 B 站视频链接，使用同一个方法解析并下载到本地。

**当前状态：本地下载核心 MVP。** 已提供 Node API、CLI 和平台适配，已完成真实样例的整片下载及音视频验证。浏览器插件 UI 尚未开发。支持范围以 [实测记录](docs/validation.md) 为准；平台页面、会话和解析器版本变化都可能影响结果。

- [下载核心需求](docs/requirements.md)：核心范围、统一契约、错误与验收。
- [插件首版界面与集成需求](docs/extension-ui-requirements.md)：已确认的弹窗交互、目录设置、后台任务、本地组件接入及实现验收；供后续 Agent 开发。
- [YouTube / B站调研](docs/research-youtube-bilibili.md)
- [小红书 / 抖音调研](docs/research-xiaohongshu-douyin.md)

## 安装

本机需要 Node.js 22+、Python 3.10+、FFmpeg（含 ffprobe）。浏览器引擎另需已经可用的 Ego Browser；初版浏览器集成在 macOS 上验证，其他系统待测。

在项目目录执行：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm test
```

Windows 的虚拟环境可执行文件位于 `.venv\Scripts\`。代码优先使用项目 `.venv` 内的 yt-dlp；没有时使用 PATH 中的 `yt-dlp`。本次固定验证版本为 `2026.10.21`，没有修改全局下载器。

Node 代码没有额外 npm 依赖。FFmpeg、Ego Browser 需自行配置到 PATH；可用 API 选项覆盖可执行文件路径。

## 命令行

```bash
# 只解析规格，不下载媒体
node bin/fango-download.mjs resolve 'https://www.youtube.com/watch?v=EWvNQjAaOHw&t=4538s'

# 下载：自动识别平台，必要时合并音视频
node bin/fango-download.mjs download 'https://www.bilibili.com/video/BV19Pnb6REhD/' --output ./downloads
node bin/fango-download.mjs download 'https://www.douyin.com/jingxuan?modal_id=7695202760953793827'

# 抖音分享短链：支持跳转到 iesdouyin.com/share/video/<id>
node bin/fango-download.mjs download 'https://v.douyin.com/vcqxnm6nUmw/'

# 小红书使用完整分享链接，保留 xsec_token；也可粘贴含单个链接的分享文案
node bin/fango-download.mjs download '<小红书完整分享链接>'

# 显式选 HLS，并限制实际帧高度
node bin/fango-download.mjs download 'https://youtu.be/EWvNQjAaOHw' --transport hls --max-height 360
node bin/fango-download.mjs --help
```

成功结果以 JSON 输出，包含本地绝对路径、文件大小和验证结果。阶段信息写入 stderr。Ctrl+C 取消；失败不留下伪装成成片的文件。每次成功文件位于独立 `video-*` 目录，避免重名覆盖。

`--max-height` 是实际帧高度，例如 1080×1920 竖屏高度为 1920。分享链接的 `t=4538s` 只记录播放定位，默认仍下载整片。首版没有自动裁切。

## 通用方法

```js
import { resolveVideo, downloadVideo } from './src/index.mjs';

const url = 'https://www.bilibili.com/video/BV19Pnb6REhD/';
const abortController = new AbortController();
const info = await resolveVideo(url);
const result = await downloadVideo(url, {
  outputDir: './downloads',
  engine: 'auto',
  maxHeight: 1080,
  timeoutMs: 30 * 60_000,
  signal: abortController.signal,
  onProgress: ({ stage }) => console.log(stage),
});
console.log(result.filepath, result.validation);
```

`resolveVideo` 返回可展示的规格，不公开签名媒体 URL。`downloadVideo` 接受原始链接并重新解析，避免使用过期地址。失败抛出带 `code` 的错误；也导出 `resolve` / `download` 别名。

| 平台 | auto 路由 | 当前机制 |
| --- | --- | --- |
| YouTube | yt-dlp | 优先原生 H.264/AAC，最终输出兼容 MP4；网络错误时有限尝试 HLS |
| B站 | yt-dlp | 保留分 P，解析 DASH 音视频并输出兼容 MP4 |
| 小红书 | browser | 读取目标笔记候选与镜像；缺少 Ego 可退到 yt-dlp，规格可能减少 |
| 抖音 | browser | 分享短链、精选 modal_id 与详情页映射到同一视频，读取页面合流候选 |

`--engine yt-dlp` 可显式使用匿名解析路径，`--engine browser` 当前只支持小红书/抖音。浏览器路径使用 Ego 当前会话，不导出 Cookie，遇到登录/验证状态需在浏览器处理。浏览器页面错误会保留可接管空间；取消和超时能停止本地传输，但不承诺已撤销浏览器端动作。

高级 API 配置包括 `ytDlpPath`、`ffprobePath`、`ffmpegLocation`、`egoBrowserPath`。`cookiesFile` / `--cookies-file` 仅用于显式指定的 yt-dlp 引擎，使用临时私有副本，不回写原文件。浏览器可设 `maxBytes`（默认 4 GiB）；`browserSpaceId` 只用于开发时复用当前任务空间。

## 实现边界

- 当前只处理单个已完成的视频；合集、直播、图文、DRM、精确裁切不在首版。
- 选择的是本次实际解析到的规格，不能承诺“全站最高画质”或“无水印”。浏览器引擎同规格偏好 H.264 兼容性，不按跨编码码率硬排画质；yt-dlp 下载先选择兼容编码组，再在组内使用自身格式排序。
- 小红书不同加载状态可返回不同编码/清晰度；抖音浏览器首版排除有独立音轨标记的候选。
- yt-dlp 引擎（默认用于 YouTube/B站）最终交付 MP4，校验 H.264、yuv420p 和 AAC 音频。优先获取原生兼容流；缺少时下载可用源并转码，不只是修改后缀。原生兼容流的最高规格可能低于其他编码，实际规格以结果为准。
- 必要转码使用 FFmpeg，可能增加耗时和文件大小，也可能损失画质；下载结果的 `conversion` 用 `copy` / `remux` / `transcode` 区分直接使用、无损重封装与重新编码。浏览器引擎的小红书/抖音仍保留源 MP4 编码，例如 HEVC，不承诺 H.264 输出。
- 默认用 ffprobe 检查视频、预期音频和时长；`fullDecode: false` 明确表示未逐帧完整解码。
- 签名媒体地址只用于当前任务。Cookie、访问 token 和原始页面状态不写入公开日志/版本库。

## 代码结构

```text
src/urls.mjs          链接与内容身份归一化
src/page-extract.mjs  可独立放入页面执行的窄范围提取器
src/yt-dlp.mjs        通用解析、传输及 FFmpeg 合并后端
src/mp4.mjs           MP4 兼容性检查、重封装与必要转码
src/browser.mjs       浏览器生命周期、合流下载与验证
src/process.mjs       有界、可取消的子进程
src/index.mjs         统一 API、引擎路由与有限回退
bin/                 CLI
test/                离线契约与故障测试
docs/                需求、研究与实测记录
```

当前 `npm test` 共 60 项测试通过，覆盖抖音短链重定向和真实 FFmpeg 的 MP4 重封装/转码；不访问真实平台、不启动真实浏览器。两轮真实样例及验证范围另见 [实测记录](docs/validation.md)，其中第二轮 YouTube/B站的兼容 MP4 由已下载文件转换得到，不能当作修改后再次完整下载的证据。

后续插件复用这个接口；已确认的首版方案采用扩展 + Native Messaging 本地组件，具体交互、集成缺口与验收见[插件首版需求](docs/extension-ui-requirements.md)。当前仅完成需求整理，尚未添加插件 manifest 或 UI。

## 许可证

本项目采用 **PolyForm Noncommercial License 1.0.0**，完整条款见 [LICENSE](LICENSE)，版权声明见 [NOTICE](NOTICE)。SPDX 标识为 `PolyForm-Noncommercial-1.0.0`。

项目计划免费公开源码，采用限制商用的源码可用许可（source-available）。由于限制商业用途，它不符合 [OSI 开源定义](https://opensource.org/osd)；不将其宣传为允许自由商用的开源项目。

以下是便于理解的说明，不修改或替代 LICENSE 中的英文条款：

- 允许无预期商业应用的个人学习、研究、娱乐和兴趣项目，以及其他非商业用途。
- 允许为许可目的修改代码、制作衍生作品并分享副本；分发时须提供许可条款或其链接，并保留 NOTICE 中的 `Required Notice:` 声明。
- 商业用途不在一般非商业授权范围内，例如将插件用于收费下载服务，或集成到商业产品中。本项目没有额外授予商业使用许可。
- 原文对慈善组织、教育机构、公共研究等指定机构另有允许用途条款，且不以资金来源为限制；这些范围须按 LICENSE 判断。
- 许可证保留法定合理使用权。收费教程、带广告的视频等具体场景，不能只凭是否产生收入判定，也不能承诺通过本许可禁止一切涉及本项目的获利行为。

LICENSE 原样采用 [PolyForm 官方文本](https://github.com/polyformproject/polyform-licenses/blob/76a278c402bc43b8d2b561da140b0f3e17263015/PolyForm-Noncommercial-1.0.0.md)。第三方依赖或材料如有独立许可证，仍须遵守各自条款。代码许可也不授予视频内容的使用权；实际支持平台和下载方式确定后，仍需核对相应平台规则与内容授权范围。

## 需求来源

- [fango-media #147：和 AI 做一个视频下载浏览器插件](https://github.com/0xFANGO/fango-media/issues/147)

本 README 整理该 Issue 中与插件有关的需求。后续根据实现、测试与用户反馈更新，功能支持以插件实际验证结果为准。
