import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTests } from "../src/extract.ts";

const VITEST = `
import { describe, it, test } from "vitest";
describe("Cart", () => {
  describe("applyDiscount", () => {
    it("clamps at zero", () => {});
    it.skip("rounds half up", () => {});
  });
  test("totals", async () => {});
});
test("top level", () => {});
`;

test("extractTests reports the suite chain outermost first", () => {
  const found = extractTests(VITEST, "src/cart.test.ts", "vitest");
  const names = found.map((t) => t.titlePath.join(" > "));
  assert.deepEqual(names, [
    "Cart > applyDiscount > clamps at zero",
    "Cart > applyDiscount > rounds half up",
    "Cart > totals",
    "top level",
  ]);
});

test("extractTests carries the framework, the file and 1-based lines", () => {
  const found = extractTests(VITEST, "src/cart.test.ts", "vitest");
  const first = found[0]!;
  assert.equal(first.file, "src/cart.test.ts");
  assert.equal(first.framework, "vitest");
  assert.equal(first.line, 5);
  assert.equal(first.dynamic, false);
});

test("extractTests marks an interpolated title dynamic and keeps it", () => {
  const src = "import { it } from 'vitest';\nit(`case ${n}`, () => {});";
  const found = extractTests(src, "a.test.ts", "vitest");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.dynamic, true);
});

test("extractTests keeps a test whose title comes from a variable", () => {
  const src = 'import { test } from "bun:test";\ndescribe("Ref", () => { for (const row of rows) test(row.name, () => {}); });';
  const found = extractTests(src, "ref.test.ts", "bun");
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]!.titlePath, ["Ref", ""]);
  assert.equal(found[0]!.dynamic, true);
});

test("extractTests marks a variable suite title dynamic", () => {
  const src = 'import { test } from "bun:test";\ndescribe(suiteName, () => { test("works", () => {}); });';
  const found = extractTests(src, "ref.test.ts", "bun");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.dynamic, true);
});

test("extractTests marks an .each row dynamic", () => {
  const src = "import { it } from 'vitest';\nit.each([1,2])('adds %i', () => {});";
  const found = extractTests(src, "a.test.ts", "vitest");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.dynamic, true);
});

test("extractTests keeps .each cases when the table is returned by a call", () => {
  const src = 'import { test } from "bun:test";\ntest.each(testData())("$testName", async (row) => {});';
  const found = extractTests(src, "ref.test.ts", "bun");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.dynamic, true);
});

test("extractTests skips a todo with no body", () => {
  const src = "import { it } from 'vitest';\nit.todo('later');\nit('now', () => {});";
  const names = extractTests(src, "a.test.ts", "vitest").map((t) => t.titlePath.join(" > "));
  assert.deepEqual(names, ["now"]);
});

test("extractTests reads node:test subtests as a suite", () => {
  const src = `
import test from "node:test";
test("applyDiscount", async (t) => {
  await t.test("clamps", () => {});
});
`;
  const names = extractTests(src, "a.test.ts", "node").map((t) => t.titlePath.join(" | "));
  assert.deepEqual(names, ["applyDiscount | clamps"]);
});

test("extractTests reads Playwright's test.describe", () => {
  const src = `
import { test } from "@playwright/test";
test.describe("Login", () => {
  test("succeeds", async () => {});
});
`;
  const found = extractTests(src, "e2e/a.spec.ts", "playwright");
  assert.deepEqual(found.map((t) => t.titlePath), [["Login", "succeeds"]]);
  assert.equal(found[0]!.line, 4);
});

test("extractTests unescapes a quoted title", () => {
  const src = "import { it } from 'vitest';\nit('it\\'s fine', () => {});";
  const found = extractTests(src, "a.test.ts", "vitest");
  assert.deepEqual(found[0]!.titlePath, ["it's fine"]);
});

test("extractTests parses tsx", () => {
  const src = "import { it } from 'vitest';\nit('renders', () => { const x = <div/>; });";
  const found = extractTests(src, "a.test.tsx", "vitest");
  assert.deepEqual(found[0]!.titlePath, ["renders"]);
});

test("extractTests marks a concatenated title dynamic instead of reading its first string", () => {
  const src = "import { it } from 'vitest';\nconst role = 'x';\nit(\"rejects \" + \"admin bypass\", () => {});\nit('denies ' + role, () => {});";
  const found = extractTests(src, "a.test.ts", "vitest");
  assert.deepEqual(found.map((t) => t.dynamic), [true, true]);
});

test("extractTests marks a title with an escape it does not reproduce dynamic", () => {
  const src = "import { it } from 'vitest';\nit('handles\\ttab title', () => {});\nit('caf\\u00e9', () => {});";
  const found = extractTests(src, "a.test.ts", "vitest");
  assert.deepEqual(found.map((t) => t.dynamic), [true, true]);
});

test("extractTests marks every test inside a describe.each or describe.for suite dynamic", () => {
  const src = [
    "import { describe, it } from 'vitest';",
    "describe.each([1, 2])('suite %i', (n) => {",
    "  it('adds', () => {});",
    "});",
    "describe.for([1, 2])('for %i', (n) => {",
    "  it('adds', () => {});",
    "});",
    "describe.skipIf(false).each([1])('skip %i', (n) => {",
    "  it('adds', () => {});",
    "});",
    "describe('plain', () => {",
    "  it('adds', () => {});",
    "});",
  ].join("\n");
  const found = extractTests(src, "a.test.ts", "vitest");
  assert.deepEqual(found.map((t) => [t.titlePath[0], t.dynamic]), [
    ["suite %i", true],
    ["for %i", true],
    ["skip %i", true],
    ["plain", false],
  ]);
});

test("extractTests keeps a tagged-template describe.each suite in the chain and marks it dynamic", () => {
  const src = [
    "import { describe, it, test } from 'vitest';",
    "describe.each`",
    "  a    | b",
    "  ${1} | ${2}",
    "`('sum $a', ({ a, b }) => {",
    "  it('adds', () => {});",
    "});",
    "test.each`",
    "  a",
    "  ${1}",
    "`('row $a', ({ a }) => {});",
  ].join("\n");
  const found = extractTests(src, "a.test.ts", "vitest");
  assert.deepEqual(found.map((t) => [t.titlePath, t.dynamic]), [
    [["sum $a", "adds"], true],
    [["row $a"], true],
  ]);
});

test("extractTests keeps a title with an escaped backslash static", () => {
  const src = "import { it } from 'vitest';\nit('C:\\\\path', () => {});\nit('a\\\\n', () => {});";
  const found = extractTests(src, "a.test.ts", "vitest");
  assert.deepEqual(found.map((t) => [t.titlePath[0], t.dynamic]), [["C:\\path", false], ["a\\n", false]]);
});
