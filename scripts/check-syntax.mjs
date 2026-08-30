import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function javascriptFiles(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    if (name === "libs" || name === "data") return [];
    return statSync(path).isDirectory() ? javascriptFiles(path) : path.endsWith(".js") ? [path] : [];
  });
}

const files = [...javascriptFiles("src"), ...javascriptFiles("tests")];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}
console.log(`Syntax OK: ${files.length} JavaScript files`);
