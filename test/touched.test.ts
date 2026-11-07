/**
 * The touched rule end to end: a test whose own body the change edits is
 * selected without asking, however git spells or shapes that edit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDiff, splitDiffByFile } from "../src/diff.ts";
import { run } from "../src/run.ts";
import type { AskClient } from "../src/jev.ts";
import { gitEnv } from "./git-env.ts";

/** Every question scored 0: only the deterministic rules select anything. */
const zero: AskClient = {
  model: "jev-latest",
  servedModel: "jev-latest",
  spent: { calls: 1, inputTokens: 1, outputTokens: 0, ms: 1, retried: 0, rateLimited: 0, tokensPerSecond: 1, splits: 0, usd: 0 },
  askSplitting: async (_state, questions) => ({
    answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { score: 0, confidence: 0.9 }])),
    usage: { input_tokens: 1 },
  }),
};

const AUTH = `import { describe, it } from "vitest";

describe("auth", () => {
  it("rejects a bad password", () => {
    const a = 1;
    const b = 2;
    if (a + b !== 3) throw new Error("x");
  });
  it("other", () => {});
});
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Eval", "-c", "user.email=eval@example.com", ...args], { cwd, encoding: "utf8", env: gitEnv() });
}

/** A repository with `files` committed, then `edit` applied and committed on top. */
function repo(files: Record<string, string>, edit: (cwd: string) => void): { cwd: string; done: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "jev-touched-"));
  git(cwd, "init", "-q");
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "one");
  edit(cwd);
  git(cwd, "commit", "-q", "-am", "two");
  return { cwd, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

function rewrite(cwd: string, file: string, from: string, to: string): void {
  const path = join(cwd, file);
  writeFileSync(path, readFileSync(path, "utf8").replace(from, to));
}

async function reasons(cwd: string): Promise<Record<string, string>> {
  const res = await run({ cwd, base: "HEAD~1", client: zero, format: "vitest" });
  return Object.fromEntries(res.selection.verdicts.map((v) => [v.test.titlePath.at(-1)!, v.reason]));
}

test("a .gitattributes -diff does not hide an edited test from the touched rule", async () => {
  const r = repo({ ".gitattributes": "*.ts -diff\n.gitattributes -diff\n", "auth.test.ts": AUTH }, (cwd) =>
    rewrite(cwd, "auth.test.ts", "const a = 1;", "const a = 0;"));
  try {
    const diff = await loadDiff({ cwd: r.cwd, base: "HEAD~1" });
    // The bytes stay out of the state, but the file is still named in it.
    assert.match(diff.text, /^Binary files/m);
    assert.deepEqual([...splitDiffByFile(diff.text).keys()], ["auth.test.ts"]);
    // No hunk says which lines changed, so every test in the file is touched.
    assert.deepEqual(await reasons(r.cwd), { "rejects a bad password": "touched", other: "touched" });
  } finally {
    r.done();
  }
});

test("a test file whose path git would quote is still touched", async () => {
  const r = repo({ "tést.test.ts": AUTH }, (cwd) => rewrite(cwd, "tést.test.ts", "const a = 1;", "const a = 0;"));
  try {
    assert.deepEqual([...(await loadDiff({ cwd: r.cwd, base: "HEAD~1" })).ranges.keys()], ["tést.test.ts"]);
    assert.deepEqual(await reasons(r.cwd), { "rejects a bad password": "touched", other: "below" });
  } finally {
    r.done();
  }
});

test("lines deleted from a test body touch that test", async () => {
  const r = repo({ "auth.test.ts": AUTH }, (cwd) => rewrite(cwd, "auth.test.ts", "    const b = 2;\n", ""));
  try {
    assert.deepEqual(await reasons(r.cwd), { "rejects a bad password": "touched", other: "below" });
  } finally {
    r.done();
  }
});

test("running from a subdirectory still marks the edited test touched", async () => {
  const r = repo({ "packages/pkg/test/auth.test.ts": AUTH, "test/auth.test.ts": AUTH }, (cwd) =>
    rewrite(cwd, "packages/pkg/test/auth.test.ts", "const a = 1;", "const a = 0;"));
  try {
    const sub = join(r.cwd, "packages/pkg");
    assert.deepEqual([...(await loadDiff({ cwd: sub, base: "HEAD~1" })).ranges.keys()], ["test/auth.test.ts"]);
    assert.deepEqual(await reasons(sub), { "rejects a bad password": "touched", other: "below" });
    // From the root the same-named file outside the package is not the one edited.
    const root = await run({ cwd: r.cwd, base: "HEAD~1", client: zero, format: "vitest" });
    const touched = root.selection.verdicts.filter((v) => v.reason === "touched").map((v) => v.test.file);
    assert.deepEqual(touched, ["packages/pkg/test/auth.test.ts"]);
  } finally {
    r.done();
  }
});

test("a user's diff.relative does not break the subdirectory re-keying", async () => {
  const r = repo({ "packages/pkg/test/auth.test.ts": AUTH }, (cwd) =>
    rewrite(cwd, "packages/pkg/test/auth.test.ts", "const a = 1;", "const a = 0;"));
  try {
    git(r.cwd, "config", "diff.relative", "true");
    const sub = join(r.cwd, "packages/pkg");
    assert.deepEqual([...(await loadDiff({ cwd: sub, base: "HEAD~1" })).ranges.keys()], ["test/auth.test.ts"]);
  } finally {
    r.done();
  }
});

test("a base spelled like an option is refused before git sees it", async () => {
  await assert.rejects(loadDiff({ cwd: tmpdir(), base: "--output=/tmp/x" }), /invalid base ref/);
});

test("--exec does not pass the API key to the runner", () => {
  const r = repo({ "auth.test.ts": AUTH }, (cwd) => rewrite(cwd, "auth.test.ts", "const a = 1;", "const a = 0;"));
  try {
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const res = spawnSync(process.execPath, [
      cli, "--base", "HEAD~1", "--dry-run", "--format", "vitest", "--exec", "--",
      process.execPath, "-e", "process.stdout.write(`key=${process.env.TYPESAFE_API_KEY}/${process.env.TYPESAFEAI_API_KEY}`)",
    ], { cwd: r.cwd, encoding: "utf8", env: { ...gitEnv(), TYPESAFE_API_KEY: "dummy-key", TYPESAFEAI_API_KEY: "dummy-key-2" } });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "key=undefined/undefined");
  } finally {
    r.done();
  }
});
