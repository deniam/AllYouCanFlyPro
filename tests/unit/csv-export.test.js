import { describe, expect, it } from "vitest";
import { escapeTabularCell } from "../../src/ui/csv-export.js";

describe("tabular export escaping", () => {
  it("escapes quotes while preserving Unicode, tabs and newlines inside a quoted cell", () => {
    expect(escapeTabularCell('Łódź\t"city"\nnext'))
      .toBe('"Łódź\t""city""\nnext"');
  });
});
