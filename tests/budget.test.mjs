import assert from "node:assert/strict";
import { test } from "node:test";
import { isAbsolute } from "node:path";
import {
    charLength,
    prefixChars,
    jsonLength,
    fitsJson,
    fitText
} from "../dist/output/budget.js";
import { readOutputConfig } from "../dist/output/config.js";

test("Unicode budgets count code points, not UTF-16 units", () => {
    assert.equal(charLength("A中文😀Z"), 5);
    assert.equal(prefixChars("A中文😀Z", 4), "A中文😀");
    assert.equal(prefixChars("😀", 0), "");
    assert.equal(prefixChars("😀", 20), "😀");
});

test("JSON size includes escaping and metadata and fits exactly at boundary", () => {
    const value = { text: '😀\n"\\', meta: { offset: 0 } };
    const size = jsonLength(value);
    assert.ok(fitsJson(value, size));
    assert.ok(!fitsJson(value, size - 1));
    const full = '😀\n"\\'.repeat(100);
    const build = text => ({ text, meta: { offset: 0 } });
    const fitted = fitText(full, 100, build);
    assert.ok(jsonLength(fitted) <= 100);
    assert.ok(full.startsWith(fitted.text));
    assert.ok(charLength(fitted.text) > 0);
    assert.ok(
        jsonLength(
            build(fitted.text + Array.from(full)[charLength(fitted.text)])
        ) > 100
    );
    assert.throws(() => fitText(full, 1, build), /预算/);
    assert.equal(fitText("", 100, build).text, "");
});

test("configuration has stable defaults and permits absolute directory overrides", () => {
    const defaults = readOutputConfig({});
    assert.ok(isAbsolute(defaults.directory));
    assert.equal(defaults.maxOutputChars, 12000);
    assert.equal(defaults.readDefaultChars, 4000);
    assert.equal(defaults.ttlMs, 7 * 86400000);
    assert.equal(defaults.maxBytes, 536870912);
    assert.equal(
        readOutputConfig({ DS_RESULT_DIR: defaults.directory }).directory,
        defaults.directory
    );
    assert.equal(
        readOutputConfig({ DS_MAX_OUTPUT_CHARS: "1024" }).readDefaultChars,
        1024
    );
});

test("invalid, relative and unsafe configuration fails before serving", () => {
    for (const env of [
        { DS_RESULT_DIR: "relative" },
        { DS_RESULT_DIR: "" },
        { DS_MAX_OUTPUT_CHARS: "1000" },
        { DS_MAX_OUTPUT_CHARS: "1e4" },
        { DS_RESULT_TTL_DAYS: "0" },
        { DS_RESULT_MAX_BYTES: "Infinity" },
        { DS_RESULT_MAX_BYTES: "9007199254740992" },
        { DS_READ_DEFAULT_CHARS: "12001" },
        { DS_RESULT_MAX_BYTES: "-1" }
    ])
        assert.throws(() => readOutputConfig(env), /无效配置/);
});
