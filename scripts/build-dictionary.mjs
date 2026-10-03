import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { normalizeWord } from "../extension/core/model.js";

const revision = "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b";
const base = `https://raw.githubusercontent.com/skywind3000/ECDICT/${revision}`;
await mkdir(".cache", { recursive: true });
await mkdir("extension/dictionary", { recursive: true });

async function source(name, cacheName) {
  const path = resolve(".cache", cacheName);
  try { await readFile(path); }
  catch {
    const response = await fetch(`${base}/${name}`);
    if (!response.ok) throw new Error(`下载词库失败：${response.status}`);
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
  }
  return path;
}

async function* csvRows(path) {
  let row = [];
  let field = "";
  let quoted = false;
  let quotePending = false;
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    for (const character of chunk) {
      if (quotePending) {
        quotePending = false;
        if (character === '"') { field += '"'; continue; }
        quoted = false;
      }
      if (quoted) {
        if (character === '"') quotePending = true;
        else field += character;
      } else if (character === '"' && !field) quoted = true;
      else if (character === ",") { row.push(field); field = ""; }
      else if (character === "\n") {
        row.push(field.replace(/\r$/, ""));
        yield row;
        row = [];
        field = "";
      } else field += character;
    }
  }
  if (field || row.length) yield [...row, field.replace(/\r$/, "")];
}

const path = await source("ecdict.csv", "ecdict.csv");
const license = await source("LICENSE", "ECDICT-LICENSE");
const digest = createHash("sha256").update(await readFile(path)).digest("hex");
if (digest !== "1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf") throw new Error("ECDICT 源文件校验失败，请重新下载固定版本的完整文件。");
const shards = new Map();
const alphabet = "abcdefghijklmnopqrstuvwxyz";
for (const first of alphabet) {
  for (const second of `${alphabet}_'-`) shards.set(first + second, Object.create(null));
}
let headers;
let count = 0;
for await (const row of csvRows(path)) {
  if (!headers) { headers = row; continue; }
  let word;
  try { word = normalizeWord(row[headers.indexOf("word")]); } catch { continue; }
  const translation = row[headers.indexOf("translation")]?.replaceAll("\\n", "\n").trim();
  if (!translation) continue;
  const shard = shards.get(word.slice(0, 2).padEnd(2, "_"));
  if (Object.hasOwn(shard, word)) continue;
  shard[word] = translation;
  count++;
}
let size = 0;
for (const [name, words] of shards) {
  const data = JSON.stringify(Object.fromEntries(Object.entries(words).sort(([left], [right]) => left.localeCompare(right))));
  await writeFile(`extension/dictionary/${name}.json`, data);
  size += Buffer.byteLength(data);
}
await writeFile("extension/dictionary/ECDICT-LICENSE.txt", await readFile(license));
const metadata = { source: "https://github.com/skywind3000/ECDICT", revision, sourceSha256: digest, words: count, shards: shards.size, bytes: size, format: "lowercase English words mapped to Chinese definitions; phrases excluded" };
await writeFile("extension/dictionary/metadata.json", `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify(metadata, null, 2));
