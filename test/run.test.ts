import { test } from "node:test";
import assert from "node:assert/strict";
import { collect, score, replay, pickFramework, run, smallSelection } from "../src/run.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskClient } from "../src/jev.ts";
import { testId } from "../src/types.ts";
import type { TestCase } from "../src/types.ts";
import { gitEnv } from "./git-env.ts";

function mk(file: string, path: string[], over: Partial<TestCase> = {}): TestCase {
  return { file, titlePath: path, line: 1, endLine: 2, framework: "vitest", dynamic: false, ...over };
}

function client(answers: Record<string, unknown>): AskClient {
  return {
    model: "jev-latest",
    servedModel: "jev-latest",
    spent: { calls: 1, inputTokens: 1, outputTokens: 0, ms: 1, retried: 0, rateLimited: 0, tokensPerSecond: 1, splits: 0, usd: 0 },
    askSplitting: async () => ({ answers, usage: { input_tokens: 1 } }),
  };
}

test("pickFramework returns the single framework present", () => {
  assert.equal(pickFramework([mk("a.test.ts", ["x"])]), "vitest");
});

test("pickFramework throws when the set is mixed", () => {
  const tests = [mk("a.test.ts", ["x"]), mk("e2e/a.spec.ts", ["y"], { framework: "playwright" })];
  assert.throws(() => pickFramework(tests), /vitest.*playwright|playwright.*vitest/);
});

test("pickFramework treats unknown as its own framework and still throws on a mix", () => {
  const tests = [mk("a.test.ts", ["x"]), mk("b.test.ts", ["y"], { framework: "unknown" })];
  assert.throws(() => pickFramework(tests), /--format/);
});

test("score asks one question per test and reads the answers back by index", async () => {
  const tests = [mk("a.test.ts", ["hot"]), mk("a.test.ts", ["cold"], { line: 9 })];
  const answers = await score(tests, { reviewing: "a git diff", changed_files: [], stat: "", diff: "", truncated: false, omitted_files: [] }, {
    client: client({ q0000: { score: 3, confidence: 0.9 }, q0001: { score: 0, confidence: 0.9 } }),
  });
  assert.deepEqual(answers.get("q0000"), { value: 3, confidence: 0.9 });
  assert.deepEqual(answers.get("q0001"), { value: 0, confidence: 0.9 });
});

test("score leaves an unanswered question null rather than inventing a zero", async () => {
  const tests = [mk("a.test.ts", ["hot"]), mk("a.test.ts", ["lost"], { line: 9 })];
  const answers = await score(tests, { reviewing: "a git diff", changed_files: [], stat: "", diff: "", truncated: false, omitted_files: [] }, {
    client: client({ q0000: { score: 3, confidence: 0.9 } }),
  });
  assert.equal(answers.get("q0001"), null);
});

test("collect pairs each test with whether the diff touched it", () => {
  const edited = mk("a.test.ts", ["edited"], { line: 10, endLine: 20 });
  const untouched = mk("a.test.ts", ["untouched"], { line: 40, endLine: 44 });
  const ranges = new Map([["a.test.ts", [[12, 13]] as Array<[number, number]>]]);
  // Which one, not how many: a `collect` that returned the wrong test would
  // satisfy a size check and quietly run the wrong half of the suite.
  assert.deepEqual([...collect([edited, untouched], ranges)], [testId(edited)]);
});

test("replay re-gates a record without a client", () => {
  const tests = [mk("a.test.ts", ["hot"]), mk("a.test.ts", ["mild"], { line: 9 })];
  const record = {
    version: 1 as const,
    createdAt: "2026-09-21T00:00:00.000Z",
    base: null,
    framework: "vitest" as const,
    tests,
    touched: [],
    answers: { q0000: { value: 3, confidence: 0.9 }, q0001: { value: 1.5, confidence: 0.9 } },
    fallback: null,
  };
  assert.deepEqual(replay(record, { cutoff: 2.0 }).selected.map((t) => t.titlePath[0]), ["hot"]);
  assert.deepEqual(replay(record, { cutoff: 1.0 }).selected.map((t) => t.titlePath[0]), ["hot", "mild"]);
});

test("Playwright の一覧取得に失敗したら絞り込まず全件を実行する", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-playwright-fallback-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd, env: gitEnv(), env: gitEnv() });
    execFileSync("git", ["-c", "user.name=Eval", "-c", "user.email=eval@example.com", "commit", "-q", "--allow-empty", "-m", "initial"], { cwd, env: gitEnv(), env: gitEnv() });
    const res = await run({ cwd, format: "playwright", playwrightCommand: ["/missing/playwright"], dryRun: true });
    assert.equal(res.filter.mode, "all");
    assert.match(res.selection.fallback!, /Playwright test listing failed/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("score takes from a response only the answers its own request asked", async () => {
  const tests = [mk("a.test.ts", ["a"]), mk("a.test.ts", ["b"], { line: 3, endLine: 4 })];
  const c: AskClient = {
    ...client({}),
    // The first batch's response also answers the second batch's question.
    askSplitting: async (_state, questions) => Object.keys(questions).includes("q0000")
      ? { answers: { q0000: { score: 3, confidence: 0.9 }, q0001: { score: 0, confidence: 0.9 } } }
      : { answers: {} },
  };
  const answers = await score(tests, { reviewing: "a git diff", changed_files: [], stat: "", diff: "", truncated: false, omitted_files: [] }, {
    client: c, batchSize: 1, concurrency: 1,
  });
  assert.equal(answers.get("q0000")?.value, 3);
  assert.equal(answers.get("q0001"), null);
});

test("smallSelection counts only the tests the model's answers decided", () => {
  const verdict = (reason: string, selected: boolean, i: number) =>
    ({ id: `q${i}`, test: mk("a.test.ts", [`t${i}`], { line: i * 2 + 1, endLine: i * 2 + 2 }), answer: null, reason, selected }) as never;
  // Ten untouched tests all deselected, padded by ten touched new tests.
  const verdicts = [
    ...Array.from({ length: 10 }, (_, i) => verdict("below", false, i)),
    ...Array.from({ length: 10 }, (_, i) => verdict("touched", true, i + 10)),
    verdict("dynamic", true, 20),
    verdict("quarantined", false, 21),
  ];
  const selection = { verdicts, selected: [], all: [], fallback: null };
  assert.equal(smallSelection(selection), true);
  // Nothing left for the answers to decide: not small.
  assert.equal(smallSelection({ ...selection, verdicts: verdicts.slice(10) }), false);
});
