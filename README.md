# deepseek-search-mcp

[![DeepSeek](https://img.shields.io/badge/DeepSeek-Search_API-4D6BFE?logo=deepseek&logoColor=white)](https://api-docs.deepseek.com/guides/search/)
[![MCP](https://img.shields.io/badge/MCP-Model_Context_Protocol-000000?logo=modelcontextprotocol&logoColor=white)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

一个基于 [DeepSeek Search API](https://api-docs.deepseek.com/guides/search/) 的 MCP（Model Context Protocol）服务器，通过 stdio 为 AI Agent 提供实时网页搜索与网页抓取能力。

## 工具

| 工具 | 说明 | 参数 |
| --- | --- | --- |
| `search` | 搜索网页，返回标题、链接、摘要、正文等内容 | `query`：搜索关键词 |
| `fetch` | 抓取网页，返回页面标题与 Markdown 格式的内容 | `url`：`https://` 或 `http://` 开头的链接（最长 8192 字符） |

## 安装

需要 Node.js 18+ 和一个 [DeepSeek API Key](https://platform.deepseek.com/)。

在 MCP 客户端（如 VS Code、Claude Desktop 等）的配置文件中添加：

```json
{
    "servers": {
        "deepseek-search": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "github:aimmetal-tech/deepseek-search-mcp"],
            "env": { "DS_API_KEY": "sk-xxxx" }
        }
    }
}
```

把 `sk-xxxx` 替换为你自己的 API Key。`npx` 会自动克隆仓库、安装依赖并构建，无需手动操作。

### 本地开发

```bash
git clone https://github.com/aimmetal-tech/deepseek-search-mcp.git
cd deepseek-search-mcp
npm install
cp .env.example .env   # 填入 DS_API_KEY
npm run dev
```

## API 文档

本项目基于 DeepSeek 官方的 Search 与 Fetch 接口：

- [Search API — `POST /v1/tools/search`](https://api-docs.deepseek.com/guides/search/)
- [Fetch API — `POST /v1/tools/fetch`](https://api-docs.deepseek.com/guides/search/)

## License

[MIT](./LICENSE)
