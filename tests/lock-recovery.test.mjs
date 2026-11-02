import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

async function eventually(check) {
    const deadline = performance.now() + 3000;
    while (!(await check())) {
        assert.ok(
            performance.now() < deadline,
            "deferred release did not finish"
        );
        await sleep(10);
    }
}

async function owners(root) {
    return (await fs.readdir(root)).filter(name => name.startsWith(".owner-"));
}

async function withTimedOutPublisher(run) {
    const root = await fs.mkdtemp(join(tmpdir(), "ds-timeout-release-"));
    const config = { ...readOutputConfig({}), directory: root };
    const lock = join(root, ".archive.lock");
    const recovery = join(root, ".archive.recovery");
    const original = { link: fs.link, lstat: fs.lstat, rm: fs.rm };
    const originalNow = Date.now;
    const store = new ResultStore(config);
    let clock = originalNow();
    let published = false;
    const jobs = [];
    try {
        fs.link = async (...args) => {
            await original.link(...args);
            if (args[1] === lock && !published) {
                published = true;
                await fs.mkdir(recovery);
                clock += 6000;
            }
        };
        Date.now = () => clock;
        syncBuiltinESMExports();
        await assert.rejects(
            () => store.save("fetch", { content: "timed out" }),
            { code: "STORE_BUSY" }
        );
        assert.ok(published);
        Date.now = originalNow;
        restore(original);
        const track = job => {
            jobs.push(job);
            return job;
        };
        await run({ root, config, lock, recovery, original, store, track });
    } finally {
        restore(original);
        await fs.rm(recovery, { recursive: true, force: true });
        Date.now = () => originalNow() + 60000;
        await Promise.allSettled(jobs);
        Date.now = originalNow;
        store.close();
        await fs.rm(lock, { force: true });
        await eventually(async () => (await owners(root)).length === 0);
        await fs.rm(root, { recursive: true, force: true });
    }
}

test(
    "timed-out publisher does not poison later saves or cleanup after recovery finishes",
    { timeout: 15000 },
    () =>
        withTimedOutPublisher(
            async ({ root, lock, recovery, store, track }) => {
                assert.equal((await owners(root)).length, 1);
                assert.equal(
                    JSON.parse(await fs.readFile(lock, "utf8")).pid,
                    process.pid
                );
                await fs.rm(recovery, { recursive: true });
                await wait(track(store.cleanup()));
                const ref = await store.save("fetch", {
                    content: "after recovery"
                });
                assert.equal(
                    (await store.read(ref.result_id)).text,
                    '{"content":"after recovery"}'
                );
                await store.cleanup();
                await eventually(async () => (await owners(root)).length === 0);
                assert.ok(!(await fs.readdir(root)).includes(".archive.lock"));
            }
        )
);

test("delayed release survives close without deleting a successor's lock", () =>
    withTimedOutPublisher(async ({ root, lock, recovery, store }) => {
        const successor = JSON.stringify({
            pid: process.pid,
            token: "successor"
        });
        await fs.rm(lock);
        await fs.writeFile(lock, successor);
        store.close();
        await fs.rm(recovery, { recursive: true });
        await eventually(async () => (await owners(root)).length === 0);
        assert.equal(await fs.readFile(lock, "utf8"), successor);
    }));

test("an unpublished candidate is removed even while recovery remains active", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "ds-unpublished-timeout-"));
    const recovery = join(root, ".archive.recovery");
    const original = { lstat: fs.lstat };
    const originalNow = Date.now;
    const store = new ResultStore({ ...readOutputConfig({}), directory: root });
    let clock = originalNow();
    try {
        await fs.mkdir(recovery);
        fs.lstat = async (path, ...args) => {
            const stat = await original.lstat(path, ...args);
            if (path === recovery) clock += 6000;
            return stat;
        };
        Date.now = () => clock;
        syncBuiltinESMExports();
        await assert.rejects(
            () => store.save("fetch", { content: "not published" }),
            { code: "STORE_BUSY" }
        );
        assert.deepEqual(await owners(root), []);
        assert.deepEqual(await fs.readdir(root), [".archive.recovery"]);
    } finally {
        restore(original);
        Date.now = originalNow;
        store.close();
        await fs.rm(recovery, { recursive: true, force: true });
        await eventually(async () => (await owners(root)).length === 0);
        await fs.rm(root, { recursive: true, force: true });
    }
});

test("an outstanding deferred release does not keep the process alive", () => {
    const source = `
        import fs from 'node:fs/promises';
        import {syncBuiltinESMExports} from 'node:module';
        import {join} from 'node:path';
        import {ResultStore} from ${JSON.stringify(new URL("../dist/output/store.js", import.meta.url).href)};
        import {readOutputConfig} from ${JSON.stringify(new URL("../dist/output/config.js", import.meta.url).href)};
        const root = process.argv[1];
        const store = new ResultStore(readOutputConfig({DS_RESULT_DIR: root}));
        const originalLink = fs.link;
        let clock = Date.now();
        fs.link = async (...args) => {
            await originalLink(...args);
            await fs.mkdir(join(root, '.archive.recovery'));
            clock += 6000;
        };
        Date.now = () => clock;
        syncBuiltinESMExports();
        try { await store.save('fetch', {content: 'timeout'}); throw new Error('missing timeout'); }
        catch (error) { if (error.code !== 'STORE_BUSY') throw error; }
        store.close();
        console.log('timeout delivered');
    `;
    return fs.mkdtemp(join(tmpdir(), "ds-unref-release-")).then(async root => {
        try {
            const result = spawnSync(
                process.execPath,
                ["--input-type=module", "-e", source, root],
                { encoding: "utf8", timeout: 3000 }
            );
            assert.equal(
                result.error,
                undefined,
                "deferred cleanup kept the process alive"
            );
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /timeout delivered/);
        } finally {
            await fs.rm(root, {
                recursive: true,
                force: true,
                maxRetries: 3,
                retryDelay: 25
            });
        }
    });
});

for (const point of ["identity stat", "lock deletion", "owner deletion"]) {
    test(`delayed release preserves state through a transient ${point} failure`, () =>
        withTimedOutPublisher(
            async ({ root, lock, recovery, original, store, track }) => {
                const owner = join(root, (await owners(root))[0]);
                const rejected = gate();
                let denied = true;
                const fail = () => {
                    rejected.release();
                    throw Object.assign(
                        new Error("transient deferred-release failure"),
                        { code: "EACCES" }
                    );
                };
                fs.lstat = async (path, ...args) => {
                    if (denied && point === "identity stat" && path === lock)
                        fail();
                    return original.lstat(path, ...args);
                };
                fs.rm = async (path, ...args) => {
                    if (
                        denied &&
                        ((point === "lock deletion" && path === lock) ||
                            (point === "owner deletion" && path === owner))
                    )
                        fail();
                    return original.rm(path, ...args);
                };
                syncBuiltinESMExports();
                await fs.rm(recovery, { recursive: true });
                await wait(rejected.promise);
                assert.ok((await owners(root)).includes(basename(owner)));
                denied = false;
                restore(original);
                await wait(track(store.cleanup()));
                const ref = await store.save("fetch", {
                    content: "retried release"
                });
                assert.equal(
                    (await store.read(ref.result_id)).text,
                    '{"content":"retried release"}'
                );
                await eventually(async () => (await owners(root)).length === 0);
            }
        ));
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
