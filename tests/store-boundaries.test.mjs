import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { ResultStore } from "../dist/output/store.js";
import { readOutputConfig } from "../dist/output/config.js";
import { charLength } from "../dist/output/budget.js";

test("paging preserves emoji crossing a 64 KiB UTF-8 read boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "ds-block-"));
    const config = { ...readOutputConfig({}), directory: root };
    const store = new ResultStore(config);
    try {
        const data = { content: "a".repeat(65523) + '中😀\\\n"'.repeat(5000) };
        const json = JSON.stringify(data);
        const chars = Array.from(json);
        const ref = await store.save("fetch", data);
        for (const offset of [
            65520,
            65523,
            65524,
            65530,
            70000,
            charLength(json) - 50
        ]) {
            const page = await store.read(ref.result_id, offset, 50);
            assert.equal(
                page.text,
                chars.slice(offset, offset + page.returned_chars).join("")
            );
        }
    } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a dead writer lock is recovered without removing committed results", async () => {
    const root = await mkdtemp(join(tmpdir(), "ds-dead-lock-"));
    const config = { ...readOutputConfig({}), directory: root };
    const store = new ResultStore(config);
    try {
        const first = await store.save("fetch", { content: "first" });
        const deadPid = Number(
            execFileSync(
                process.execPath,
                ["-e", "process.stdout.write(String(process.pid))"],
                { encoding: "utf8" }
            )
        );
        await writeFile(
            join(root, ".archive.lock"),
            JSON.stringify({ pid: deadPid, token: "dead" })
        );
        const second = await store.save("fetch", { content: "second" });
        assert.equal(
            (await store.read(first.result_id)).text,
            '{"content":"first"}'
        );
        assert.equal(
            (await store.read(second.result_id)).text,
            '{"content":"second"}'
        );
        assert.ok(!(await readdir(root)).includes(".archive.lock"));
    } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
    }
});
