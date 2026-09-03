import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const temporaryDirectory = mkdtempSync(join(tmpdir(), "aycf-tailwind-"));
const generatedPath = join(temporaryDirectory, "tailwind.generated.css");
const cliPath = join(root, "node_modules/@tailwindcss/cli/dist/index.mjs");
try {
  const result = spawnSync(process.execPath, [
    cliPath,
    "-i", "./src/styles/tailwind.css",
    "-o", generatedPath,
    "--minify"
  ], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "Tailwind CSS build failed\n");
    process.exit(result.status ?? 1);
  }
  const expected = readFileSync(join(root, "assets/css/tailwind.generated.css"), "utf8");
  const actual = readFileSync(generatedPath, "utf8");
  if (expected !== actual) {
    console.error("Generated Tailwind CSS is stale. Run npm run build:css.");
    process.exit(1);
  }
  console.log("Generated Tailwind CSS is up to date");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
