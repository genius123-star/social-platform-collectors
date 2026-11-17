# Instagram 采集 v0.4.2

本平台使用单独的 Chrome 扩展，源码在 [chrome_instagram_probe](chrome_instagram_probe/)。在 `chrome://extensions` 开启开发者模式，选择「加载已解压的扩展程序」，选这个子目录（含 `manifest.json`）。

## 开始采集

从账号主页选择匹配的目标，先用「新建10帖试采」。支持 dailyvideo.kg 和 chinaarabtv，研究窗口为北京时间 2025-10-17 至 2026-10-17（含首尾）。正式采集可从顶部或当前位置开始；要续采请选择原任务并点击「恢复所选任务」。

## 导出与离线处理

可导出账号资料、帖子、评论观察、有 ID 的去重评论、运行报告和原始证据。原始证据可能分段；评论观察可能重复，跳过帖或取不到的字段不算作成功或 0。单帖身份或打开异常记录后跳过。

在本说明所在目录执行：

```text
python import_instagram_probe.py "<文件路径>" --output-dir "<结果目录>"
```

输入：「原始证据（自动分段）」导出的 CSV；同账号的分段可在同一命令中逐个传入。省略 `--output-dir` 时写到本平台的 `outputs/<账号>/`。

## 验证与迁移

运行 `python verify_instagram_probe.py`（需 Node.js）做合成回归。真实数据不随仓库提供。新目录不会自动继承旧断点；有未完成任务时继续使用旧目录。新版目录布局仅经过本地验证，不代表在线覆盖通过。

[返回项目首页](../../README.md)
