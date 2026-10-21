import type { FetchSchema, SearchSchema } from "./types.js";

const BASE_URL = "https://api.deepseek.com";

export async function searchDeepSeek(query: string): Promise<SearchSchema[]> {
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

    const data = (await res.json()) as { results: SearchSchema[] };
    return data.results;
}

export async function fetchDeepSeek(url: string): Promise<FetchSchema> {
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

    const data = (await res.json()) as FetchSchema;
    return data;
}
