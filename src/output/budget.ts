export function charLength(text: string): number {
    let length = 0;
    for (const _char of text) length++;
    return length;
}

export function prefixChars(text: string, limit: number): string {
    let end = 0;
    let count = 0;
    for (const char of text) {
        if (count++ >= limit) break;
        end += char.length;
    }
    return text.slice(0, end);
}

export function jsonLength(value: object): number {
    return charLength(JSON.stringify(value));
}

export function fitsJson(value: object, budget: number): boolean {
    return jsonLength(value) <= budget;
}

export function fitText<T extends object>(
    text: string,
    budget: number,
    build: (prefix: string) => T
): T {
    const chars = Array.from(prefixChars(text, budget));
    const full = build(chars.join(""));
    if (fitsJson(full, budget)) return full;
    let low = 0;
    let high = chars.length;
    if (!fitsJson(build(""), budget)) {
        throw new Error("输出预算不足以容纳结果元数据");
    }
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fitsJson(build(chars.slice(0, middle).join("")), budget)) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    return build(chars.slice(0, low).join(""));
}
