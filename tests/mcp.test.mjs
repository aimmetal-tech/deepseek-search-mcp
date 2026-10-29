import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { charLength } from "../dist/output/budget.js";
import {
    FetchToolOutputSchema,
    SearchToolOutputSchema,
    ReadPageSchema
} from "../dist/types.js";

async function client(directory, extra = {}) {
    const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./fixtures/mock-mcp.mjs", import.meta.url))],
        {
            env: {
                ...process.env,
                DS_API_KEY: "sk-offline-test-secret",
                DS_RESULT_DIR: directory,
                DS_MAX_OUTPUT_CHARS: "1024",
                DS_READ_DEFAULT_CHARS: "400",
                ...extra
            },
            stdio: ["pipe", "pipe", "pipe"]
        }
    );
    let id = 0;
    let stderr = "";
    const pending = new Map();
    child.stderr.on("data", chunk => {
        stderr += chunk;
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
        const message = JSON.parse(line);
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error)
            item.reject(new Error(JSON.stringify(message.error)));
        else item.resolve(message.result);
    });
    child.on("exit", () => {
        for (const item of pending.values()) {
            clearTimeout(item.timer);
            item.reject(new Error(`MCP exited: ${stderr}`));
        }
        pending.clear();
    });
    const request = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const requestId = ++id;
            const timer = setTimeout(() => {
                pending.delete(requestId);
                reject(new Error(`MCP timeout: ${method}; ${stderr}`));
            }, 10000);
            pending.set(requestId, { resolve, reject, timer });
            child.stdin.write(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: requestId,
                    method,
                    params
                }) + "\n"
            );
        });
    const close = async () => {
        lines.close();
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        child.kill();
        await exited;
    };
    try {
        await request("initialize", {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "offline-test", version: "1" }
        });
        child.stdin.write(
            JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized"
            }) + "\n"
        );
    } catch (error) {
        await close();
        throw error;
    }
    return { request, close };
}

function structured(result, schema) {
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(charLength(result.content[0].text) <= 1024);
    assert.deepEqual(
        JSON.parse(result.content[0].text),
        result.structuredContent
    );
    return schema.parse(result.structuredContent);
}

async function scenario(action, extra) {
    const directory = await mkdtemp(join(tmpdir(), "ds-mcp-"));
    let connection;
    try {
        connection = await client(directory, extra);
        await action(connection, directory);
    } finally {
        await connection?.close();
        await rm(directory, { recursive: true, force: true });
    }
}

test(
    "stdio lists tools, preserves small results, truncates both renderings and reads after restart",
    { timeout: 20000 },
    () =>
        scenario(async (first, directory) => {
            const list = await first.request("tools/list");
            assert.deepEqual(list.tools.map(x => x.name).sort(), [
                "fetch",
                "read_result",
                "search"
            ]);
            assert.ok(list.tools.every(x => x.outputSchema));
            const small = structured(
                await first.request("tools/call", {
                    name: "fetch",
                    arguments: { url: "https://example.test/short" }
                }),
                FetchToolOutputSchema
            );
            assert.deepEqual(small, { title: "测试网页", content: "短正文" });
            const search = structured(
                await first.request("tools/call", {
                    name: "search",
                    arguments: { query: "long", need_content: true }
                }),
                SearchToolOutputSchema
            );
            assert.equal(search.results.length, 5);
            assert.ok(search._result.truncated);
            assert.equal(search.results[0].content, undefined);
            const fetched = structured(
                await first.request("tools/call", {
                    name: "fetch",
                    arguments: { url: "https://example.test/long" }
                }),
                FetchToolOutputSchema
            );
            const ref = fetched._result;
            const idsBefore = (await readdir(directory)).filter(x =>
                x.startsWith("r_")
            );
            await first.close();
            const restarted = await client(directory);
            try {
                let offset = 0;
                let text = "";
                for (let count = 0; count < 200; count++) {
                    const page = structured(
                        await restarted.request("tools/call", {
                            name: "read_result",
                            arguments: { result_id: ref.result_id, offset }
                        }),
                        ReadPageSchema
                    );
                    text += page.text;
                    if (page.eof) break;
                    assert.ok(page.next_offset > offset);
                    offset = page.next_offset;
                }
                const full = JSON.parse(text);
                assert.equal(full.content, '正文😀\\\n"'.repeat(1500));
                assert.equal(charLength(text), ref.total_chars);
                assert.deepEqual(
                    (await readdir(directory))
                        .filter(x => x.startsWith("r_"))
                        .sort(),
                    idsBefore.sort()
                );
            } finally {
                await restarted.close();
            }
        })
);

test(
    "stdio also bounds SDK validation errors for multiple invalid search arguments",
    { timeout: 15000 },
    () =>
        scenario(async connection => {
            const result = await connection.request("tools/call", {
                name: "search",
                arguments: {
                    query: "x".repeat(129),
                    count: 100,
                    ori_question: "y".repeat(129),
                    localization: 4,
                    need_content: "yes"
                }
            });
            assert.equal(result.isError, true);
            assert.ok(
                charLength(result.content[0].text) <= 1024,
                `SDK validation error length: ${charLength(result.content[0].text)}`
            );
        })
);

test(
    "stdio keeps unknown tools as protocol errors without archiving data",
    { timeout: 15000 },
    () =>
        scenario(async (connection, directory) => {
            await assert.rejects(
                () =>
                    connection.request("tools/call", {
                        name: "unknown",
                        arguments: {}
                    }),
                error => JSON.parse(error.message).code === -32602
            );
            assert.deepEqual(
                (await readdir(directory)).filter(x => x.startsWith("r_")),
                []
            );
        })
);

test(
    "stdio bounds and redacts upstream errors and never archives them",
    { timeout: 15000 },
    () =>
        scenario(async (connection, directory) => {
            const result = await connection.request("tools/call", {
                name: "fetch",
                arguments: { url: "https://example.test/error" }
            });
            assert.equal(result.isError, true);
            assert.ok(charLength(result.content[0].text) <= 1024);
            assert.ok(
                !result.content[0].text.includes("sk-offline-test-secret")
            );
            assert.equal(
                JSON.parse(result.content[0].text).error.code,
                "TOOL_ERROR"
            );
            assert.deepEqual(
                (await readdir(directory)).filter(x => x.startsWith("r_")),
                []
            );
        })
);

test(
    "stdio reports failed archival and invalid read IDs without full-data fallback",
    { timeout: 15000 },
    () =>
        scenario(
            async connection => {
                const output = await connection.request("tools/call", {
                    name: "fetch",
                    arguments: { url: "https://example.test/long" }
                });
                assert.equal(output.isError, true);
                assert.equal(
                    JSON.parse(output.content[0].text).error.code,
                    "STORE_QUOTA"
                );
                assert.ok(charLength(output.content[0].text) <= 1024);
                const invalid = await connection.request("tools/call", {
                    name: "read_result",
                    arguments: { result_id: "../outside" }
                });
                assert.equal(invalid.isError, true);
                assert.ok(charLength(invalid.content[0].text) <= 1024);
            },
            { DS_RESULT_MAX_BYTES: "100" }
        )
);
