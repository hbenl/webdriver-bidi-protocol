import { readFileSync, writeFileSync } from "node:fs";
import { merge } from "./cddl-merge.ts";

let merged = merge(readFileSync("specs/webdriver-bidi/all.cddl", "utf8"), readFileSync("moz/Fields.cddl", "utf8"));
merged += readFileSync("moz/Commands.cddl", "utf8");
merged += readFileSync("moz/Debugging.cddl", "utf8");
merged += readFileSync("moz/Profiler.cddl", "utf8");
writeFileSync("moz/merged.cddl", merged);
