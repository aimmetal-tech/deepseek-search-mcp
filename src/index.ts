#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { fetchDeepSeek, searchDeepSeek } from "./deepseek.js";
import { FetchOutputSchema, SearchOutputSchema } from "./types.js";

const server = new McpServer({ name: "deepseek-search", version: "0.0.1" });

// Web search tool
server.registerTool(
    "search",
    {
        title: "DeepSeek Web Search",
        description: "搜索网页",
        inputSchema: z.object({ query: z.string() }),
        outputSchema: SearchOutputSchema
    },
    async ({ query }) => {
        const data = await searchDeepSeek(query);
        return {
            content: [{ type: "text", text: JSON.stringify(data) }],
            structuredContent: data
        };
    }
);

// Web fetch tool
server.registerTool(
    "fetch",
    {
        title: "DeepSeek Web Fetch",
        description: "抓取网页，返回页面标题与 Markdown 格式的内容",
        inputSchema: z.object({
            url: z
                .string()
                .min(1, { error: "`url` 不能为空" })
                .max(8192, { error: "`url` 长度不能超过 8192 个字符" })
                .refine(u => /^https?:\/\//i.test(u))
        }),
        outputSchema: FetchOutputSchema
    },
    async ({ url }) => {
        const data = await fetchDeepSeek(url);
        return {
            content: [{ type: "text", text: JSON.stringify(data) }],
            structuredContent: data
        };
    }
);

await server.connect(new StdioServerTransport());
