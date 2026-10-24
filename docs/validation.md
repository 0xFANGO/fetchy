# 实测与验证记录

日期：2026-10-24（Asia/Shanghai）。这是四条给定样例的验证记录，不是平台全量兼容性承诺。

## 环境

- macOS；Node 24.18.0；Python 3.14；项目虚拟环境 yt-dlp 2026.10.21 + yt-dlp-ejs 0.8.0；FFmpeg/ffprobe 8.0.1。
- 旧全局 yt-dlp 2026.06.29.234344 未更新。旧版对 B站 HTTP 412，新版同样例成功，说明依赖版本属于重现条件。
- 浏览器：Ego Browser 2.1.0，用户已有会话。只读取所选视频必要状态，没有导出 Cookie、认证 token 或全站存储。
- 下载文件仅保存在 Git 忽略的 `.local/validation/`。签名媒体地址没有写入研究文档。

## 真实文件

| 平台/内容ID | 路径（相对仓库） | 实际规格与大小 | 验证 |
| --- | --- | --- | --- |
| 小红书 `6adb92b90000000031037a66` | `.local/validation/video-pmooE1/media.mp4` | 720×1404，H.264 + AAC，146.7秒，19,875,696字节 | 统一API整片；ffprobe通过；额外完整解码通过 |
| 抖音 `7695202760953793827` | `.local/validation/video-uxQF5w/media.mp4` | 576×1024，H.264 + AAC，2082.066667秒，173,315,309字节 | 统一API整片；ffprobe通过；额外完整解码通过 |
| B站 `BV19Pnb6REhD` | `.local/validation/video-bPqlGQ/media.mkv` | 640×360，AV1 + AAC，1361.109秒，46,845,477字节 | 统一CLI两轨下载并合并；ffprobe通过；额外完整解码通过 |
| YouTube `EWvNQjAaOHw` | `.local/validation/video-tx2hYv/media.mkv` | 640×360，VP9 + AAC，7871.797秒，202,099,372字节 | 统一CLI完整HLS两轨下载并合并；ffprobe通过，未额外逐帧解码 |

额外完整解码命令为 `ffmpeg -nostdin -v error -xerror -i <文件> -f null -`，小红书、抖音和B站三条均退出 0。YouTube长视频完成ffprobe结构/轨道/时长校验，没有额外逐帧解码。API 默认仅做 ffprobe 结构验证，所以仍返回 `validation.fullDecode: false`；额外实测不能变成所有未来下载的默认能力声明。

## 重现方法

```bash
# 首先按 README 安装项目虚拟环境
node bin/fango-download.mjs download 'https://www.bilibili.com/video/BV19Pnb6REhD/' --max-height 360 --output .local/validation --timeout-ms 240000
node bin/fango-download.mjs download 'https://www.douyin.com/jingxuan?modal_id=7695202760953793827' --max-height 1024 --output .local/validation --timeout-ms 240000
node bin/fango-download.mjs download '<小红书完整分享链接>' --output .local/validation --timeout-ms 240000
node bin/fango-download.mjs download 'https://www.youtube.com/watch?v=EWvNQjAaOHw&t=4538s' --max-height 360 --transport hls --output .local/validation --timeout-ms 480000
```

小红书、抖音本轮通过 Node API 调用，使用开发选项 `browserSpaceId` 复用了同一个研究空间；CLI 与 API 使用相同下载函数。研究空间已关闭。新任务默认建立自己的空间，成功后关闭；常规调用不需要指定该编号。

下载质量上限是为了有限验证，不表示最高可下载规格。B站1080p的解析/部分读取已成功，整片验收选择360高；抖音1080×1920候选已解析，整片验收选择1024高。没有承诺无水印，也没有修改源视频水印。

## 发现与保留边界

1. **YouTube**：普通HTTPS候选会403；同次解析给出的HLS可传输。先验证5秒片段，再通过统一CLI完成7871.797秒整片合并；代码提供一次HLS回退，整片实测显式选择HLS。长视频默认整片，链接`t=4538s`不会自动截断。片段级并发限制为8。
2. **小红书**：初次浏览器观察到984×1920的EF5流，但后续导航只提供720×1404的EF4。一次中间下载未通过媒体验证并被清理，未保留足够数据把故障归因到某一编码。最终文件只证明720×1404路径；不能宣称984×1920已验证。EF4经真实文件确认是H.264；EF5标签保持未知。
3. **抖音**：匿名yt-dlp提示需要fresh cookies，不足以推断必须登录或必须验证码。浏览器`/video/<id>`页面可播放，但本轮RENDER_DATA不含目标详情；`jingxuan?modal_id=<id>`提供匹配ID的app.videoDetail。因此两个引擎使用不同入口，统一身份不变。带独立音轨标记的候选排除，合流最终必须检出音频。
4. **文件成功条件**：不能仅以元数据、HTTP200或进程退出0判成功。当前执行器检查任务内文件、非空、视频轨、预期音频及容器时长；部分失败会清理独立任务目录。
5. **取消**：本轮取消了一个使用顺序片段下载的YouTube长任务，CLI返回cancelled，并清理其未完成目录；随后以有界并发重新测试。浏览器端已经触发的动作不保证随本地进程撤销。

## REA 证据范围

使用用户指定的 `reverse-engineer-anything` 工作流。浏览器活动由 Ego 实际执行；REA 对导出的脱敏HAR作离线检查，没有声称REA点击、导航或读取Cookie。

- 本地保留文件：`.local/evidence/xiaohongshu-network.har`。
- SHA-256：`b7111aabfb9f1f2504b33993a3f284fdded1dc757acbb42968eeac649b8cc078`。
- Evidence ID：`ev_4b2baa75bffc7197dea046e35197eab7b628e4f2ad02e04ebf82490bcd60e174`。
- 记录含1个媒体响应：HTTP206、Content-Range `bytes 0-262143/10167052`，CDN `sns-video-v2.xhscdn.com`。
- HAR由响应元数据生成，查询参数、Cookie和请求头未保留；无响应体、真实传输耗时和运行时事务归因。它证明文件中的保留字段，不独立证明部署身份或完整下载。

## 离线测试

运行 `npm test`。测试使用合成快照和独立假可执行文件，不访问实际平台或登录会话。覆盖URL归一化、身份错配、质量与编码选择、媒体域、签名脱敏、分离流过滤、缺依赖、无最终文件、缺音轨、明显短时长、路径逃逸、取消/超时、输出上限、Cookie临时副本、HLS回退及CLI入口。

最终 `npm test`：43项通过，0失败、0跳过；耗时约15.3秒。未覆盖的真实场景包括：更多视频、短链真实重定向、B站真实分P、失效/付费/地区受限内容、Windows/Linux浏览器流程和插件UI。

真实长视频集成曾暴露 yt-dlp 输出模板的可选字段问题：缺少 `_old_archive_ids` 时逐字段模板产生裸 `NA`，无法解析JSON，任务因此被正确判失败并清理。已改用整对象JSON投影，并加入调用本地真实yt-dlp模板渲染器的离线回归；修复后整片闭环已通过。缺少本地yt-dlp的环境会明确跳过这一集成测试。
