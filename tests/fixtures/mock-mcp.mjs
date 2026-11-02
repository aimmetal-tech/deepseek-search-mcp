globalThis.fetch = async (_url, options) => {
    const input = JSON.parse(options.body);
    if (input.url?.includes("error")) {
        return new Response(
            `upstream Bearer ${process.env.DS_API_KEY} ${"x".repeat(10000)}`,
            { status: 500 }
        );
    }
    if (input.url) {
        return Response.json({
            title: "测试网页",
            content: input.url.includes("short")
                ? "短正文"
                : '正文😀\\\n"'.repeat(1500)
        });
    }
    return Response.json({
        results: Array.from(
            { length: input.query === "short" ? 1 : 5 },
            (_, i) => ({
                title: `source ${i}`,
                url: `https://source${i}.test`,
                summary:
                    input.query === "short"
                        ? "简短摘要"
                        : "摘要😀".repeat(1000),
                rerank_score: 1,
                snippet: "snippet",
                authority: 1,
                content: "upstream body must still be removed by compact schema"
            })
        )
    });
};
await import("../../dist/index.js");
