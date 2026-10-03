import test from "node:test";
import assert from "node:assert/strict";
import { bucketFor, bytesFor, LIMITS, mergeRecord, normalizeWord, planSync, readBuckets } from "../extension/core/model.js";

test("normalization preserves inflections and rejects phrases, markup, digits and oversized words", () => {
  assert.equal(normalizeWord(" Apple "), "apple");
  assert.equal(normalizeWord("running"), "running");
  assert.equal(normalizeWord("DON’T"), "don't");
  assert.equal(normalizeWord("well-known"), "well-known");
  for (const word of ["", "look forward to", "中文", "<script>", "abc123", "a".repeat(65), null]) assert.throws(() => normalizeWord(word));
});

test("merge is associative, commutative and idempotent, including deletions and intentional recollection", () => {
  const records = [
    ["", 100, 100, "a", null, 0], ["", 90, 120, "b", "释义", 0],
    ["", 110, 120, "c", "另一个", 0], ["", 95, 101, "a", null, 1],
    ["", 100, 150, "b", null, 1], ["200.a", 200, 210, "a", null, 0],
    ["200.b", 200, 230, "b", null, 0], ["200.b", 200, 240, "a", null, 1],
  ];
  for (const left of records) {
    assert.deepEqual(mergeRecord(left, left), left);
    for (const right of records) {
      assert.deepEqual(mergeRecord(left, right), mergeRecord(right, left));
      for (const third of records) assert.deepEqual(mergeRecord(mergeRecord(left, right), third), mergeRecord(left, mergeRecord(right, third)));
    }
  }
});

test("delete wins over a later edit, but an explicit recollection creates a new generation", () => {
  const deleted = ["", 100, 200, "a", null, 1];
  const edited = ["", 100, 900, "b", "旧设备编辑", 0];
  assert.equal(mergeRecord(deleted, edited)[5], 1);
  const restored = ["1000.a", 1000, 1000, "a", null, 0];
  assert.deepEqual(mergeRecord(deleted, restored), restored);
});

test("remote input is validated and cannot insert records into the wrong shard", () => {
  const record = ["", 100, 100, "a", null, 0];
  const result = readBuckets({ [bucketFor("apple")]: { apple: record, banana: record, "not a word": record, apricot: [] }, unrelated: { apple: record } });
  assert.deepEqual(Object.keys(result), ["apple"]);
});

test("quota planning keeps existing data, considers UTF-8 bytes and respects all Chrome limits", () => {
  const existing = ["", 100, 100, "a", "苹果".repeat(20), 0];
  const remote = { [bucketFor("apple")]: { apple: existing }, foreign: "reserved" };
  const records = { apple: existing, banana: ["", 200, 200, "a", "香蕉".repeat(100), 0], pear: ["", 300, 300, "a", null, 0] };
  const initialSize = Object.entries(remote).reduce((total, [key, value]) => total + bytesFor(key, value), 0);
  const result = planSync(records, remote, { total: initialSize + 120, item: 8192, items: 512 });
  assert.equal(result.values.foreign, "reserved");
  assert.deepEqual(readBuckets(result.values).apple, existing);
  assert.ok(readBuckets(result.values).pear);
  assert.equal(readBuckets(result.values).banana, undefined);
  assert.ok(result.totalBytes <= initialSize + 120);
  assert.ok(bytesFor("word", "中文") > "word".length + JSON.stringify("中文").length);
  assert.equal(Object.keys(planSync({ banana: records.banana }, {}, { ...LIMITS, item: 100 }).writes).length, 0);
  assert.equal(Object.keys(planSync({ pear: records.pear }, { foreign: true }, { ...LIMITS, items: 1 }).writes).length, 0);
});

test("deletions release manual-definition space before pending words are planned", () => {
  const remote = { [bucketFor("apple")]: { apple: ["", 100, 100, "a", "苹".repeat(100), 0] } };
  const records = { apple: ["", 100, 200, "a", null, 1], banana: ["", 150, 150, "a", null, 0] };
  const result = planSync(records, remote, { ...LIMITS, total: 200 });
  assert.equal(readBuckets(result.values).apple[5], 1);
  assert.ok(readBuckets(result.values).banana);
});
