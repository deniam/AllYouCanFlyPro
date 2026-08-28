import { downloadBlob } from "./dom.js";

export function escapeTabularCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function downloadTabSeparatedFile(rows, fileName) {
  const content = `\uFEFF${rows.map(row => row.join("\t")).join("\n")}`;
  downloadBlob(new Blob([content], { type: "text/csv;charset=utf-8" }), fileName);
}
