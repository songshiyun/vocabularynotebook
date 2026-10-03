import { mkdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

execFileSync(process.execPath, ["scripts/check.mjs"], { stdio: "inherit" });
await mkdir("artifacts", { recursive: true });
const destination = resolve("artifacts/wordkeep-1.0.0.zip");
execFileSync("zip", ["-q", "-r", "-FS", destination, "extension", "README.md", "docs"], { stdio: "inherit" });
console.log(`${destination} (${((await stat(destination)).size / 1024 / 1024).toFixed(2)} MB)`);
