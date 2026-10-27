export function pruneEmptyFields(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(pruneEmptyFields);
    }

    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .map(([key, item]) => [key, pruneEmptyFields(item)])
                .filter(([, item]) => {
                    return !(
                        item === null ||
                        item === undefined ||
                        (typeof item === "string" && item.trim() === "")
                    );
                })
        );
    }

    return value;
}
