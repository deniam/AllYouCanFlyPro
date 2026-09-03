import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  PASS_ID,
  dynamicUrlScript
} from "../fixtures/content-scripts.js";

const context = vm.createContext({});
vm.runInContext(readFileSync("src/content-parsers.js", "utf8"), context);
const parsers = context.AYCFContentParsers;

describe("Multipass content parsers", () => {
  it("extracts the pass id only from relevant script nodes", () => {
    expect(parsers.findDynamicUrl(["const pass_id = 'wrong';", dynamicUrlScript]))
      .toBe(`https://multipass.wizzair.com/w6/subscriptions/json/availability/${PASS_ID}`);
  });
});
