// Diffs a fresh print computed-style snapshot (passed on stdin as JSON) against
// tests/.print-baseline.json. Exits 0 if identical, 1 if any property differs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(
  fs.readFileSync(path.join(here, ".print-baseline.json"), "utf8"),
);
const input = fs.readFileSync(0, "utf8");
const start = input.indexOf("{");
// The captured tool output may have trailing non-JSON content; find the
// matching closing brace by tracking depth so JSON.parse gets a clean slice.
let depth = 0;
let end = -1;
for (let i = start; i < input.length; i++) {
  const ch = input[i];
  if (ch === "{") depth++;
  else if (ch === "}") {
    depth--;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}
const current = JSON.parse(input.slice(start, end));

let diffs = 0;
const keys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
for (const sel of keys) {
  const a = baseline[sel];
  const b = current[sel];
  if (!a && !b) continue;
  if (!a || !b) {
    console.log(`SELECTOR PRESENCE CHANGED: ${sel} baseline=${!!a} current=${!!b}`);
    diffs++;
    continue;
  }
  const props = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const p of props) {
    if (a[p] !== b[p]) {
      console.log(`DIFF ${sel} .${p}: baseline="${a[p]}" current="${b[p]}"`);
      diffs++;
    }
  }
}
if (diffs === 0) {
  console.log("PRINT SNAPSHOT IDENTICAL TO BASELINE ✅");
  process.exit(0);
} else {
  console.log(`\n${diffs} difference(s) found ❌`);
  process.exit(1);
}
