import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ["contextMenus", "storage", "alarms"]);
assert.equal(manifest.host_permissions, undefined);
for (const path of [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons)]) await access(join("extension", path));
const hash = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
const extensionId = [...hash].map(character => String.fromCharCode(97 + parseInt(character, 16))).join("");
let count = 0;
let dictionaryWords = 0;
for (const directory of ["extension", "scripts", "tests"]) {
  for await (const path of files(directory)) {
    if (/\.(?:js|mjs)$/.test(path)) { execFileSync(process.execPath, ["--check", path], { stdio: "pipe" }); count++; }
    if (path.startsWith("extension/dictionary/") && path.endsWith(".json") && !path.endsWith("metadata.json")) dictionaryWords += Object.keys(JSON.parse(await readFile(path, "utf8"))).length;
  }
}
const metadata = JSON.parse(await readFile("extension/dictionary/metadata.json", "utf8"));
assert.equal(dictionaryWords, metadata.words);
assert.ok(dictionaryWords > 300000);
await access("extension/dictionary/ECDICT-LICENSE.txt");
console.log(`Checked ${count} JavaScript files, manifest, icons, license and ${dictionaryWords} dictionary words.`);
console.log(`Fixed extension ID: ${extensionId}`);
