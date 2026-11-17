# 复用代码与修改

视频字段映射和两种公开页面JSON结构的读取，改编自 [dfreelon/pyktok](https://github.com/dfreelon/pyktok) 的 `src/pyktok/pyktok.py`（`generate_data_row`、`get_tiktok_json`、`alt_get_tiktok_json`），BSD-3-Clause，Copyright (c) 2022, Deen Freelon。许可证全文见 `PYKTOK_LICENSE.txt`。

评论容器选择与页面评论提取思路，改编自 [cubernetes/TikTokCommentScraper](https://github.com/cubernetes/TikTokCommentScraper) 的 `src/ScrapeTikTokComments.js`，MIT，Copyright (c) 2021 cubernetes。许可证全文见 `COMMENT_SCRAPER_LICENSE.txt`。

本仓库保留适配代码和原始许可；上游完整源码见上方各自的仓库。

适配修改：删除Cookie读取、媒体下载、内部接口和剪贴板依赖；不猜年份、不用自增序号冒充平台评论ID；仅保存已加载评论；先核对视频ID和作者；明确UTC/北京时间；空值与0分开；补收藏、来源和精度状态。每个视频使用一组statsV2或stats，不混取最大值。
