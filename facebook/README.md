# Facebook 采集 v0.6.9

本平台使用单独的 Chrome 扩展，源码在 [chrome_facebook_probe](chrome_facebook_probe/)。在 `chrome://extensions` 开启开发者模式，选择「加载已解压的扩展程序」，选这个子目录（含 `manifest.json`）。

## 开始采集

打开对应公开账号主页，先用「新建3帖循环」或「新建10帖测试」。之后可新建正式采集、从当前位置起采，或从下拉框中选择原批次继续。

## 导出与离线处理

可导出帖子表、评论表及原始证据。主页位置、失败记录、评论覆盖需结合批次诊断核对。再次安装本目录不会自动继承旧版或旧 `fr` 路径的数据。

在本说明所在目录执行：

```text
python import_facebook_probe.py "<文件路径>" --output-dir "<结果目录>"
```

输入：「导出原始证据（诊断）」生成的单个批次文件。导入优先沿用文件中记录的北京时间起止日；仅旧文件未记录日期时才使用 [pilot_config.json](pilot_config.json) 的默认窗口。省略 `--output-dir` 时写到本平台的 `outputs/facebook/<语种>/<账号键>/`。

## 验证与迁移

运行 `python verify_facebook_import.py` 可离线验证日期和导入路径。扩展所用第三方代码许可见 [PIAZZA_LICENSE.txt](chrome_facebook_probe/PIAZZA_LICENSE.txt)。 新目录不会自动继承旧断点；有未完成任务时继续使用旧目录。新版目录布局仅经过本地验证，不代表在线覆盖通过。

[返回项目首页](../../README.md)
