import z from "zod";
import { RESULT_ID_PATTERN } from "./output/ids.js";

export const SearchInputSchema = z.object({
    query: z.string().min(1).max(128).meta({
        description:
            "搜索词。支持 `site:`、`-site:`、引号等搜索语法。必须为 1 ~ 128 个 Unicode 字符，且不能全为空白。"
    }),
    count: z.number().min(1).max(50).default(10).meta({
        description: "返回条数，取值在 1 到 50 之间，默认为 10。"
    }),
    ori_question: z.string().min(1).max(128).optional().meta({
        description: "触发搜索的用户原始问题。"
    }),
    localization: z.string().optional().meta({
        description: "用于优先返回本地化搜索结果的 IP 地址，默认为空字符串。"
    }),
    need_content: z.boolean().default(false).meta({
        description: "是否在 `content` 中返回网页正文。"
    })
});

const SingleSearchResult = z.object({
    rerank_score: z.number(),
    title: z.string(),
    url: z.string(),
    snippet: z.string(),
    summary: z.string(),
    content: z.string().optional(),
    site_name: z.string().optional(),
    date: z.string().optional(),
    authority: z.number()
});

export const SearchOutputSchema = z.object({
    results: z.array(SingleSearchResult)
});

const CompactSearchResultSchema = SingleSearchResult.pick({
    title: true,
    url: true,
    summary: true,
    date: true
});

export const CompactSearchOutputSchema = z.object({
    results: z.array(CompactSearchResultSchema)
});

export const FetchOutputSchema = z.object({
    title: z.string(),
    content: z.string()
});

export const ResultIdSchema = z.string().max(38).regex(RESULT_ID_PATTERN);

export const ResultReferenceSchema = z.object({
    truncated: z.literal(true),
    result_id: ResultIdSchema,
    total_chars: z.number().int().nonnegative().safe(),
    created_at: z.iso.datetime(),
    expires_at: z.iso.datetime()
});
export type ResultReference = z.infer<typeof ResultReferenceSchema>;

export const SearchToolOutputSchema = CompactSearchOutputSchema.extend({
    _result: ResultReferenceSchema.extend({
        total_results: z.number().int().nonnegative(),
        shown_results: z.number().int().nonnegative()
    }).optional()
});

export const FetchToolOutputSchema = FetchOutputSchema.extend({
    _result: ResultReferenceSchema.optional()
});

export function createReadInputSchema(defaultLimit: number, maxLimit: number) {
    return z.object({
        result_id: ResultIdSchema,
        offset: z.number().int().nonnegative().safe().default(0).meta({
            description:
                "保存的 JSON 文本中的 Unicode 码点位置，从 0 开始；不是字节或网页正文位置。"
        }),
        limit: z
            .number()
            .int()
            .positive()
            .max(maxLimit)
            .default(defaultLimit)
            .meta({
                description:
                    "期望读取的码点数；外壳与 JSON 转义占用预算时，实际片段可能更短。下一页必须使用 next_offset。"
            })
    });
}

export const ReadPageSchema = z.object({
    result_id: ResultIdSchema,
    text: z.string(),
    offset: z.number().int().nonnegative().safe(),
    returned_chars: z.number().int().nonnegative().safe(),
    total_chars: z.number().int().nonnegative().safe(),
    next_offset: z.number().int().nonnegative().safe().nullable(),
    eof: z.boolean()
});
export type ReadPage = z.infer<typeof ReadPageSchema>;
