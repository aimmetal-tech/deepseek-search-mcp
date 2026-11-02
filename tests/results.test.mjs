import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputManager } from "../dist/output/results.js";
import { readOutputConfig } from "../dist/output/config.js";
import { charLength, jsonLength } from "../dist/output/budget.js";
import {
    SearchToolOutputSchema,
    FetchToolOutputSchema
} from "../dist/types.js";

async function scenario(action, overrides = {}) {
    const directory = await mkdtemp(join(tmpdir(), "ds-preview-"));
    const config = {
        ...readOutputConfig({}),
        maxOutputChars: 1024,
        readDefaultChars: 400,
        directory,
        ...overrides
    };
    const manager = new OutputManager(config);
    try {
        await action(manager, config);
    } finally {
        manager.store.close();
        await rm(directory, { recursive: true, force: true });
    }
}

async function readAll(manager, id) {
    let offset = 0;
    let text = "";
    for (let count = 0; count < 1000; count++) {
        const page = await manager.store.read(id, offset);
        text += page.text;
        if (page.eof) return text;
        assert.ok(page.next_offset > offset);
        offset = page.next_offset;
    }
    throw new Error("pagination failed to stop");
}

test("short results keep their old shape without writing archives", () =>
    scenario(async (manager, config) => {
        const fetch = { title: "short", content: "短😀" };
        const search = {
            results: [
                {
                    title: "one",
                    url: "https://a.test",
                    summary: "短",
                    date: "2026-01-01"
                }
            ]
        };
        assert.deepEqual(await manager.fetch(fetch), fetch);
        assert.deepEqual(await manager.search(search), search);
        assert.deepEqual(await readdir(config.directory), []);
    }));

test("exact output boundary stays unchanged; one extra character triggers archival", () =>
    scenario(async (manager, config) => {
        const base = { title: "t", content: "" };
        const exact = {
            ...base,
            content: "x".repeat(config.maxOutputChars - jsonLength(base))
        };
        assert.equal(jsonLength(exact), config.maxOutputChars);
        assert.deepEqual(await manager.fetch(exact), exact);
        assert.deepEqual(await readdir(config.directory), []);
        const longer = { ...exact, content: exact.content + "x" };
        const preview = await manager.fetch(longer);
        assert.equal(preview._result.truncated, true);
        assert.ok(jsonLength(preview) <= config.maxOutputChars);
        assert.equal(
            await readAll(manager, preview._result.result_id),
            JSON.stringify(longer)
        );
    }));

test("fetch preview keeps a continuous prefix and preserves exact full snapshot", () =>
    scenario(async (manager, config) => {
        const data = { title: "标题", content: '正文😀\n"\\'.repeat(1000) };
        const result = await manager.run(() => manager.fetch(data));
        assert.equal(result.isError, undefined);
        const preview = result.structuredContent;
        FetchToolOutputSchema.parse(preview);
        assert.deepEqual(JSON.parse(result.content[0].text), preview);
        assert.ok(charLength(result.content[0].text) <= config.maxOutputChars);
        assert.ok(data.content.startsWith(preview.content));
        assert.ok(preview.content.length < data.content.length);
        assert.equal(
            await readAll(manager, preview._result.result_id),
            JSON.stringify(data)
        );
    }));

test("even a huge fetch title fits together with metadata", () =>
    scenario(async (manager, config) => {
        const output = await manager.fetch({
            title: "😀".repeat(2000),
            content: "正文".repeat(1000)
        });
        assert.ok(jsonLength(output) <= config.maxOutputChars);
        assert.ok(output.title.length < 4000);
        FetchToolOutputSchema.parse(output);
    }));

test("search shortens summaries before hiding sources", () =>
    scenario(async (manager, config) => {
        const data = {
            results: Array.from({ length: 5 }, (_, i) => ({
                title: `source ${i}`,
                url: `https://source${i}.test`,
                summary: "摘要😀".repeat(1000)
            }))
        };
        const preview = await manager.search(data);
        assert.ok(jsonLength(preview) <= config.maxOutputChars);
        assert.equal(preview.results.length, 5);
        assert.deepEqual(
            preview.results.map(x => x.url),
            data.results.map(x => x.url)
        );
        assert.ok(
            preview.results.every((x, i) =>
                data.results[i].summary.startsWith(x.summary)
            )
        );
        assert.equal(preview._result.total_results, 5);
        assert.equal(preview._result.shown_results, 5);
        SearchToolOutputSchema.parse(preview);
        assert.equal(
            await readAll(manager, preview._result.result_id),
            JSON.stringify(data)
        );
    }));

test("search drops trailing sources without corrupting URLs; one impossible source can be omitted", () =>
    scenario(async (manager, config) => {
        const entries = Array.from({ length: 50 }, (_, i) => ({
            title: `source ${i}`,
            url: `https://source${i}.test/${"a".repeat(100)}`,
            summary: "摘要"
        }));
        const result = await manager.search({ results: entries });
        assert.ok(jsonLength(result) <= config.maxOutputChars);
        assert.ok(result.results.length < 50);
        assert.deepEqual(
            result.results.map(x => x.url),
            entries.slice(0, result.results.length).map(x => x.url)
        );
        const impossible = await manager.search({
            results: [
                {
                    title: "x".repeat(5000),
                    url: "https://source.test",
                    summary: "s"
                }
            ]
        });
        assert.deepEqual(impossible.results, []);
        assert.equal(impossible._result.shown_results, 0);
        assert.ok(jsonLength(impossible) <= config.maxOutputChars);
    }));

test("archive quota failure produces a bounded error, never full output or false ID", () =>
    scenario(
        async (manager, config) => {
            const result = await manager.run(() =>
                manager.fetch({
                    title: "t",
                    content: "secret content".repeat(1000)
                })
            );
            assert.equal(result.isError, true);
            const data = JSON.parse(result.content[0].text);
            assert.equal(data.error.code, "STORE_QUOTA");
            assert.equal(data._result, undefined);
            assert.ok(
                charLength(result.content[0].text) <= config.maxOutputChars
            );
            assert.ok(!result.content[0].text.includes("secret content"));
            assert.deepEqual(await readdir(config.directory), []);
        },
        { maxBytes: 100 }
    ));

test("long errors are bounded, redact credentials, and are not archived", () =>
    scenario(async (manager, config) => {
        const oldKey = process.env.DS_API_KEY;
        process.env.DS_API_KEY = "test-key-with-special+chars";
        try {
            const result = await manager.run(async () => {
                throw new Error(
                    "test-key-with-special+chars Bearer private-token sk-other-secret " +
                        '\\"\n😀'.repeat(1000)
                );
            });
            const text = result.content[0].text;
            assert.equal(result.isError, true);
            assert.ok(charLength(text) <= config.maxOutputChars);
            assert.ok(!text.includes("test-key-with-special+chars"));
            assert.ok(!text.includes("private-token"));
            assert.ok(!text.includes("sk-other-secret"));
            assert.ok(!text.includes("at TestContext"));
            assert.deepEqual(await readdir(config.directory), []);
        } finally {
            if (oldKey === undefined) delete process.env.DS_API_KEY;
            else process.env.DS_API_KEY = oldKey;
        }
    }));
