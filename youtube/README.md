# YouTube 公开数据采集

此模块使用 YouTube Data API v3，通过 Python 命令行运行。需要 Python、`requests` 和你自己的 API Key。请把密钥设置于进程环境变量 `YOUTUBE_API_KEY`，也可在本目录建立本地 `.env` 文件并写入一行 `YOUTUBE_API_KEY=你的密钥`。不要提交密钥或 `.env`。

在本目录运行：

```text
python -m pip install -r requirements.txt
python youtube_research.py --help
python youtube_research.py --account cd_yt_yan_en --request-budget 30 --output-dir "<结果目录>"
```

[accounts.json](accounts.json) 保存公开频道配置，`--account` 接收配置中的 `key`。研究期为北京时间 2025-10-17 至 2026-10-17。省略 `--output-dir` 时写到 `outputs/youtube/<语种>/<账号键>/`；中断后用 `--resume "<原批次目录>"` 和原来的 `--account` 续采。该工具只访问公开 API 可见数据，并保留字段缺失和暂停状态；不采集频道后台数据。用 `python verify_youtube_research.py` 进行本地模拟验证。

[返回项目首页](../../README.md)
