import { test } from "node:test";
import assert from "node:assert/strict";
import { isTestAttribute, locateRustTests, modulePrefix, parseCargoList, rustTestsIn } from "../src/cargo.ts";

test("parseCargoList takes the test lines and nothing else", () => {
  const out = `
tests::apply_discount::clamps_at_zero: test
tests::counts_items: test
some_bench: benchmark

counts_an_empty_slice: test
`;
  assert.deepEqual(parseCargoList(out), [
    "tests::apply_discount::clamps_at_zero",
    "tests::counts_items",
    "counts_an_empty_slice",
  ]);
});

test("modulePrefix follows Rust's file-to-module rules", () => {
  assert.deepEqual(modulePrefix("src/lib.rs"), []);
  assert.deepEqual(modulePrefix("src/main.rs"), []);
  assert.deepEqual(modulePrefix("src/cart.rs"), ["cart"]);
  assert.deepEqual(modulePrefix("src/cart/mod.rs"), ["cart"]);
  assert.deepEqual(modulePrefix("src/cart/discount.rs"), ["cart", "discount"]);
  // Each integration file is its own crate root, so it contributes no prefix.
  assert.deepEqual(modulePrefix("tests/integration.rs"), []);
});

test("isTestAttribute accepts the qualified spellings and refuses the rest", () => {
  assert.equal(isTestAttribute("#[test]"), true);
  assert.equal(isTestAttribute("#[tokio::test]"), true);
  assert.equal(isTestAttribute("#[async_std::test]"), true);
  assert.equal(isTestAttribute("#[cfg(test)]"), false);
  assert.equal(isTestAttribute("#[case(1)]"), false);
});

test("rustTestsIn reports each test's module path and line", () => {
  const src = `
#[cfg(test)]
mod tests {
    mod apply_discount {
        #[test]
        fn clamps_at_zero() {}
        #[tokio::test]
        async fn halves_the_total() {}
    }
    #[test]
    fn counts_items() {}
    fn not_a_test() {}
}
`;
  const found = rustTestsIn(src, "src/lib.rs");
  assert.deepEqual(
    [...found.keys()],
    ["tests::apply_discount::clamps_at_zero", "tests::apply_discount::halves_the_total", "tests::counts_items"],
  );
  assert.equal(found.get("tests::counts_items")!.line, 11);
  assert.equal(found.get("tests::counts_items")!.file, "src/lib.rs");
});

test("rustTestsIn prefixes by the file's own module path", () => {
  const src = "#[test]\nfn a() {}\n";
  assert.deepEqual([...rustTestsIn(src, "src/cart/discount.rs").keys()], ["cart::discount::a"]);
  assert.deepEqual([...rustTestsIn(src, "tests/integration.rs").keys()], ["a"]);
});

test("locateRustTests marks a name two crate roots define dynamic instead of pinning one", () => {
  const located = new Map([
    ["it_works", [{ file: "tests/a.rs", line: 2, endLine: 4 }, { file: "tests/b.rs", line: 2, endLine: 4 }]],
    ["only_here", [{ file: "tests/a.rs", line: 6, endLine: 8 }]],
  ]);
  const found = locateRustTests(["it_works", "only_here"], located);
  assert.deepEqual(found.map((t) => [t.titlePath.join("::"), t.dynamic, t.line]), [
    ["it_works", true, 0],
    ["only_here", false, 6],
  ]);
});
