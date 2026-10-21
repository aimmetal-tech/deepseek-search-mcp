import type z from "zod";
import { FetchOutputSchema, SearchOutputSchema } from "./types.js";

const BASE_URL = "https://api.deepseek.com";

type SearchResult = z.infer<typeof SearchOutputSchema>;
type FetchResult = z.infer<typeof FetchOutputSchema>;

export async function searchDeepSeek(query: string): Promise<SearchResult> {
    const key = process.env.DS_API_KEY;
    if (!key) throw new Error("缺少环境变量 DS_API_KEY");

    const res = await fetch(`${BASE_URL}/v1/tools/search`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ query, count: 10 })
    });

    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

    const data = SearchOutputSchema.parse(await res.json());
    return data;
}

export async function fetchDeepSeek(url: string): Promise<FetchResult> {
    const key = process.env.DS_API_KEY;
    if (!key) throw new Error("缺少环境变量 DS_API_KEY");

    const res = await fetch(`${BASE_URL}/v1/tools/fetch`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ url })
    });

    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

    const data = FetchOutputSchema.parse(await res.json());
    return data;
}
