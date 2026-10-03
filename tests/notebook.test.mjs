import test from "node:test";
import assert from "node:assert/strict";
import { device, exchange, memoryArea } from "./helpers.mjs";
import { LIMITS, bucketFor, readBuckets } from "../extension/core/model.js";

test("duplicate collection keeps original time and edited meaning, even after worker restart", async () => {
  const first = device("device-a");
  const added = await first.dispatch({ type: "add", word: "Apple" });
  await first.dispatch({ type: "edit", word: "apple", definition: "苹果公司" });
  const restarted = device("device-a", { local: first.local, sync: first.sync });
  const duplicate = await restarted.dispatch({ type: "add", word: "APPLE" });
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.entries.length, 1);
  assert.equal(duplicate.entries[0].createdAt, added.entries[0].createdAt);
  assert.equal(duplicate.entries[0].customDefinition, "苹果公司");
});

test("legitimate prototype-like words can be collected", async () => {
  const client = device("device-a");
  const result = await client.dispatch({ type: "add", word: "constructor" });
  assert.equal(result.entries[0].word, "constructor");
});

test("different offline additions and edits converge without losing words", async () => {
  const first = device("device-a");
  const second = device("device-b", { timestamp: 2000 });
  await first.dispatch({ type: "add", word: "apple" });
  await second.dispatch({ type: "add", word: "banana" });
  await exchange(first, second);
  await exchange(second, first);
  assert.deepEqual((await first.dispatch({ type: "list" })).entries.map(entry => entry.word), ["banana", "apple"]);
  await first.dispatch({ type: "edit", word: "apple", definition: "旧释义" });
  await second.dispatch({ type: "edit", word: "apple", definition: "新释义" });
  await exchange(second, first);
  await exchange(first, second);
  assert.equal((await first.dispatch({ type: "list" })).entries.find(entry => entry.word === "apple").customDefinition, "新释义");
  assert.deepEqual(first.sync.data, second.sync.data);
});

test("offline deletion beats a later stale edit; intentional recollection stays possible", async () => {
  const first = device("device-a");
  const second = device("device-b", { timestamp: 3000 });
  await first.dispatch({ type: "add", word: "saw" });
  await exchange(first, second);
  await first.dispatch({ type: "delete", word: "saw" });
  await second.dispatch({ type: "edit", word: "saw", definition: "看见" });
  await exchange(first, second);
  assert.equal((await second.dispatch({ type: "list" })).entries.length, 0);
  await exchange(second, first);
  await first.dispatch({ type: "add", word: "saw" });
  await exchange(first, second);
  assert.equal((await second.dispatch({ type: "list" })).entries[0].word, "saw");
});

test("an overwritten shard is repaired using oldValue even when the worker never saw it before", async () => {
  const client = device("device-a");
  const key = bucketFor("apple");
  const lost = ["", 100, 100, "device-b", null, 0];
  await client.dispatch({ type: "sync", changes: { [key]: { oldValue: { apple: lost }, newValue: {} } } });
  assert.equal((await client.dispatch({ type: "list" })).entries[0].word, "apple");
  assert.deepEqual(readBuckets(client.sync.data).apple, lost);
});

test("quota overflow is locally durable and automatically retried when capacity returns", async () => {
  const limits = { ...LIMITS, total: 1 };
  const client = device("device-a", { limits });
  const result = await client.dispatch({ type: "add", word: "resilient" });
  assert.equal(result.entries[0].pending, true);
  assert.match(result.issue, /空间不足/);
  const restarted = device("device-a", { local: client.local, sync: client.sync });
  const recovered = await restarted.dispatch({ type: "list" });
  assert.equal(recovered.entries[0].word, "resilient");
  assert.equal(recovered.pending, 0);
});

test("Chrome write throttling does not lose the local word or claim it was submitted", async () => {
  const client = device("device-a");
  client.sync.failure = "MAX_WRITE_OPERATIONS_PER_MINUTE";
  const result = await client.dispatch({ type: "add", word: "hello" });
  assert.equal(result.pending, 1);
  assert.match(result.issue, /MAX_WRITE/);
  assert.ok(client.local.data.notebook.records.hello);
  client.sync.failure = null;
  assert.equal((await client.dispatch({ type: "sync" })).pending, 0);
});

test("storage read errors preserve both local collection and pending deletions", async () => {
  const client = device("device-a");
  await client.dispatch({ type: "add", word: "hello" });
  client.sync.readFailure = "unavailable";
  const deleted = await client.dispatch({ type: "delete", word: "hello" });
  assert.equal(deleted.entries.length, 0);
  assert.equal(deleted.pendingDeletions, 1);
  assert.match(deleted.issue, /暂不可用/);
  client.sync.readFailure = null;
  assert.equal((await client.dispatch({ type: "sync" })).pending, 0);
});

test("local persistence failure rejects the operation and does not publish unsaved data", async () => {
  const client = device("device-a");
  await client.dispatch({ type: "list" });
  client.local.failure = "disk full";
  await assert.rejects(client.dispatch({ type: "add", word: "apple" }), /本地保存失败/);
  assert.equal(Object.keys(client.sync.data).length, 0);
  client.local.failure = null;
  assert.equal((await client.dispatch({ type: "list" })).entries.length, 0);
});

test("stale editor does not silently overwrite a newly received edit", async () => {
  const client = device("device-a");
  const original = await client.dispatch({ type: "add", word: "apple" });
  await client.dispatch({ type: "edit", word: "apple", definition: "新释义" });
  await assert.rejects(client.dispatch({ type: "edit", word: "apple", definition: "旧窗口修改", expected: original.entries[0].revision }), /更新/);
});

test("clearing an override restores dictionary mode and oversized definitions fail without mutation", async () => {
  const client = device("device-a");
  await client.dispatch({ type: "add", word: "apple" });
  await client.dispatch({ type: "edit", word: "apple", definition: "苹果" });
  await assert.rejects(client.dispatch({ type: "edit", word: "apple", definition: "长".repeat(1001) }), /最多/);
  assert.equal((await client.dispatch({ type: "list" })).entries[0].customDefinition, "苹果");
  assert.equal((await client.dispatch({ type: "edit", word: "apple", definition: " " })).entries[0].customDefinition, null);
});

test("unchanged list requests do not trigger sync or local write loops", async () => {
  const client = device("device-a");
  await client.dispatch({ type: "add", word: "apple" });
  const writes = [client.local.writes, client.sync.writes];
  for (let iteration = 0; iteration < 10; iteration++) await client.dispatch({ type: "list" });
  assert.deepEqual([client.local.writes, client.sync.writes], writes);
});

test("simultaneous event handlers are serialized and retain every collection", async () => {
  const client = device("device-a");
  await Promise.all(["apple", "banana", "pear", "orange", "run", "running"].map(word => client.dispatch({ type: "add", word })));
  assert.equal((await client.dispatch({ type: "list" })).entries.length, 6);
});

test("unknown local schema is preserved instead of silently reset", async () => {
  const local = memoryArea({ notebook: { version: 99, data: "future" } });
  const client = device("device-a", { local });
  await assert.rejects(client.dispatch({ type: "list" }), /版本/);
  assert.equal(local.writes, 0);
});

test("invalid local records remain protected on repeated requests", async () => {
  const local = memoryArea({ notebook: { version: 1, actor: "device-a", clock: 100, records: { apple: ["broken"] } } });
  const client = device("device-a", { local });
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(client.dispatch({ type: "add", word: "pear" }), /损坏/);
  assert.equal(local.writes, 0);
  assert.deepEqual(local.data.notebook.records, { apple: ["broken"] });
});
