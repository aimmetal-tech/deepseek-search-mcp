import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { ResultStore } from "../dist/output/store.js";
import { readOutputConfig } from "../dist/output/config.js";

function gate() {
    let release;
    const promise = new Promise(resolve => {
        release = resolve;
    });
    return { promise, release };
}

async function wait(promise) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error("race checkpoint timeout")),
                    3000
                );
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function restore(original) {
    Object.assign(fs, original);
    syncBuiltinESMExports();
}

test(
    "publisher waits for recovery and revalidates ownership before touching archive data",
    { timeout: 15000 },
    async () => {
        const root = await fs.mkdtemp(join(tmpdir(), "ds-handshake-"));
        const config = {
            ...readOutputConfig({}),
            directory: root,
            maxBytes: 14000
        };
        const lock = join(root, ".archive.lock");
        const fakePid = 123456789;
        await fs.writeFile(
            lock,
            JSON.stringify({ pid: fakePid, token: "previous-owner" })
        );
        const original = { link: fs.link, rm: fs.rm };
        const kill = process.kill;
        const cAtPublish = gate();
        const publishC = gate();
        const cPublished = gate();
        const reaperAtDelete = gate();
        const deleteOldObservation = gate();
        let firstLink = true;
        let pausedDelete = false;
        let priorOwnerReleased = false;
        let cFinished = false;
        const jobs = [];
        try {
            fs.link = async (...args) => {
                if (firstLink) {
                    firstLink = false;
                    cAtPublish.release();
                    await publishC.promise;
                    await original.link(...args);
                    cPublished.release();
                    return;
                }
                return original.link(...args);
            };
            process.kill = (pid, signal) => {
                if (pid !== fakePid) return kill(pid, signal);
                if (!priorOwnerReleased) {
                    priorOwnerReleased = true;
                    rmSync(lock);
                }
                throw Object.assign(new Error("previous owner exited"), {
                    code: "ESRCH"
                });
            };
            fs.rm = async (path, ...args) => {
                if (path === lock && !pausedDelete) {
                    pausedDelete = true;
                    reaperAtDelete.release();
                    await deleteOldObservation.promise;
                }
                return original.rm(path, ...args);
            };
            syncBuiltinESMExports();
            const payload = { content: "x".repeat(13000) };
            const c = new ResultStore(config).save("fetch", payload);
            c.then(
                () => {
                    cFinished = true;
                },
                () => {
                    cFinished = true;
                }
            );
            jobs.push(c);
            await wait(cAtPublish.promise);
            jobs.push(new ResultStore(config).save("fetch", payload));
            await wait(reaperAtDelete.promise);
            publishC.release();
            await wait(cPublished.promise);
            await sleep(50);
            assert.equal(
                cFinished,
                false,
                "unconfirmed publisher must not enter the archive critical section"
            );
            assert.deepEqual(
                (await fs.readdir(root)).filter(
                    x => x.startsWith("r_") || x.startsWith(".tmp-")
                ),
                []
            );
            deleteOldObservation.release();
            const results = await Promise.allSettled(jobs);
            assert.equal(
                results.filter(x => x.status === "fulfilled").length,
                1
            );
            assert.equal(
                results.find(x => x.status === "rejected").reason.code,
                "STORE_QUOTA"
            );
            const ids = (await fs.readdir(root)).filter(x =>
                x.startsWith("r_")
            );
            assert.equal(ids.length, 1);
            let used = 0;
            for (const id of ids)
                for (const file of await fs.readdir(join(root, id)))
                    used += (await fs.stat(join(root, id, file))).size;
            assert.ok(used <= config.maxBytes);
        } finally {
            publishC.release();
            deleteOldObservation.release();
            restore(original);
            process.kill = kill;
            await Promise.allSettled(jobs);
            await fs.rm(root, { recursive: true, force: true });
        }
    }
);

test("distinct 64-bit inode identities never collapse to the same lock owner", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "ds-big-inode-"));
    const lock = join(root, ".archive.lock");
    const original = { link: fs.link, lstat: fs.lstat, mkdir: fs.mkdir };
    const inodeA = 2n ** 60n;
    const inodeB = inodeA + 1n;
    assert.equal(Number(inodeA), Number(inodeB));
    const replaced = gate();
    let foreignActive = false;
    let firstPublish = true;
    let enteredForeignSection = false;
    let job;
    try {
        fs.lstat = async (path, options) => {
            const stat = await original.lstat(path, options);
            if (path === lock || basename(String(path)).startsWith(".owner-")) {
                const inode = path === lock && foreignActive ? inodeB : inodeA;
                stat.ino = options?.bigint ? inode : Number(inode);
                stat.dev = options?.bigint ? 7n : 7;
            }
            return stat;
        };
        fs.link = async (...args) => {
            await original.link(...args);
            if (args[1] === lock && firstPublish) {
                firstPublish = false;
                await fs.rm(lock);
                await fs.writeFile(
                    lock,
                    JSON.stringify({ pid: process.pid, token: "other-owner" })
                );
                foreignActive = true;
                replaced.release();
            }
        };
        fs.mkdir = async (path, ...args) => {
            if (foreignActive && basename(String(path)).startsWith(".tmp-")) {
                enteredForeignSection = true;
                throw new Error(
                    "entered critical section owned by a different 64-bit inode"
                );
            }
            return original.mkdir(path, ...args);
        };
        syncBuiltinESMExports();
        const store = new ResultStore({
            ...readOutputConfig({}),
            directory: root
        });
        job = store.save("fetch", { content: "valid" });
        job.catch(() => undefined);
        await wait(replaced.promise);
        await sleep(75);
        assert.equal(enteredForeignSection, false);
        assert.deepEqual(
            (await fs.readdir(root)).filter(
                x => x.startsWith("r_") || x.startsWith(".tmp-")
            ),
            []
        );
        await fs.rm(lock, { force: true });
        foreignActive = false;
        const ref = await job;
        assert.ok(ref.result_id);
    } finally {
        foreignActive = false;
        restore(original);
        await fs.rm(lock, { force: true });
        await job?.catch(() => undefined);
        await fs.rm(root, { recursive: true, force: true });
    }
});

test("publisher retries a transient ownership stat without abandoning its own lock", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "ds-publish-stat-"));
    const lock = join(root, ".archive.lock");
    const original = { link: fs.link, lstat: fs.lstat };
    let published = false;
    let injected = false;
    try {
        fs.link = async (...args) => {
            await original.link(...args);
            if (args[1] === lock) published = true;
        };
        fs.lstat = async (path, ...args) => {
            if (path === lock && published && !injected) {
                injected = true;
                throw Object.assign(new Error("transient stat"), {
                    code: "EPERM"
                });
            }
            return original.lstat(path, ...args);
        };
        syncBuiltinESMExports();
        const store = new ResultStore({
            ...readOutputConfig({}),
            directory: root
        });
        const ref = await store.save("fetch", { content: "valid" });
        assert.ok(injected);
        assert.equal(
            (await store.read(ref.result_id)).text,
            '{"content":"valid"}'
        );
    } finally {
        restore(original);
        await fs.rm(root, { recursive: true, force: true });
    }
});

for (const mode of ["delete-pending", "identity-replaced"]) {
    test(`lock observation retries transient ${mode} instead of failing archival`, async () => {
        const root = await fs.mkdtemp(join(tmpdir(), "ds-lock-observe-"));
        const lock = join(root, ".archive.lock");
        const config = { ...readOutputConfig({}), directory: root };
        const original = { open: fs.open };
        const kill = process.kill;
        const fakePid = 123456789;
        await fs.writeFile(lock, JSON.stringify({ pid: fakePid }));
        let injected = false;
        try {
            process.kill = (pid, signal) => {
                if (pid !== fakePid) return kill(pid, signal);
                throw Object.assign(new Error("exited"), { code: "ESRCH" });
            };
            fs.open = async (path, ...args) => {
                if (path === lock && !injected) {
                    injected = true;
                    if (mode === "delete-pending")
                        throw Object.assign(new Error("delete pending"), {
                            code: "EPERM"
                        });
                    await fs.rename(lock, lock + ".previous");
                    await fs.writeFile(lock, JSON.stringify({ pid: fakePid }));
                }
                return original.open(path, ...args);
            };
            syncBuiltinESMExports();
            const store = new ResultStore(config);
            const ref = await store.save("fetch", { content: "valid" });
            assert.equal(
                (await store.read(ref.result_id)).text,
                '{"content":"valid"}'
            );
            assert.ok(injected);
        } finally {
            restore(original);
            process.kill = kill;
            await fs.rm(root, { recursive: true, force: true });
        }
    });
}

test("interrupted expired-directory deletion leaves a tombstone that the next cleanup reclaims", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "ds-delete-recover-"));
    const config = {
        ...readOutputConfig({}),
        directory: root,
        maxBytes: 14000,
        ttlMs: 10
    };
    let now = 1000;
    const original = { rm: fs.rm };
    const store = new ResultStore(config, () => now);
    try {
        const old = await store.save("fetch", { content: "x".repeat(13000) });
        now += 11;
        let interrupted = false;
        fs.rm = async (path, ...args) => {
            if (
                (String(path).includes(".tmp-") ||
                    path === join(root, old.result_id)) &&
                !interrupted
            ) {
                interrupted = true;
                await original.rm(join(path, "meta.json"));
                throw Object.assign(
                    new Error("interrupted recursive removal"),
                    { code: "EIO" }
                );
            }
            return original.rm(path, ...args);
        };
        syncBuiltinESMExports();
        await assert.rejects(() => store.cleanup());
        assert.ok(interrupted);
        assert.ok(
            !(await fs.readdir(root)).includes(old.result_id),
            "expired result was unpublished before recursive deletion"
        );
        restore(original);
        const restarted = new ResultStore(config, () => now);
        await restarted.cleanup();
        assert.deepEqual(
            (await fs.readdir(root)).filter(
                x => x.startsWith(".tmp-") || x.startsWith("r_")
            ),
            []
        );
        const next = await restarted.save("fetch", {
            content: "x".repeat(13000)
        });
        assert.ok(next.result_id);
    } finally {
        restore(original);
        store.close();
        await fs.rm(root, { recursive: true, force: true });
    }
});
