# TikTok 采集 v0.6.5

本平台使用单独的 Chrome 扩展，源码在 [chrome_tiktok_probe](chrome_tiktok_probe/)。在 `chrome://extensions` 开启开发者模式，选择「加载已解压的扩展程序」，选这个子目录（含 `manifest.json`）。

## 开始采集

打开作者主页，填目标账号、主体和北京时间研究期。先做3条或10条试采，正式运行可设本轮时限。恢复时选择已保存批次。

## 导出与离线处理

可导出中文数据 CSV、运行报告和原始记录／断点备份。页面正常加载时才有相应公开视频字段；候选版的真实长列表覆盖仍需核查。

在本说明所在目录执行：

```text
python import_tiktok_probe.py "<文件路径>" --output-dir "<结果目录>"
```

离线导入器读取旧版 `tiktok_page_probe_v1`：带 `payload` 列的 CSV 或快照 JSON 数组，按北京时间 2025-10-17 至 2026-10-17 标记区间。当前版本的「原始记录与断点备份」JSON 用于扩展内恢复，分析请直接用「导出中文数据CSV」。省略 `--output-dir` 时写到本平台的 `outputs/tiktok/<语种>/<账号键>/`。

## 验证与迁移

第三方许可及署名见 `chrome_tiktok_probe/THIRD_PARTY_NOTICES.md`。 新目录不会自动继承旧断点；有未完成任务时继续使用旧目录。新版目录布局仅经过本地验证，不代表在线覆盖通过。

[返回项目首页](../../README.md)
