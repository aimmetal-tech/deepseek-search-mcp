import type z from "zod";
import {
    CompactSearchOutputSchema,
    FetchOutputSchema,
    SearchInputSchema,
    SearchOutputSchema
} from "./types.js";
import { pruneEmptyFields } from "./utils/prune.js";

const BASE_URL = "https://api.deepseek.com";
const TIMEOUT_MS = 5_000;

type SearchResult = z.infer<typeof CompactSearchOutputSchema>;
type FetchResult = z.infer<typeof FetchOutputSchema>;

export async function searchDeepSeek(
    args: z.infer<typeof SearchInputSchema>
): Promise<SearchResult> {
    const key = process.env.DS_API_KEY;
    if (!key) throw new Error("缺少环境变量 DS_API_KEY");

    const signal = AbortSignal.timeout(TIMEOUT_MS);

    const res = await fetch(`${BASE_URL}/v1/tools/search`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(args),
        signal
    });

    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

    const rawData = await res.json();
    const data = SearchOutputSchema.parse(pruneEmptyFields(rawData));
    const compactData = CompactSearchOutputSchema.parse(data)
    return compactData;
}

export async function fetchDeepSeek(url: string): Promise<FetchResult> {
    const key = process.env.DS_API_KEY;
    if (!key) throw new Error("缺少环境变量 DS_API_KEY");

    const signal = AbortSignal.timeout(TIMEOUT_MS);

    const res = await fetch(`${BASE_URL}/v1/tools/fetch`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ url }),
        signal
    });

    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

    const data = FetchOutputSchema.parse(await res.json());
    return data;
}
