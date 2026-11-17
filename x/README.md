# X 采集 v0.6.5

本平台使用单独的 Chrome 扩展，源码在 [chrome_x_probe](chrome_x_probe/)。在 `chrome://extensions` 开启开发者模式，选择「加载已解压的扩展程序」，选这个子目录（含 `manifest.json`）。

## 开始采集

打开目标主页，填写账号、主体及北京时间研究期。先做3条或10条试采，再按需要正式采集或从已保存批次恢复。

## 导出与离线处理

可导出中文数据 CSV、运行报告、原始记录和断点。可选择日期段补采；仍需核查缺失字段和长列表覆盖。

在本说明所在目录执行：

```text
python import_x_export.py "<文件路径>" --output-dir "<结果目录>"
```

离线导入器读取 `x_public_sample_v1` JSON 或带完整元数据的 Twitter Web Exporter JSON 数组；导入后者必须提供 `--account` 和带时区的实际采集时间 `--observed-at`。导入按北京时间 2025-10-17 至 2026-10-17 标记区间。当前扩展的断点 JSON 用于扩展内恢复，分析请用直接导出的 CSV。省略 `--output-dir` 时写到本平台的 `outputs/`。

## 验证与迁移

第三方许可及署名见 `chrome_x_probe/THIRD_PARTY_NOTICES.md`。 新目录不会自动继承旧断点；有未完成任务时继续使用旧目录。新版目录布局仅经过本地验证，不代表在线覆盖通过。

[返回项目首页](../../README.md)
