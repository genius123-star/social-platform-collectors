# Social Platform Collectors

多平台公开数据采集工具的统一源码目录。各平台独立安装、运行和导出，可按需使用其中一个。Chrome 扩展无需构建；离线导入器与 YouTube API 工具按平台运行。

| 平台 | 使用入口 | 目录 |
|---|---|---|
| Instagram | Chrome 0.4.2 | [Instagram](platforms/instagram/) |
| TikTok | Chrome 0.6.5 | [TikTok](platforms/tiktok/) |
| Facebook | Chrome 0.6.9 | [Facebook](platforms/facebook/) |
| X | Chrome 0.6.5 | [X](platforms/x/) |
| VK | Chrome 0.5.1 | [VK](platforms/vk/) |
| YouTube | Python + YouTube Data API v3 | [YouTube](platforms/youtube/) |

## 安装与边界

先读所需平台的说明。Chrome 用户在 `chrome://extensions` 开启开发者模式，选择该平台下直接含有 `manifest.json` 的目录；不要选择整个仓库。先试采并核对导出，再开始长批次。各扩展独立使用本机存储；换安装目录后，Chrome 可能分配新的扩展 ID，旧批次不会自动迁入。已有任务请继续使用原安装目录，换目录前先导出数据。

扩展导出由 Chrome 管理：TikTok 和 X 会弹出保存对话框；其他三个扩展使用 Chrome 的下载设置。离线导入或 YouTube 新批次默认写入各平台自己的 `outputs/`；传入 `--output-dir` 可指定新批次的父目录，相对路径按启动命令时的目录解释。扩展下载和命令行输出都不依赖固定盘符。

平台布局、登录状态及页面加载会影响可得字段。缺失不等于 0，批次结束不代表历史覆盖完整。各平台 README 列出支持的账号范围、日期口径和输入格式。

## 开发与发布

各平台的扩展、导入器、平台配置放在同一平台目录；现有 Python 通用辅助文件随各工具保留，以免引入跨平台安装依赖。扩展第三方许可和署名保留在相应模块下。另有依赖旧工作区的研究批处理、试采脚本和历史报告，仍在旧位置，本目录只收录独立运行入口。

发布时从本目录开始，只提交根目录说明、忽略规则和 `platforms/` 下的源码、配置、验证脚本与第三方许可。此目录不提供真实采集结果、个人浏览器资料、内部研究文档或凭据；不要提交导出表、原始备份、诊断文件、运行日志或密钥。使用 Git 检查待提交文件清单，网页手动上传时也需排除这些文件。

总仓库尚未指定开源许可证；各组件的第三方许可继续保留。Instagram、VK 的账号预设和部分平台的研究窗口属于当前实现的一部分，发布前请确认这些配置可以公开。本仓库的离线验证不证明实时网页覆盖。
