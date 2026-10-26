# YouTube / Bilibili 下载机制与样例验证

核查日期：2026-10-24（Asia/Shanghai）。这是平台研究记录；最终功能状态与通用接口验收见主需求文档。本文的 `YB-*` 是本次调研的记录编号，不是 REA Evidence ID。

## 样例结论

| 样例                  | 身份/元数据                                                                      | 传输验证                                                                                                  | 尚未验证                                   |
| --------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| YouTube `EWvNQjAaOHw` | `How I use LLMs`，7872 秒，public；解析到 54 个格式条目                          | 默认 HTTPS 视频/音频返回 403；改选抽取器已经返回的 HLS 视频/音频后，成功生成 5.039 秒、H.264 + AAC 的 MP4 | 其他登录状态和网络环境（整片已在末节补验） |
| B站 `BV19Pnb6REhD`    | `杀戮尖塔2 炸弹+破击狂冲6精英，最后竟然无限了？`，1361.109 秒，cid `42983096665` | 最新引擎匿名解析成功；1080p 视频和音频各读取 64 KiB，均 HTTP 206                                          | 末节补充整片通过；会员清晰度未测           |

不能以“能解析出媒体 URL”替代“成功下载”，也不能以某一版本的失败断言整个平台必须登录。

## 观察记录

### YB-001：版本差异会改变结果

本机原有 yt-dlp 为 `2026.06.29.234344`。使用 `--ignore-config --no-playlist --skip-download`、15 秒网络超时、不重试、无浏览器 Cookie 的条件探测：

- YouTube 元数据成功，默认候选 `401+251`。
- B站 HTTP 412。

从 PyPI 隔离获取当日稳定版 `yt-dlp 2026.10.21` 与 `yt-dlp-ejs 0.8.0`，没有更新全局环境。相同 B站样例变为匿名解析成功，15 个格式条目；默认 `100026+30280`。因此旧版 412 只能记录为该版本、当时会话下的失败。

隔离研究执行器：`/tmp/fetchy-yt-dlp-research-20261024/yt-dlp`。它是临时研究工具，不是项目安装方式。

### YB-002：YouTube 元数据成功，但默认媒体候选失败

新版日志显示获取网页、`tv samsung` / `visionos` player JSON、播放器脚本，并通过本机 Deno 求解 JS challenge，然后获取 m3u8 信息。返回：

```json
{
	"id": "EWvNQjAaOHw",
	"title": "How I use LLMs",
	"duration": 7872,
	"start_time": 4538,
	"availability": "public",
	"format_id": "401+251",
	"resolution": "3840x2160"
}
```

格式 `401` 是无音轨 AV1 视频，格式 `251` 是 Opus 音频。对两者媒体地址分别执行 `Range: bytes=0-65535`，均得到 HTTP 403。没有将签名 URL 或 Cookie 写入报告。

这证明“元数据成功而传输失败”这一状态真实存在；**没有证据可以把这两次 403 唯一归因于 PO Token**。客户端、签名、会话/出口约束都可能相关，具体原因仍未定位。

### YB-003：YouTube HLS 候选可用

同一提取流程已经返回若干 `m3u8_native` 格式，无须假造媒体 URL。对视频格式 `602` 的清单和首个媒体分片探测成功，分别返回 HTTP 200；首个分片读取 13,123 字节。

随后以两条 HLS 轨道验证下载与合并：

```bash
/tmp/fetchy-yt-dlp-research-20261024/yt-dlp \
  --ignore-config --no-playlist --socket-timeout 15 \
  --retries 0 --extractor-retries 0 --no-progress \
  --download-sections '*4538-4543' \
  -f '230+234' --merge-output-format mp4 \
  -o /tmp/fetchy-yt-dlp-research-20261024/probe-youtube.mp4 \
  'https://www.youtube.com/watch?v=EWvNQjAaOHw&t=4538s'
```

退出码 0，文件 112,063 字节；`ffprobe` 确认 H.264 视频 640×360、AAC 音频、容器时长 5.039 秒。这是为限制验证流量选取的 5 秒样本，不等于完整长视频已验收，也不承诺无重编码裁切精确到帧。

### YB-004：B站两条 DASH 资源可传输

新版匿名抽取返回默认格式：

- `100026`：AV1 视频，1920×1080，无音轨。
- `30280`：AAC 音频，无视频轨。

携带提取结果的请求头，对两条 URL 各请求首 64 KiB：

```text
video: HTTP 206, 65536 bytes, Content-Range bytes 0-65535/139067267
audio: HTTP 206, 65536 bytes, Content-Range bytes 0-65535/16536184
```

引擎提示该样例的 `1080P 60帧` 未返回；没有据此尝试访问未授权画质。当前证据只支持已有 1080p 候选可读，不支持“任意清晰度均可下载”。

## 平台机制与接口含义

### YouTube

**上游源码事实：** 播放器响应可能提供组合流、自适应视频/音频以及 HLS 清单；抽取器处理 `signatureCipher`、JS challenge 和格式分类。不能把播放器里的 `blob:` 当作可保存的远程文件地址。[固定版本 YouTube 抽取器](https://github.com/yt-dlp/yt-dlp/blob/2026.10.21/yt_dlp/extractor/youtube/_video.py)

**当前依赖事实：** yt-dlp 的 YouTube 支持使用外部 JS runtime 与匹配版本 EJS；本机实测采用 Deno。组件版本应进入诊断信息和更新策略。[上游 EJS 安装说明](https://github.com/yt-dlp/yt-dlp/wiki/EJS)

**访问约束：** 某些客户端/请求需要 PO Token，且其绑定和有效期会变化；并非每次下载都需要账户 Cookie。应把“需要登录”“令牌/客户端条件不足”“格式传输失败”区分开，禁止把一个 403 自动解释成必须导出所有浏览器 Cookie。[上游 PO Token 说明](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)、[YouTube 抽取器说明](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#youtube)

**设计推论：** 计划中保存多种候选，下载失败后允许有限次选择同一内容的其他已提供候选，例如本次已证明可用的 HLS；不得在尚未成功时宣称下载完成。下载临时 URL 应即时解析、及时使用，失败后重新提取；不把它当永久分享地址。

### Bilibili

**上游源码事实：** 常规视频页的 `__INITIAL_STATE__` 提供视频身份；`bvid + cid` 指定内容和分 P；抽取器通过 WBI 签名的 `x/player/wbi/playurl` 请求获取播放信息，并解析 DASH 视频/音频或 `durl`。请求头包括 Referer，部分调用还包含 Origin。[固定版本 B站抽取器](https://github.com/yt-dlp/yt-dlp/blob/2026.10.21/yt_dlp/extractor/bilibili.py)

**设计推论：** 以 `BV + p/cid` 作为内容身份；清理 `trackid`、`spm_id_from`、`vd_source` 不应改变内容选择，`p` 必须保留。保存视频和音频后合并；错误归因中区分 412、登录要求、地区限制、内容不存在和质量不可用，不能一概返回“链接无效”。

## 对通用下载方法的要求

1. URL 标准化只去除追踪参数；时间定位、分 P 等要先结构化保存。YouTube `t=4538s` 表示 01:15:38 的分享定位，本次提取器返回 `start_time=4538`。产品默认保存整片；只有显式 range 参数触发裁切。
2. `inspect/resolve` 返回内容身份、可选质量、轨道需求和下载候选；`download` 负责传输、合并、验证。两者成功状态独立。
3. 统一结果不能只剩一个 `videoUrl`：至少表达单文件、分离音视频、分段清单，保留每候选所需请求头。
4. 质量选择应考虑容器与编码兼容性；“MP4”不等于“H.264”，B站本例默认就是 MP4 中的 AV1。保留原轨与转码必须是不同策略。
5. 对临时 URL、Cookie、PO Token 做日志脱敏；不要将这些访问凭证作为长期持久化内容标识。
6. 全部格式失效后返回可操作错误；有限候选回退和可更新的解析器版本应是架构能力。平台签名逻辑不宜在插件和本地执行端各自复制维护。
7. 验收要区分：识别 URL、元数据解析、媒体部分读取、完整下载、合并后音视频可解码。本报告只证明表格列出的层级。

格式选择与 FFmpeg 合并的上游行为参见 [yt-dlp format selection](https://github.com/yt-dlp/yt-dlp#format-selection)。

## 可复核的本地源码

隔离包读取路径与 SHA-256：

```text
yt_dlp/extractor/bilibili.py
b99ad995a016b11097cdadfb64bc6da55cd64129b76e7914eafbc7e45685ec33

yt_dlp/extractor/youtube/_video.py
16d82a3c39a41cfa2b42ad9c1ff631f6f6eb2d49f6a8762aeffb9adc1b8681df
```

源码机制、网络观察、设计建议是三类证据。没有运行网页 JavaScript 捕获、没有读取浏览器 Cookie，也没有实施 DRM 解密。B站整片验收和浏览器侧证据由主调查继续记录。

## 最终整片补充（主调查，2026-10-24）

上面的YB证据保留了初期有限探测边界。后续本仓库统一CLI已经完成两个整片闭环：

- YouTube：显式HLS、640×360、VP9/AAC、7871.797秒、202,099,372字节，ffprobe通过；未额外逐帧全片解码。
- B站：640×360、AV1/AAC、1361.109秒、46,845,477字节；ffprobe和额外完整解码均通过。

YouTube链接`t=4538s`未截断源视频，结果保留startTimeSeconds=4538。所选低清规格用于端到端验证，不代表平台最高质量。具体文件、重现方法和集成修复见 [实测记录](validation.md)。

## 默认 MP4 输出补充（2026-10-24）

第二轮 `eA9Zf2-qYYM` 与 `BV1TeJ96EE5t` 分别下载到 1080p VP9/Opus、1080p AV1/AAC。首版显式设置 `--merge-output-format mkv`，所以最终文件为 MKV；这属于本项目的输出策略，并非两个平台要求下载为 MKV。容器与编码需分别判断，MP4 也可能承载 AV1 等编码。

当前 yt-dlp 下载路径优先原生 H.264 视频与 AAC 音频；若音频编码未知或不兼容，优先保留 H.264 视频再检查音频；没有合适 H.264 候选时才退回其他源。内部允许 MKV 中间文件，最终通过 `src/mp4.mjs` 复用、重封装或必要转码，并用 ffprobe 确认 MP4/H.264/yuv420p/AAC 后报告成功。编码优先级可能牺牲其他编码提供的更高分辨率；转码耗时、有损且文件可能变大，因此结果明确报告实际规格与 `conversion`。

第二轮两个长文件已用该转换模块生成兼容 MP4；新选择器也完成真实平台解析和离线合成媒体执行链验证，但未用修改后的默认策略重新下载两条整片。详细尺寸、时长、字节数与验证边界见 [第二轮实测](validation.md#第二轮真实下载与-mp4-转换)。
