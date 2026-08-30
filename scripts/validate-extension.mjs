import { existsSync, readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const html = readFileSync("index.html", "utf8");
const errors = [];

const requiredFiles = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...manifest.content_scripts.flatMap(script => script.js ?? []),
  ...manifest.content_scripts.flatMap(script => script.css ?? []),
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {})
].filter(Boolean);

for (const path of requiredFiles) {
  if (!existsSync(path)) errors.push(`Manifest path does not exist: ${path}`);
}

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
if (duplicates.length) errors.push(`Duplicate HTML ids: ${duplicates.join(", ")}`);

for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
  if (/^https?:/i.test(match[1])) errors.push(`Remote executable script: ${match[1]}`);
  else if (!existsSync(match[1].replace(/^\.\//, ""))) errors.push(`HTML script does not exist: ${match[1]}`);
}

for (const match of html.matchAll(/<link[^>]+href="([^"]+)"/g)) {
  if (!/^https?:/i.test(match[1]) && !existsSync(match[1].replace(/^\.\//, ""))) {
    errors.push(`HTML asset does not exist: ${match[1]}`);
  }
}

if (manifest.manifest_version !== 3) errors.push("Only Manifest V3 is supported");
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
console.log(`Extension validation OK: ${requiredFiles.length} manifest assets, ${ids.length} unique HTML ids`);
