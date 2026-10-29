import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface OutputConfig {
    directory: string;
    maxOutputChars: number;
    readDefaultChars: number;
    ttlMs: number;
    maxBytes: number;
}

function integer(
    env: NodeJS.ProcessEnv,
    name: string,
    fallback: number,
    minimum = 1,
    maximum = Number.MAX_SAFE_INTEGER
): number {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(
            `无效配置 ${name}：必须为 ${minimum} 到 ${maximum} 的整数`
        );
    }
    return value;
}

export function readOutputConfig(
    env: NodeJS.ProcessEnv = process.env
): OutputConfig {
    const directory =
        env.DS_RESULT_DIR ?? join(homedir(), ".deepseek-search-mcp", "results");
    if (!isAbsolute(directory)) {
        throw new Error("无效配置 DS_RESULT_DIR：必须为绝对路径");
    }
    const maxOutputChars = integer(env, "DS_MAX_OUTPUT_CHARS", 12_000, 1024);
    const dayMs = 24 * 60 * 60 * 1000;
    return {
        directory,
        maxOutputChars,
        readDefaultChars: integer(
            env,
            "DS_READ_DEFAULT_CHARS",
            Math.min(4000, maxOutputChars),
            1,
            maxOutputChars
        ),
        ttlMs:
            integer(
                env,
                "DS_RESULT_TTL_DAYS",
                7,
                1,
                Math.floor((Date.UTC(9999, 11, 31) - Date.now()) / dayMs)
            ) * dayMs,
        maxBytes: integer(env, "DS_RESULT_MAX_BYTES", 512 * 1024 * 1024)
    };
}
