import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    symlink,
    writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readOutputConfig } from "../dist/output/config.js";
import { ResultStore } from "../dist/output/store.js";

const resultIdPattern =
    /^r_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const charLength = text => Array.from(text).length;
const quotaPayload = { text: "x".repeat(8 * 1024) };

async function withStore(run, overrides = {}) {
    const directory = await mkdtemp(join(tmpdir(), "deepseek-result-store-"));
    const config = {
        ...readOutputConfig({ DS_RESULT_DIR: join(directory, "results") }),
        maxOutputChars: 1024,
        readDefaultChars: 64,
        ...overrides
    };
    const stores = new Set();
    const open = (extra = {}, now) => {
        const store = new ResultStore({ ...config, ...extra }, now);
        stores.add(store);
        return store;
    };
    const close = store => {
        store.close();
        stores.delete(store);
    };
    try {
        await run({ directory, config, open, close });
    } finally {
        try {
            for (const store of stores) store.close();
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 25
            });
        }
    }
}

async function resultDirectories(directory) {
    try {
        return (await readdir(directory, { withFileTypes: true }))
            .filter(entry => entry.isDirectory() && entry.name.startsWith("r_"))
            .map(entry => entry.name)
            .sort();
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
}

function timestamp(value) {
    // The public contract does not choose ISO strings versus epoch milliseconds.
    const time = typeof value === "number" ? value : Date.parse(value);
    assert.ok(Number.isFinite(time), "reference timestamps must be valid");
    return time;
}

function assertPage(page, reference, source, config, offset, limit) {
    const chars = Array.from(source);
    const returned = charLength(page.text);
    assert.equal(page.result_id, reference.result_id);
    assert.equal(page.offset, offset);
    assert.equal(page.total_chars, chars.length);
    assert.equal(page.returned_chars, returned);
    assert.ok(returned <= limit, "limit is an upper bound in code points");
    assert.equal(page.text, chars.slice(offset, offset + returned).join(""));
    const eof = offset + returned === chars.length;
    assert.equal(page.eof, eof);
    assert.equal(page.next_offset, eof ? null : offset + returned);
    assert.ok(
        charLength(JSON.stringify(page)) <= config.maxOutputChars,
        "the entire serialized page, including escapes and metadata, must fit"
    );
    if (!eof) assert.ok(returned > 0, "a non-EOF page must make progress");
}

async function reassemble(store, reference, source, config, limit) {
    let offset = 0;
    let text = "";
    for (;;) {
        const page = await store.read(reference.result_id, offset, limit);
        assertPage(page, reference, source, config, offset, limit);
        text += page.text;
        if (page.eof) break;
        offset = page.next_offset;
    }
    assert.equal(text, source);
    return text;
}

async function concurrentWriters(config, data) {
    const children = [];
    let timer;
    try {
        return await new Promise((resolve, reject) => {
            const ready = new Set();
            const results = new Map();
            let exited = 0;
            timer = setTimeout(
                () => reject(new Error("store writer processes timed out")),
                15000
            );
            for (let i = 0; i < 2; i++) {
                const child = fork(
                    new URL("./fixtures/store-writer.mjs", import.meta.url),
                    [],
                    {
                        execArgv: [],
                        stdio: ["ignore", "ignore", "pipe", "ipc"],
                        windowsHide: true
                    }
                );
                children.push(child);
                let stderr = "";
                child.stderr.setEncoding("utf8");
                child.stderr.on("data", chunk => {
                    stderr = (stderr + chunk).slice(-4096);
                });
                child.on("error", reject);
                child.on("message", message => {
                    if (message.type === "ready") {
                        ready.add(child);
                        if (ready.size === 2) {
                            for (const writer of children) {
                                writer.send({ config, data });
                            }
                        }
                    } else if (message.type === "result") {
                        results.set(child, message);
                    }
                });
                child.on("exit", (code, signal) => {
                    if (code !== 0 || !results.has(child)) {
                        reject(
                            new Error(
                                `store writer exited (${code}, ${signal}): ${stderr}`
                            )
                        );
                    }
                    if (++exited === 2) {
                        resolve(children.map(writer => results.get(writer)));
                    }
                });
            }
        });
    } finally {
        clearTimeout(timer);
        await Promise.all(
            children.map(async child => {
                if (
                    !child.pid ||
                    child.exitCode !== null ||
                    child.signalCode !== null
                )
                    return;
                const exited = once(child, "exit");
                child.kill();
                await exited;
            })
        );
    }
}

test("save publishes UUID references and exact immutable UTF-8 JSON snapshots", async () => {
    await withStore(async ({ config, open }) => {
        const now = Date.UTC(2026, 0, 1);
        const store = open({}, () => now);
        const ids = new Set();
        for (const tool of ["search", "fetch"]) {
            const data = { tool, text: '中文😀\n"\\', nested: { value: 42 } };
            const source = JSON.stringify(data);
            const reference = await store.save(tool, data);
            assert.equal(reference.truncated, true);
            assert.match(reference.result_id, resultIdPattern);
            assert.ok(!ids.has(reference.result_id));
            ids.add(reference.result_id);
            assert.equal(reference.total_chars, charLength(source));
            assert.equal(timestamp(reference.created_at), now);
            assert.equal(timestamp(reference.expires_at), now + config.ttlMs);
            const path = join(config.directory, reference.result_id);
            assert.ok((await lstat(path)).isDirectory());
            assert.deepEqual(
                await readFile(join(path, "data.json")),
                Buffer.from(source, "utf8")
            );
            const meta = JSON.parse(
                await readFile(join(path, "meta.json"), "utf8")
            );
            assert.ok(meta && typeof meta === "object" && !Array.isArray(meta));
            data.text = "changed after save";
            data.nested.value = 0;
            const restored = await reassemble(
                store,
                reference,
                source,
                config,
                config.maxOutputChars
            );
            assert.deepEqual(JSON.parse(restored), JSON.parse(source));
        }
    });
});

test("Unicode and escaped JSON pages fit the whole response budget and reassemble", async () => {
    await withStore(async ({ config, open }) => {
        const store = open();
        const data = { text: '中文😀𠮷e\u0301\n\t"\\\0\b\f\r'.repeat(180) };
        const source = JSON.stringify(data);
        const reference = await store.save("fetch", data);
        assert.ok(Buffer.byteLength(source, "utf8") > charLength(source));
        const first = await store.read(reference.result_id, 0, 1024);
        assertPage(first, reference, source, config, 0, 1024);
        assert.ok(
            first.returned_chars < 1024,
            "escaping and metadata reduce text"
        );
        const restored = await reassemble(
            store,
            reference,
            source,
            config,
            1024
        );
        assert.deepEqual(JSON.parse(restored), data);

        const emojiOffset = charLength(source.slice(0, source.indexOf("😀")));
        const emoji = await store.read(reference.result_id, emojiOffset, 1);
        assertPage(emoji, reference, source, config, emojiOffset, 1);
        assert.equal(emoji.text, "😀");
        const escapeOffset = charLength(source.slice(0, source.indexOf("\\n")));
        const slash = await store.read(reference.result_id, escapeOffset, 1);
        const n = await store.read(reference.result_id, escapeOffset + 1, 1);
        assertPage(slash, reference, source, config, escapeOffset, 1);
        assertPage(n, reference, source, config, escapeOffset + 1, 1);
        assert.equal(slash.text + n.text, "\\n", "JSON escapes may span pages");
    });
});

test("UTF-8 scanning preserves astral characters across large file boundaries", async () => {
    await withStore(async ({ config, open }) => {
        const store = open();
        // The first emoji straddles byte 65536 in this JSON snapshot.
        const data = { text: "a".repeat(65526) + "😀中𠮷".repeat(30) };
        const source = JSON.stringify(data);
        const reference = await store.save("fetch", data);
        const emojiOffset = charLength(source.slice(0, source.indexOf("😀")));
        for (const offset of [
            0,
            4095,
            8191,
            16383,
            32767,
            emojiOffset - 1,
            emojiOffset,
            emojiOffset + 1,
            emojiOffset + 2,
            charLength(source) - 1
        ]) {
            const page = await store.read(reference.result_id, offset, 17);
            assertPage(page, reference, source, config, offset, 17);
        }
    });
});

test("read defaults, smaller limits, trailing pages and offset-at-total EOF", async () => {
    await withStore(
        async ({ config, open }) => {
            const store = open();
            const data = { text: "中文😀".repeat(60) };
            const source = JSON.stringify(data);
            const reference = await store.save("search", data);
            const first = await store.read(reference.result_id);
            assertPage(
                first,
                reference,
                source,
                config,
                0,
                config.readDefaultChars
            );
            assert.equal(first.returned_chars, config.readDefaultChars);
            const short = await store.read(reference.result_id, undefined, 1);
            assertPage(short, reference, source, config, 0, 1);
            assert.equal(short.returned_chars, 1);
            const total = reference.total_chars;
            const tail = await store.read(reference.result_id, total - 3, 17);
            assertPage(tail, reference, source, config, total - 3, 17);
            assert.equal(tail.returned_chars, 3);
            const empty = await store.read(reference.result_id, total);
            assertPage(
                empty,
                reference,
                source,
                config,
                total,
                config.readDefaultChars
            );
            assert.equal(empty.text, "");
            assert.equal(empty.returned_chars, 0);
        },
        { readDefaultChars: 17 }
    );
});

test("read rejects out-of-range, negative, fractional and non-finite pagination", async () => {
    await withStore(async ({ config, open }) => {
        const store = open();
        const reference = await store.save("search", { text: "中文😀" });
        for (const offset of [
            -1,
            0.5,
            NaN,
            Infinity,
            -Infinity,
            Number.MAX_SAFE_INTEGER + 1,
            reference.total_chars + 1
        ]) {
            await assert.rejects(
                () => store.read(reference.result_id, offset, 1),
                { code: "INVALID_READ" },
                `invalid offset: ${offset}`
            );
        }
        for (const limit of [
            0,
            -1,
            0.5,
            NaN,
            Infinity,
            config.maxOutputChars + 1
        ]) {
            await assert.rejects(
                () => store.read(reference.result_id, 0, limit),
                { code: "INVALID_READ" },
                `invalid limit: ${limit}`
            );
        }
    });
});

test("a new store reads the same snapshot after the writer closes", async () => {
    await withStore(async ({ config, open, close }) => {
        const writer = open();
        const data = {
            items: [{ title: "中文😀", url: "https://example.com" }]
        };
        const source = JSON.stringify(data);
        const reference = await writer.save("search", data);
        close(writer);
        const reader = open();
        await reassemble(reader, reference, source, config, 23);
    });
});

test("reads do not extend TTL and cleanup removes only expired results", async () => {
    await withStore(
        async ({ config, open }) => {
            const base = Date.UTC(2026, 0, 1);
            let now = base;
            const store = open({}, () => now);
            const expired = await store.save("search", { text: "old" });
            now = base + 50;
            const liveData = { text: "still live" };
            const live = await store.save("fetch", liveData);
            now = base + 99;
            await store.read(expired.result_id);
            await store.read(expired.result_id);
            now = base + 100;
            await assert.rejects(() => store.read(expired.result_id), {
                code: "RESULT_EXPIRED"
            });
            await store.cleanup();
            await assert.rejects(
                () => lstat(join(config.directory, expired.result_id)),
                { code: "ENOENT" }
            );
            await assert.rejects(() => store.read(expired.result_id), {
                code: "RESULT_NOT_FOUND"
            });
            const page = await store.read(live.result_id);
            assertPage(page, live, JSON.stringify(liveData), config, 0, 64);
        },
        { ttlMs: 100 }
    );
});

test("cleanup and its background lifecycle are safe with live snapshots", async () => {
    await withStore(async ({ config, open, close }) => {
        const store = open();
        const data = { text: "keep me" };
        const reference = await store.save("fetch", data);
        store.startCleanup();
        await store.cleanup();
        await store.cleanup();
        const page = await store.read(reference.result_id);
        assertPage(page, reference, JSON.stringify(data), config, 0, 64);
        close(store);
    });
});

test("a single snapshot exceeding the UTF-8 byte quota publishes no ID", async () => {
    await withStore(
        async ({ config, open }) => {
            const store = open();
            const data = { text: "😀".repeat(128) };
            assert.ok(charLength(JSON.stringify(data)) < config.maxBytes);
            assert.ok(
                Buffer.byteLength(JSON.stringify(data)) > config.maxBytes
            );
            await assert.rejects(() => store.save("fetch", data), {
                code: "STORE_QUOTA"
            });
            assert.deepEqual(await resultDirectories(config.directory), []);
        },
        { maxBytes: 256 }
    );
});

test("quota exhaustion never evicts unexpired references", async () => {
    await withStore(
        async ({ config, open }) => {
            let now = Date.UTC(2026, 0, 1);
            const store = open({}, () => now);
            const first = await store.save("search", quotaPayload);
            now++;
            const second = await store.save("fetch", quotaPayload);
            await assert.rejects(() => store.save("search", quotaPayload), {
                code: "STORE_QUOTA"
            });
            for (const reference of [first, second]) {
                const page = await store.read(reference.result_id);
                assertPage(
                    page,
                    reference,
                    JSON.stringify(quotaPayload),
                    config,
                    0,
                    64
                );
            }
            assert.deepEqual(
                await resultDirectories(config.directory),
                [first.result_id, second.result_id].sort()
            );
        },
        { maxBytes: 20 * 1024 }
    );
});

test("save reclaims expired snapshots before checking quota", async () => {
    await withStore(
        async ({ config, open }) => {
            let now = Date.UTC(2026, 0, 1);
            const store = open({}, () => now);
            const old = await store.save("search", quotaPayload);
            now += config.ttlMs;
            const fresh = await store.save("fetch", quotaPayload);
            assert.deepEqual(await resultDirectories(config.directory), [
                fresh.result_id
            ]);
            await assert.rejects(
                () => lstat(join(config.directory, old.result_id)),
                {
                    code: "ENOENT"
                }
            );
            const page = await store.read(fresh.result_id);
            assertPage(
                page,
                fresh,
                JSON.stringify(quotaPayload),
                config,
                0,
                64
            );
        },
        { maxBytes: 12 * 1024, ttlMs: 100 }
    );
});

test("save cleans expired files even when remaining live files still prevent admission", async () => {
    await withStore(
        async ({ config, open }) => {
            const base = Date.UTC(2026, 0, 1);
            let now = base;
            const store = open({}, () => now);
            const old = await store.save("search", quotaPayload);
            now = base + 50;
            const live = await store.save("fetch", quotaPayload);
            now = base + 100;
            await assert.rejects(
                () => store.save("fetch", { text: "x".repeat(14 * 1024) }),
                { code: "STORE_QUOTA" }
            );
            await assert.rejects(
                () => lstat(join(config.directory, old.result_id)),
                {
                    code: "ENOENT"
                }
            );
            assert.deepEqual(await resultDirectories(config.directory), [
                live.result_id
            ]);
            const page = await store.read(live.result_id);
            assertPage(page, live, JSON.stringify(quotaPayload), config, 0, 64);
        },
        { maxBytes: 20 * 1024, ttlMs: 100 }
    );
});

test("two instances coordinate concurrent saves without oversubscribing quota", async () => {
    await withStore(
        async ({ config, open }) => {
            const first = open();
            const second = open();
            const outcomes = await Promise.allSettled([
                first.save("search", quotaPayload),
                second.save("fetch", quotaPayload)
            ]);
            const saved = outcomes.filter(
                outcome => outcome.status === "fulfilled"
            );
            const rejected = outcomes.filter(
                outcome => outcome.status === "rejected"
            );
            assert.equal(saved.length, 1);
            assert.equal(rejected.length, 1);
            assert.ok(
                ["STORE_QUOTA", "STORE_BUSY"].includes(rejected[0].reason.code)
            );
            const reference = saved[0].value;
            for (const store of [first, second]) {
                const page = await store.read(reference.result_id);
                assertPage(
                    page,
                    reference,
                    JSON.stringify(quotaPayload),
                    config,
                    0,
                    64
                );
            }
            assert.deepEqual(await resultDirectories(config.directory), [
                reference.result_id
            ]);
        },
        { maxBytes: 12 * 1024 }
    );
});

test("independent child processes share the same quota and publish readable results", async () => {
    await withStore(
        async ({ config, open }) => {
            const outcomes = await concurrentWriters(config, quotaPayload);
            const saved = outcomes.filter(
                outcome => outcome.status === "fulfilled"
            );
            const rejected = outcomes.filter(
                outcome => outcome.status === "rejected"
            );
            assert.equal(saved.length, 1);
            assert.equal(rejected.length, 1);
            assert.ok(["STORE_QUOTA", "STORE_BUSY"].includes(rejected[0].code));
            const reference = saved[0].value;
            const reader = open();
            const page = await reader.read(reference.result_id);
            assertPage(
                page,
                reference,
                JSON.stringify(quotaPayload),
                config,
                0,
                64
            );
            assert.deepEqual(await resultDirectories(config.directory), [
                reference.result_id
            ]);
        },
        { maxBytes: 12 * 1024 }
    );
});

test("a file in place of the store directory fails without publishing a reference", async () => {
    await withStore(async ({ config, open }) => {
        await writeFile(config.directory, "not a directory");
        await assert.rejects(async () => {
            const store = open();
            await store.save("search", { text: "cannot persist" });
        });
        assert.equal(
            await readFile(config.directory, "utf8"),
            "not a directory"
        );
    });
});

test("serialization failure leaves no published result or poisoned write lock", async () => {
    await withStore(async ({ config, open }) => {
        const store = open();
        const cyclic = {};
        cyclic.self = cyclic;
        await assert.rejects(() => store.save("fetch", cyclic));
        assert.deepEqual(await resultDirectories(config.directory), []);
        const reference = await store.save("fetch", {
            text: "subsequent write"
        });
        assert.match(reference.result_id, resultIdPattern);
        await store.read(reference.result_id);
    });
});

test("read accepts only opaque result IDs, never arbitrary paths", async () => {
    await withStore(async ({ directory, open }) => {
        const store = open();
        const reference = await store.save("search", { text: "snapshot" });
        const outside = join(directory, "outside.json");
        await writeFile(outside, '{"secret":"outside store"}');
        for (const id of [
            "",
            ".",
            "..",
            "../outside.json",
            "..\\outside.json",
            outside,
            "C:\\Windows\\win.ini",
            "/etc/passwd",
            "%2e%2e%2foutside.json",
            "r_not-a-uuid",
            `${reference.result_id}/data.json`,
            `${reference.result_id}\\meta.json`,
            `${reference.result_id}/..`,
            `${reference.result_id}\0`
        ]) {
            await assert.rejects(
                () => store.read(id),
                `must reject ${JSON.stringify(id)}`
            );
        }
        await assert.rejects(() => store.read(`r_${randomUUID()}`), {
            code: "RESULT_NOT_FOUND"
        });
        assert.equal(
            await readFile(outside, "utf8"),
            '{"secret":"outside store"}'
        );
    });
});

for (const kind of ["root", "result", "data.json", "meta.json"]) {
    test(`read rejects a symbolic link replacing ${kind}`, async t => {
        await withStore(async ({ directory, config, open, close }) => {
            const writer = open();
            const reference = await writer.save("fetch", {
                text: "do not follow links"
            });
            close(writer);
            const isDirectory = kind === "root" || kind === "result";
            const path =
                kind === "root"
                    ? config.directory
                    : kind === "result"
                      ? join(config.directory, reference.result_id)
                      : join(config.directory, reference.result_id, kind);
            const target = join(directory, `outside-${kind}`);
            await rename(path, target);
            try {
                await symlink(
                    target,
                    path,
                    isDirectory
                        ? process.platform === "win32"
                            ? "junction"
                            : "dir"
                        : "file"
                );
            } catch (error) {
                if (
                    ["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(
                        error.code
                    )
                ) {
                    t.skip(`symbolic links unavailable: ${error.code}`);
                    return;
                }
                throw error;
            }
            await assert.rejects(async () => {
                const reader = open();
                await reader.read(reference.result_id);
            });
            if (kind === "root") {
                await assert.rejects(async () => {
                    const store = open();
                    await store.save("search", {
                        text: "do not write through links"
                    });
                });
            }
        });
    });
}

for (const [name, corrupt] of [
    ["malformed JSON", () => "{"],
    ["null", () => "null"],
    ["missing fields", () => "{}"],
    [
        "invalid field types",
        text =>
            JSON.stringify(
                Object.fromEntries(
                    Object.keys(JSON.parse(text)).map(key => [key, null])
                )
            )
    ]
]) {
    test(`read rejects corrupt metadata: ${name}`, async () => {
        await withStore(async ({ config, open, close }) => {
            const writer = open();
            const reference = await writer.save("search", { text: "snapshot" });
            close(writer);
            const path = join(
                config.directory,
                reference.result_id,
                "meta.json"
            );
            await writeFile(path, corrupt(await readFile(path, "utf8")));
            const reader = open();
            await assert.rejects(() => reader.read(reference.result_id), {
                code: "RESULT_CORRUPT"
            });
        });
    });
}

for (const [name, corrupt] of [
    ["appended bytes", bytes => Buffer.concat([bytes, Buffer.from(" ")])],
    ["truncated bytes", bytes => bytes.subarray(0, bytes.length - 1)],
    [
        "same character count but more UTF-8 bytes",
        bytes => Buffer.from(bytes.toString("utf8").replace("A", "😀"))
    ]
]) {
    test(`read rejects data size inconsistent with metadata: ${name}`, async () => {
        await withStore(async ({ config, open }) => {
            const store = open();
            const reference = await store.save("fetch", { text: "AAAA" });
            const path = join(
                config.directory,
                reference.result_id,
                "data.json"
            );
            await writeFile(path, corrupt(await readFile(path)));
            await assert.rejects(() => store.read(reference.result_id), {
                code: "RESULT_CORRUPT"
            });
        });
    });
}

test("same-size invalid UTF-8 is rejected instead of decoded with replacement characters", async () => {
    await withStore(async ({ config, open }) => {
        const store = open();
        const reference = await store.save("fetch", {
            text: "safe ASCII payload"
        });
        const path = join(config.directory, reference.result_id, "data.json");
        const original = await readFile(path);
        const corrupt = Buffer.from(original);
        corrupt[Buffer.byteLength('{"text":"')] = 0xff;
        assert.equal(corrupt.length, original.length);
        await writeFile(path, corrupt);
        await assert.rejects(
            () => store.read(reference.result_id, 0, config.maxOutputChars),
            { code: "RESULT_CORRUPT" }
        );
    });
});

for (const name of ["data.json", "meta.json"]) {
    test(`read rejects a missing ${name}`, async () => {
        await withStore(async ({ config, open }) => {
            const store = open();
            const reference = await store.save("fetch", { text: "snapshot" });
            await rm(join(config.directory, reference.result_id, name));
            await assert.rejects(() => store.read(reference.result_id));
        });
    });

    test(`read rejects a directory in place of ${name}`, async () => {
        await withStore(async ({ config, open }) => {
            const store = open();
            const reference = await store.save("fetch", { text: "snapshot" });
            const path = join(config.directory, reference.result_id, name);
            await rm(path);
            await mkdir(path);
            await assert.rejects(() => store.read(reference.result_id));
        });
    });
}
