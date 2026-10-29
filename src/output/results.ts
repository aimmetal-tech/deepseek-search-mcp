import type { z } from "zod";
import type { CompactSearchOutputSchema, FetchOutputSchema } from "../types.js";
import type { OutputConfig } from "./config.js";
import { fitsJson, fitText, prefixChars } from "./budget.js";
import { ResultError, ResultStore } from "./store.js";

type SearchData = z.infer<typeof CompactSearchOutputSchema>;
type FetchData = z.infer<typeof FetchOutputSchema>;

export function toolResult(data: object) {
    return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: { ...data }
    };
}

export class OutputManager {
    constructor(
        private readonly config: OutputConfig,
        readonly store = new ResultStore(config)
    ) {}

    async search(data: SearchData) {
        if (fitsJson(data, this.config.maxOutputChars)) return data;
        const ref = await this.store.save("search", data);
        let shown = data.results.length;
        const preview = (summaryLimit: number) => ({
            results: data.results.slice(0, shown).map(result => ({
                ...result,
                summary: prefixChars(result.summary, summaryLimit)
            })),
            _result: {
                ...ref,
                total_results: data.results.length,
                shown_results: shown
            }
        });
        while (!fitsJson(preview(0), this.config.maxOutputChars) && shown > 0)
            shown--;
        let low = 0;
        let high = this.config.maxOutputChars;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (fitsJson(preview(middle), this.config.maxOutputChars))
                low = middle;
            else high = middle - 1;
        }
        return preview(low);
    }

    async fetch(data: FetchData) {
        if (fitsJson(data, this.config.maxOutputChars)) return data;
        const ref = await this.store.save("fetch", data);
        const base = fitText(data.title, this.config.maxOutputChars, title => ({
            title,
            content: "",
            _result: ref
        }));
        return fitText(data.content, this.config.maxOutputChars, content => ({
            ...base,
            content
        }));
    }

    error(error: unknown) {
        const code = error instanceof ResultError ? error.code : "TOOL_ERROR";
        let message = error instanceof Error ? error.message : "工具调用失败";
        const key = process.env.DS_API_KEY;
        if (key) message = message.split(key).join("[REDACTED]");
        message = message
            .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
            .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]");
        const data = fitText(message, this.config.maxOutputChars, message => ({
            error: { code, message }
        }));
        return {
            isError: true as const,
            content: [{ type: "text" as const, text: JSON.stringify(data) }]
        };
    }

    async run(action: () => Promise<object>) {
        try {
            return toolResult(await action());
        } catch (error) {
            return this.error(error);
        }
    }
}
