import { constants } from "node:fs";
import {
    mkdir,
    lstat,
    realpath,
    open,
    readdir,
    rm,
    rename,
    link
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { OutputConfig } from "./config.js";
import { charLength, fitText } from "./budget.js";

export const RESULT_ID_PATTERN =
    /^r_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ResultError extends Error {
    constructor(
        public readonly code: string,
        message: string
    ) {
        super(message);
    }
}

export interface ResultReference {
    truncated: true;
    result_id: string;
    total_chars: number;
    created_at: string;
    expires_at: string;
}

export interface ReadPage {
    result_id: string;
    text: string;
    offset: number;
    returned_chars: number;
    total_chars: number;
    next_offset: number | null;
    eof: boolean;
}

const MetadataSchema = z.object({
    version: z.literal(1),
    tool: z.enum(["search", "fetch"]),
    result_id: z.string().regex(RESULT_ID_PATTERN),
    total_chars: z.number().int().nonnegative().safe(),
    total_bytes: z.number().int().nonnegative().safe(),
    created_at: z.iso.datetime(),
    expires_at: z.iso.datetime()
});
type Metadata = z.infer<typeof MetadataSchema>;

function hasCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

async function exists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (hasCode(error, "ENOENT")) return false;
        throw error;
    }
}

async function regularFile(path: string): Promise<FileHandle> {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) {
        throw new ResultError("RESULT_CORRUPT", "结果文件类型无效");
    }
    const handle = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
    try {
        const after = await handle.stat();
        if (
            !after.isFile() ||
            after.ino !== before.ino ||
            after.dev !== before.dev
        ) {
            throw new ResultError("RESULT_CORRUPT", "结果文件已被替换");
        }
        return handle;
    } catch (error) {
        await handle.close();
        throw error;
    }
}

async function smallJson(path: string): Promise<unknown> {
    const handle = await regularFile(path);
    try {
        if ((await handle.stat()).size > 8192)
            throw new Error("metadata too large");
        const buffer = Buffer.alloc(8193);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 8192) throw new Error("metadata too large");
        return JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
                buffer.subarray(0, bytesRead)
            )
        );
    } finally {
        await handle.close();
    }
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !hasCode(error, "ESRCH");
    }
}

export class ResultStore {
    private root: Promise<string> | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;

    constructor(
        private readonly config: OutputConfig,
        private readonly now = Date.now
    ) {}

    private async directory(): Promise<string> {
        this.root ??= (async () => {
            await mkdir(this.config.directory, {
                recursive: true,
                mode: 0o700
            });
            const stat = await lstat(this.config.directory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                throw new ResultError(
                    "STORE_IO",
                    "保存目录必须为真实目录，不能是符号链接"
                );
            }
            return realpath(this.config.directory);
        })().catch(error => {
            this.root = undefined;
            throw error;
        });
        const root = await this.root;
        const stat = await lstat(root);
        if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            (await realpath(root)) !== root
        ) {
            throw new ResultError("STORE_IO", "保存目录已被替换");
        }
        return root;
    }

    private async metadata(root: string, id: string): Promise<Metadata> {
        const directory = join(root, id);
        const stat = await lstat(directory);
        if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            (await realpath(directory)) !== directory
        ) {
            throw new ResultError("RESULT_CORRUPT", "结果目录类型无效");
        }
        try {
            const meta = MetadataSchema.parse(
                await smallJson(join(directory, "meta.json"))
            );
            if (
                meta.result_id !== id ||
                Date.parse(meta.expires_at) <= Date.parse(meta.created_at)
            ) {
                throw new Error("invalid metadata");
            }
            return meta;
        } catch (error) {
            if (hasCode(error, "ENOENT")) throw error;
            throw new ResultError("RESULT_CORRUPT", "结果元数据已损坏");
        }
    }

    private async withLock<T>(run: (root: string) => Promise<T>): Promise<T> {
        const root = await this.directory();
        const lock = join(root, ".archive.lock");
        const recovery = join(root, ".archive.recovery");
        const owner = join(root, `.owner-${process.pid}-${randomUUID()}`);
        const token = randomUUID();
        const record = JSON.stringify({ pid: process.pid, token });
        const candidate = await open(owner, "wx", 0o600);
        try {
            await candidate.writeFile(record);
        } finally {
            await candidate.close();
        }
        let acquired = false;
        const deadline = Date.now() + 5000;
        try {
            while (!acquired) {
                if (Date.now() >= deadline) {
                    throw new ResultError(
                        "STORE_BUSY",
                        "归档锁繁忙；若恢复锁遗留，请停止全部实例后清理 .archive.recovery"
                    );
                }
                if (await exists(recovery)) {
                    await delay(25);
                    continue;
                }
                try {
                    await link(owner, lock);
                    acquired = true;
                } catch (error) {
                    if (!hasCode(error, "EEXIST")) throw error;
                    let recovering = false;
                    try {
                        await mkdir(recovery, { mode: 0o700 });
                        recovering = true;
                        if (await exists(lock)) {
                            const value = await smallJson(lock);
                            if (
                                typeof value !== "object" ||
                                value === null ||
                                !("pid" in value) ||
                                !Number.isInteger(value.pid) ||
                                Number(value.pid) < 1
                            ) {
                                throw new ResultError(
                                    "STORE_BUSY",
                                    "归档锁已损坏；请停止全部实例后清理 .archive.lock"
                                );
                            }
                            if (!alive(Number(value.pid))) await rm(lock);
                        }
                    } catch (failure) {
                        if (
                            !hasCode(failure, "EEXIST") &&
                            !hasCode(failure, "ENOENT")
                        )
                            throw failure;
                    } finally {
                        if (recovering) await rm(recovery, { recursive: true });
                    }
                    await delay(25);
                }
            }
            return await run(root);
        } finally {
            try {
                if (acquired) await rm(lock);
            } finally {
                await rm(owner, { force: true });
            }
        }
    }

    private async sweep(root: string): Promise<number> {
        let bytes = 0;
        for (const entry of await readdir(root, { withFileTypes: true })) {
            const path = join(root, entry.name);
            if (/^\.tmp-[0-9]+-[0-9a-f-]+$/.test(entry.name)) {
                await rm(path, { recursive: true, force: true });
                continue;
            }
            if (/^\.owner-[0-9]+-[0-9a-f-]+$/.test(entry.name)) {
                const pid = Number(entry.name.split("-")[1]);
                if (!alive(pid)) await rm(path, { force: true });
                continue;
            }
            if (!RESULT_ID_PATTERN.test(entry.name)) continue;
            if (!entry.isDirectory() || entry.isSymbolicLink()) {
                throw new ResultError(
                    "STORE_IO",
                    "结果目录包含非预期的链接或文件"
                );
            }
            try {
                const meta = await this.metadata(root, entry.name);
                if (Date.parse(meta.expires_at) <= this.now()) {
                    await rm(path, { recursive: true });
                    continue;
                }
            } catch (error) {
                if (
                    !(
                        error instanceof ResultError &&
                        error.code === "RESULT_CORRUPT"
                    ) &&
                    !hasCode(error, "ENOENT")
                )
                    throw error;
            }
            for (const file of await readdir(path, { withFileTypes: true })) {
                const stat = await lstat(join(path, file.name));
                if (!stat.isFile() || stat.isSymbolicLink()) {
                    throw new ResultError(
                        "STORE_IO",
                        "结果目录包含非预期的文件类型"
                    );
                }
                bytes += stat.size;
            }
        }
        return bytes;
    }

    async save(
        tool: "search" | "fetch",
        data: object
    ): Promise<ResultReference> {
        try {
            const text = JSON.stringify(data);
            const id = `r_${randomUUID()}`;
            const now = this.now();
            const meta: Metadata = {
                version: 1,
                tool,
                result_id: id,
                total_chars: charLength(text),
                total_bytes: Buffer.byteLength(text, "utf8"),
                created_at: new Date(now).toISOString(),
                expires_at: new Date(now + this.config.ttlMs).toISOString()
            };
            const metaText = JSON.stringify(meta);
            const needed =
                meta.total_bytes + Buffer.byteLength(metaText, "utf8");
            if (needed > this.config.maxBytes)
                throw new ResultError(
                    "STORE_QUOTA",
                    "单份完整结果超过归档配额"
                );
            await this.withLock(async root => {
                const bytes = await this.sweep(root);
                if (bytes + needed > this.config.maxBytes)
                    throw new ResultError(
                        "STORE_QUOTA",
                        "归档配额已满，未过期结果不会被提前删除"
                    );
                const temporary = join(
                    root,
                    `.tmp-${process.pid}-${randomUUID()}`
                );
                await mkdir(temporary, { mode: 0o700 });
                try {
                    for (const [name, contents] of [
                        ["data.json", text],
                        ["meta.json", metaText]
                    ] as const) {
                        const file = await open(
                            join(temporary, name),
                            "wx",
                            0o600
                        );
                        try {
                            await file.writeFile(contents, "utf8");
                            await file.sync();
                        } finally {
                            await file.close();
                        }
                    }
                    await rename(temporary, join(root, id));
                } finally {
                    await rm(temporary, { recursive: true, force: true });
                }
            });
            return {
                truncated: true,
                result_id: id,
                total_chars: meta.total_chars,
                created_at: meta.created_at,
                expires_at: meta.expires_at
            };
        } catch (error) {
            if (error instanceof ResultError) throw error;
            throw new ResultError(
                "STORE_IO",
                "完整结果保存失败，请检查目录权限、文件系统或磁盘空间"
            );
        }
    }

    async read(
        id: string,
        offset = 0,
        limit = this.config.readDefaultChars
    ): Promise<ReadPage> {
        if (
            !RESULT_ID_PATTERN.test(id) ||
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > this.config.maxOutputChars
        ) {
            throw new ResultError(
                "INVALID_READ",
                "result_id 无效，或 offset/limit 超出允许范围"
            );
        }
        let handle: FileHandle | undefined;
        try {
            const root = await this.directory();
            const meta = await this.metadata(root, id);
            if (Date.parse(meta.expires_at) <= this.now())
                throw new ResultError(
                    "RESULT_EXPIRED",
                    "结果已过期，请重新搜索或抓取"
                );
            if (offset > meta.total_chars)
                throw new ResultError(
                    "INVALID_READ",
                    "offset 超过完整结果长度"
                );
            handle = await regularFile(join(root, id, "data.json"));
            if ((await handle.stat()).size !== meta.total_bytes)
                throw new ResultError(
                    "RESULT_CORRUPT",
                    "结果文件大小与元数据不一致"
                );
            const wanted = Math.min(limit, meta.total_chars - offset);
            const pieces: string[] = [];
            const decoder = new TextDecoder("utf-8", { fatal: true });
            const buffer = Buffer.alloc(64 * 1024);
            let scanned = 0;
            let collected = 0;
            while (collected < wanted) {
                const { bytesRead } = await handle.read(
                    buffer,
                    0,
                    buffer.length,
                    null
                );
                const chunk = decoder.decode(buffer.subarray(0, bytesRead), {
                    stream: bytesRead !== 0
                });
                let start = -1;
                let end = 0;
                let unit = 0;
                for (const char of chunk) {
                    if (scanned >= offset && collected < wanted) {
                        if (start < 0) start = unit;
                        end = unit + char.length;
                        collected++;
                    }
                    unit += char.length;
                    scanned++;
                    if (collected === wanted) break;
                }
                if (start >= 0) pieces.push(chunk.slice(start, end));
                if (bytesRead === 0) {
                    if (collected !== wanted)
                        throw new ResultError(
                            "RESULT_CORRUPT",
                            "结果文件短于元数据声明的字符长度"
                        );
                    break;
                }
            }
            const build = (text: string): ReadPage => {
                const returned = charLength(text);
                const eof = offset + returned === meta.total_chars;
                return {
                    result_id: id,
                    text,
                    offset,
                    returned_chars: returned,
                    total_chars: meta.total_chars,
                    next_offset: eof ? null : offset + returned,
                    eof
                };
            };
            const page = fitText(
                pieces.join(""),
                this.config.maxOutputChars,
                build
            );
            if (wanted > 0 && page.returned_chars === 0)
                throw new ResultError(
                    "INVALID_READ",
                    "输出预算不足以让分页继续"
                );
            return page;
        } catch (error) {
            if (error instanceof ResultError) throw error;
            if (hasCode(error, "ENOENT"))
                throw new ResultError(
                    "RESULT_NOT_FOUND",
                    "结果不存在或已被清理，请重新搜索或抓取"
                );
            if (error instanceof TypeError)
                throw new ResultError(
                    "RESULT_CORRUPT",
                    "结果不是有效的 UTF-8 文本"
                );
            throw new ResultError(
                "STORE_IO",
                "结果读取失败，请检查文件与目录权限"
            );
        } finally {
            await handle?.close();
        }
    }

    async cleanup(): Promise<void> {
        try {
            await this.withLock(root => this.sweep(root));
        } catch (error) {
            if (error instanceof ResultError) throw error;
            throw new ResultError("STORE_IO", "结果清理失败，请检查保存目录");
        }
    }

    startCleanup(): void {
        if (this.timer) return;
        void this.cleanup().catch(() => undefined);
        this.timer = setInterval(
            () => {
                void this.cleanup().catch(() => undefined);
            },
            60 * 60 * 1000
        );
        this.timer.unref();
    }

    close(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }
}
