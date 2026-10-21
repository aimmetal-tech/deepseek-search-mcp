import z from "zod";

const SingleSearchResult = z.object({
    rerank_score: z.number(),
    title: z.string(),
    url: z.string(),
    snippet: z.string(),
    summary: z.string(),
    content: z.string(),
    site_name: z.string(),
    site_icon: z.string(),
    date: z.string(),
    authority: z.number()
});

export const SearchOutputSchema = z.object({
    results: z.array(SingleSearchResult)
});

export const FetchOutputSchema = z.object({
    title: z.string(),
    content: z.string()
});
