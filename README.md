# deepseek-search-mcp

[![DeepSeek](https://img.shields.io/badge/DeepSeek-Search_API-4D6BFE?logo=deepseek&logoColor=white)](https://api-docs.deepseek.com/guides/search/)
[![MCP](https://img.shields.io/badge/MCP-Model_Context_Protocol-000000?logo=modelcontextprotocol&logoColor=white)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

一个基于 [DeepSeek Search API](https://api-docs.deepseek.com/guides/search/) 的 MCP（Model Context Protocol）服务器，通过 stdio 为 AI Agent 提供实时网页搜索与网页抓取能力。

## 工具

| 工具          | 说明                                     | 主要参数                            |
| ------------- | ---------------------------------------- | ----------------------------------- |
| `search`      | 搜索网页，返回标题、链接、摘要和可选日期 | `query`：搜索关键词                 |
| `fetch`       | 抓取网页，返回页面标题与 Markdown 正文   | `url`：HTTP(S) 链接，最长 8192 字符 |
| `read_result` | 按需读取超限结果的完整 JSON 快照         | `result_id`、`offset`、`limit`      |

搜索保留现有精简规则：不返回上游评分、snippet 或正文；即使设置 `need_content=true`，正文也不会出现在精简后的工具结果中。完整快照保存的是**现有工具输出在长度截断前的全部内容**，不是原始 API 响应。

## 安装

需要 Node.js 20+ 和一个 [DeepSeek API Key](https://platform.deepseek.com/)。

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

## 输出截断与完整结果回读

未超限时，`search` 和 `fetch` 保持原有返回结构，不归档，也不分配结果 ID。超限的成功结果会先保存到磁盘，再返回预览和 `_result`：

```json
{
    "title": "网页标题",
    "content": "连续的正文开头……",
    "_result": {
        "truncated": true,
        "result_id": "r_01234567-89ab-4cde-8fab-0123456789ab",
        "total_chars": 100000,
        "created_at": "2026-01-01T00:00:00.000Z",
        "expires_at": "2026-01-08T00:00:00.000Z"
    }
}
```

以上为结构示例，不代表真实请求。搜索另有 `total_results` 和 `shown_results`；先缩短摘要、尽量保留标题与完整 URL，再从末尾移除结果。极端情况下预览可不包含任何来源。抓取预览只保留正文开头，不拼接结尾；极长标题也会缩短。

`content` 中的 JSON 文本和 `structuredContent` 使用**同一份受限对象**，并与工具的 `outputSchema` 一致。默认上限是每种表示的数据 JSON 各 **12000 个 Unicode 码点**，包含元数据及 JSON 转义开销。它不是 token 上限，也不包含协议外壳；宿主若同时将两种表示交给模型，占用仍会叠加。连续多次回读累计的上下文同样没有总量保证。

### `read_result`：对已保存的快照分页

模型无需共享服务进程的文件系统，只需调用同一个 MCP 服务：

```json
{
    "result_id": "r_01234567-89ab-4cde-8fab-0123456789ab",
    "offset": 0,
    "limit": 12
}
```

```json
{
    "result_id": "r_01234567-89ab-4cde-8fab-0123456789ab",
    "text": "{\"title\":\"示例",
    "offset": 0,
    "returned_chars": 12,
    "total_chars": 100000,
    "next_offset": 12,
    "eof": false
}
```

示例特意使用 12 个码点的小页。实际默认 `offset=0`、`limit=4000`。

- 偏移针对保存的 `JSON.stringify(data)` 文本，从 0 开始；不是 UTF-8 字节、UTF-16 单元或解码后的网页正文位置。
- 片段可跨 JSON 字段和转义序列，不保证单独解析为 JSON；响应外壳始终合法。需要重组全文时，依序拼接 `text` 后再解析。
- `limit` 为正整数，不能超过配置的输出上限。外壳、转义占用预算时，实际返回量会缩短；下一页必须使用 `next_offset`，不能自行加 `limit`。
- `eof=true` 时停止，`next_offset=null`。`offset` 等于总长度时返回空的末页，超出总长度则报错。
- 按需读取，不必自动遍历全文。读取不重新请求 DeepSeek、不延长到期时间，也不产生新的归档。
- 文件采用有界 UTF-8 扫描，不会每页把全文重新载入内存；靠后的字符偏移仍需从文件开头扫描，未建立随机访问索引。

## 保存配置

所有配置在启动时读取。可在 MCP 客户端的 `env` 中设置，也可在本地开发时写入 `.env`。

| 环境变量                | 默认值                                      | 约束                                                         |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| `DS_RESULT_DIR`         | 用户主目录下 `.deepseek-search-mcp/results` | 覆盖时必须为绝对路径，不能是符号链接目录                     |
| `DS_MAX_OUTPUT_CHARS`   | `12000`                                     | 整数，至少 `1024`；按最终数据 JSON 的 Unicode 码点计量       |
| `DS_READ_DEFAULT_CHARS` | `4000`                                      | 正整数，不超过输出上限；未设置时自动取 `min(4000, 输出上限)` |
| `DS_RESULT_TTL_DAYS`    | `7`                                         | 正整数；到期时间须能用四位年份的 ISO 时间表示                |
| `DS_RESULT_MAX_BYTES`   | `536870912`（512 MiB）                      | 正整数，结果及其元数据的逻辑字节配额                         |

例如 Windows 上可在 MCP `env` 配置中加入 `"DS_RESULT_DIR": "D:/mcp-results/deepseek"`。默认目录不依赖工作目录或 npx 缓存目录。配置非法时服务拒绝启动。

### 保留、配额与故障

- 超限成功结果以随机 ID 保存，重启后在到期前仍可读取。服务在启动、归档和每小时定期清理过期文件；确认过期后先改名为待清理目录，删除中断可在下次清理时继续回收。
- 7 天是结果的逻辑有效期；闲置或服务停止时，不保证到期瞬间物理删除。读取不会续期。
- 空间不足时先清过期文件，仍不足则拒绝新归档；**不会提前淘汰未过期引用**。单份结果连同元数据超过总配额也会被拒绝。
- 配额针对受管理结果的逻辑字节，不是文件系统占用块数。不要把其他文件存入该目录。
- 数据与元数据在同目录临时写入后一起发布。多个本机 stdio 进程通过文件锁协调配额与清理，共用目录时应配置一致的配额；保存目录需支持硬链接及同目录重命名，建议使用本机文件系统。
- 写入失败时返回工具错误，不提供伪 ID，也不回退到无限制全文输出。失败后的请求可能重新访问上游。
- 已注册工具的调用错误只返回受预算限制的摘要，隐藏 API 密钥和 Bearer 凭据，不返回堆栈，也不归档完整错误体。参数 schema 校验失败沿用 SDK 的工具错误格式，不保证包含 `error.code` 字段。未知工具名等 JSON-RPC 协议错误保留 SDK 语义，不属于工具结果的数据预算。
- `RESULT_NOT_FOUND` / `RESULT_EXPIRED` 表示引用不可用；`INVALID_READ` 表示分页参数无效；`RESULT_CORRUPT` 表示可检测的文件损坏；`STORE_QUOTA` / `STORE_BUSY` / `STORE_IO` 表示配额、锁或存储故障。
- 异常退出的写入者锁可自动恢复。若恢复进程自身崩溃并遗留 `.archive.recovery`，服务会保守拒绝归档；**先停止所有共用目录的服务实例**，再移除该恢复目录。损坏的 `.archive.lock` 也仅应在全部实例停止后人工移除。
- 结果文件保存在本地，不会额外上传。POSIX 新目录/文件采用 `0700` / `0600`；Windows 依赖目录 ACL。ID 不是多租户授权凭据，不应把保存目录公开共享。

### 范围限制

输出管理不改变上游现有的 `res.json()` / 错误体读取方式，**不承诺限制上游响应体积或进程峰值内存**。同一用户直接篡改归档文件也不在安全隔离保证内；元数据、文件大小和 UTF-8 异常可被检测，但这不是防篡改存储。

## 开发验证

```bash
npm ci
npm test
npm run lint
```

测试使用 Node 内置 test runner；覆盖 Unicode/转义预算、预览、分页重组、跨 UTF-8 块读取、重启、TTL、配额、多进程协调和文件故障。stdio 集成测试使用本地模拟上游，不需要 API Key，也不会发送真实 DeepSeek 请求。

## API 文档

本项目基于 DeepSeek 官方的 Search 与 Fetch 接口：

- [Search API — `POST /v1/tools/search`](https://api-docs.deepseek.com/guides/search/)
- [Fetch API — `POST /v1/tools/fetch`](https://api-docs.deepseek.com/guides/search/)

## License

[MIT](./LICENSE)
