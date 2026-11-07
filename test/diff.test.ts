import { test } from "node:test";
import assert from "node:assert/strict";
import { binaryFiles, parseUnifiedDiff, rebaseRanges, touchesChange, splitDiffByFile, unquotePath } from "../src/diff.ts";

const DIFF = [
  "diff --git a/src/cart.ts b/src/cart.ts",
  "--- a/src/cart.ts",
  "+++ b/src/cart.ts",
  "@@ -10,0 +11,3 @@",
  "+  const a = 1;",
  "+  const b = 2;",
  "+  const c = 3;",
  "@@ -30,2 +34,1 @@",
  "-  old();",
  "-  old();",
  "+  fresh();",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,4 +0,0 @@",
  "-  everything();",
].join("\n");

test("parseUnifiedDiff reads post-image ranges per file", () => {
  const ranges = parseUnifiedDiff(DIFF);
  assert.deepEqual(ranges.get("src/cart.ts"), [[11, 13], [34, 34]]);
});

test("parseUnifiedDiff drops a file that is only deleted", () => {
  assert.equal(parseUnifiedDiff(DIFF).has("src/gone.ts"), false);
});

test("parseUnifiedDiff merges adjacent hunks", () => {
  const d = "+++ b/a.ts\n@@ -1,1 +1,2 @@\n@@ -5,1 +3,1 @@\n";
  assert.deepEqual(parseUnifiedDiff(d).get("a.ts"), [[1, 3]]);
});

test("parseUnifiedDiff strips a mnemonic prefix", () => {
  const d = "+++ w/a.ts\n@@ -1,1 +7,1 @@\n";
  assert.deepEqual(parseUnifiedDiff(d).get("a.ts"), [[7, 7]]);
});

test("touchesChange is true when the test's range overlaps a hunk", () => {
  const ranges = parseUnifiedDiff(DIFF);
  assert.equal(touchesChange(ranges, "src/cart.ts", 9, 12), true);
  assert.equal(touchesChange(ranges, "src/cart.ts", 1, 9), false);
  assert.equal(touchesChange(ranges, "src/other.ts", 11, 13), false);
});

test("parseUnifiedDiff is not fooled by an added line that looks like a header", () => {
  const d = ["diff --git a/a.cc b/a.cc", "--- a/a.cc", "+++ b/a.cc", "@@ -1,0 +5,1 @@", "+++ x;"].join("\n");
  const ranges = parseUnifiedDiff(d);
  assert.deepEqual(ranges.get("a.cc"), [[5, 5]]);
  assert.equal(ranges.has("x;"), false);
});

test("splitDiffByFile keeps each file's own section", () => {
  const parts = splitDiffByFile(DIFF);
  assert.deepEqual([...parts.keys()], ["src/cart.ts", "src/gone.ts"]);
  assert.match(parts.get("src/cart.ts")!, /fresh\(\)/);
  assert.equal(parts.get("src/cart.ts")!.includes("everything()"), false);
});

test("unquotePath decodes git's C-quoted spelling", () => {
  assert.equal(unquotePath('"b/t\\303\\251st.test.ts"'), "b/tést.test.ts");
  assert.equal(unquotePath('"b/a\\"q\\\\b\\tc.ts"'), 'b/a"q\\b\tc.ts');
  assert.equal(unquotePath("b/plain.ts"), "b/plain.ts");
});

test("parseUnifiedDiff and splitDiffByFile unquote a quoted header", () => {
  const d = [
    'diff --git "a/t\\303\\251st.test.ts" "b/t\\303\\251st.test.ts"',
    '--- "a/t\\303\\251st.test.ts"',
    '+++ "b/t\\303\\251st.test.ts"',
    "@@ -3,1 +3,1 @@",
    "-a",
    "+b",
  ].join("\n");
  assert.deepEqual([...parseUnifiedDiff(d).keys()], ["tést.test.ts"]);
  assert.deepEqual([...splitDiffByFile(d).keys()], ["tést.test.ts"]);
});

test("parseUnifiedDiff records a pure deletion as the boundary it sits on", () => {
  const d = "+++ b/a.ts\n@@ -5,2 +4,0 @@\n-x\n-y\n";
  const ranges = parseUnifiedDiff(d);
  assert.deepEqual(ranges.get("a.ts"), [[4, 5]]);
  // A test spanning lines 3-7 had lines removed from its body.
  assert.equal(touchesChange(ranges, "a.ts", 3, 7), true);
  assert.equal(touchesChange(ranges, "a.ts", 8, 9), false);
});

test("parseUnifiedDiff clamps a deletion at the top of the file to line 1", () => {
  assert.deepEqual(parseUnifiedDiff("+++ b/a.ts\n@@ -1,2 +0,0 @@\n-x\n-y\n").get("a.ts"), [[1, 1]]);
});

test("rebaseRanges re-keys to the subdirectory and drops files outside it", () => {
  const ranges = new Map<string, Array<[number, number]>>([
    ["packages/pkg/test/a.test.ts", [[1, 2]]],
    ["test/a.test.ts", [[3, 4]]],
  ]);
  assert.deepEqual([...rebaseRanges(ranges, "packages/pkg/")], [["test/a.test.ts", [[1, 2]]]]);
  assert.equal(rebaseRanges(ranges, ""), ranges);
});

test("binaryFiles reads the binary entries of a NUL-separated numstat", () => {
  assert.deepEqual(binaryFiles("1\t0\ta.ts\0-\t-\tt\u00e9st.test.ts\0-\t-\twith space.png\0"), ["t\u00e9st.test.ts", "with space.png"]);
});

test("splitDiffByFile names a binary section by its diff --git line", () => {
  const d = "diff --git a/x y.png b/x y.png\nindex 1..2 100644\nBinary files a/x y.png and b/x y.png differ\n";
  assert.deepEqual([...splitDiffByFile(d).keys()], ["x y.png"]);
});
