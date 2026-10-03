import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Dictionary } from "../extension/core/dictionary.js";

test("real bundled dictionary covers common words, inflections and technical terms", async () => {
  const dictionary = new Dictionary({ load: async shard => JSON.parse(await readFile(new URL(`../extension/dictionary/${shard}.json`, import.meta.url), "utf8")) });
  for (const word of ["apple", "resilient", "running", "saw", "algorithm", "constructor"]) {
    const meaning = await dictionary.lookup(word);
    assert.match(meaning, /[\u3400-\u9fff]/, word);
  }
  assert.equal(await dictionary.lookup("zzzzzzzzzzzzzzzz"), null);
});

test("parallel lookups share one file request and a failed file can be retried", async () => {
  let requests = 0;
  const dictionary = new Dictionary({ load: async () => { requests++; await Promise.resolve(); return { apple: "苹果", apply: "应用" }; } });
  assert.deepEqual(await Promise.all([dictionary.lookup("apple"), dictionary.lookup("apply")]), ["苹果", "应用"]);
  assert.equal(requests, 1);
  let failed = true;
  const retrying = new Dictionary({ load: async () => { if (failed) throw new Error("missing file"); return { apple: "苹果" }; } });
  await assert.rejects(retrying.lookup("apple"), /missing/);
  failed = false;
  assert.equal(await retrying.lookup("apple"), "苹果");
});
