import { ResultStore } from "../../dist/output/store.js";

// Wait for a shared parent barrier so independently initialized processes race.
process.once("message", async ({ config, data }) => {
    let store;
    let result;
    try {
        store = new ResultStore(config);
        const reference = await store.save("search", data);
        result = { type: "result", status: "fulfilled", value: reference };
    } catch (error) {
        result = { type: "result", status: "rejected", code: error.code };
    } finally {
        store?.close();
    }
    process.send(result, error => {
        if (error) process.exitCode = 1;
        process.disconnect();
    });
});
process.send({ type: "ready" });
