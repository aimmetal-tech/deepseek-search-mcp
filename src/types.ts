import z from "zod";

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
