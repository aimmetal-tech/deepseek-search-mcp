#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { fetchDeepSeek, searchDeepSeek } from "./deepseek.js";
import {
    SearchToolOutputSchema,
    FetchToolOutputSchema,
    SearchInputSchema,
    createReadInputSchema,
    ReadPageSchema
} from "./types.js";
import { readOutputConfig } from "./output/config.js";
import { OutputManager } from "./output/results.js";

const config = readOutputConfig();
const outputs = new OutputManager(config);
const server = new McpServer({ name: "deepseek-search", version: "0.0.1" });

// Web search tool
server.registerTool(
    "search",
    {
        title: "DeepSeek Web Search",
        description:
            "搜索网页。超限时优先保留来源目录并缩短摘要，_result.truncated=true 表示结果不完整；可按需用 read_result 读取完整快照，不必自动遍历全文。",
        inputSchema: SearchInputSchema,
        outputSchema: SearchToolOutputSchema
    },
    args => outputs.run(async () => outputs.search(await searchDeepSeek(args)))
);

// Web fetch tool
server.registerTool(
    "fetch",
    {
        title: "DeepSeek Web Fetch",
        description:
            "抓取网页，返回页面标题与 Markdown 正文。超限时只返回正文开头及 _result；可按需用 read_result 分页读取完整 JSON 快照，不必自动遍历全文。",
        inputSchema: z.object({
            url: z
                .string()
                .min(1, { error: "`url` 不能为空" })
                .max(8192, { error: "`url` 长度不能超过 8192 个字符" })
                .refine(u => /^https?:\/\//i.test(u))
        }),
        outputSchema: FetchToolOutputSchema
    },
    ({ url }) =>
        outputs.run(async () => outputs.fetch(await fetchDeepSeek(url)))
);

server.registerTool(
    "read_result",
    {
        title: "Read Saved Result",
        description:
            "按需读取已保存结果的 UTF-8 JSON 文本。offset/limit 按 Unicode 码点计数，片段不保证独立可解析为 JSON。下一页使用 next_offset，eof=true 时停止；不重新请求上游，不延长保留期。过期或缺失时需重新搜索或抓取。",
        inputSchema: createReadInputSchema(
            config.readDefaultChars,
            config.maxOutputChars
        ),
        outputSchema: ReadPageSchema
    },
    ({ result_id, offset, limit }) =>
        outputs.run(() => outputs.store.read(result_id, offset, limit))
);

outputs.store.startCleanup();
await server.connect(new StdioServerTransport());
