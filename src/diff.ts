/**
 * What the change touched.
 *
 * Two things come out of one `git diff`: the post-image line ranges, which
 * decide which tests are selected without asking, and the diff text itself,
 * which is the `state` every question is asked against.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Post-image line ranges per file, inclusive at both ends. */
export type ChangedRanges = Map<string, Array<[number, number]>>;

/** git's own prefixes, including the `diff.mnemonicPrefix` spellings. */
const PREFIX = /^[abciwo]\//;

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/**
 * Undo git's C-style path quoting.
 *
 * git wraps a path holding a double quote, a backslash, a control character
 * or -- unless `core.quotePath` is off -- any non-ASCII byte in double quotes,
 * with `\ooo` octal bytes and `\n`-style escapes inside. Left quoted, the
 * path matches no discovered file, and a test the change edited is no longer
 * recognised as touched.
 */
export function unquotePath(raw: string): string {
  const s = raw.trim();
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\" || i + 1 >= body.length) {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8) & 0xff);
      i += octal[0].length;
      continue;
    }
    const n = body[i + 1]!;
    bytes.push(...(C_ESCAPES[n] === undefined ? Buffer.from(n, "utf8") : [C_ESCAPES[n]!]));
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * The path of a `diff --git a/<p> b/<p>` line when both sides name the same
 * path, which is the only spelling that can be split unambiguously.
 */
function gitHeaderPath(line: string): string | null {
  const rest = line.slice("diff --git ".length);
  if ((rest.length - 5) % 2 !== 0 || rest.length < 7) return null;
  const n = (rest.length - 5) / 2;
  const a = rest.slice(0, n + 2);
  const b = rest.slice(n + 3);
  if (rest[n + 2] !== " " || !PREFIX.test(a) || !PREFIX.test(b) || a.slice(2) !== b.slice(2)) return null;
  return a.slice(2);
}

/** The repository path a `--- ` / `+++ ` header names, or null for /dev/null. */
function headerPath(line: string): string | null {
  const path = unquotePath(line.slice(4));
  return path === "/dev/null" ? null : path.replace(PREFIX, "");
}

/**
 * Parse the `@@ -a,b +c,d @@` headers of a unified diff.
 *
 * A file header is only read before the section's first hunk. Inside a hunk
 * every line carries an added or removed marker, so adding the C++ line
 * `++ x;` produces a body line spelled `+++ x;` -- indistinguishable from a
 * file header to anything that does not track where it is.
 */
export function parseUnifiedDiff(text: string): ChangedRanges {
  const byFile: ChangedRanges = new Map();
  let file: string | null = null;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      // A post-image of /dev/null is a deletion: nothing in the new tree
      // changed, so there is no line here a test's body can overlap. The
      // deletion still reaches the model, through `splitDiffByFile`.
      file = headerPath(line);
      if (file && !byFile.has(file)) byFile.set(file, []);
      continue;
    }
    if (!line.startsWith("@@")) continue;
    inHunk = true;
    if (!file) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    // A pure deletion has no post-image line of its own: it sits between
    // lines `start` and `start + 1`. Both are recorded, so lines removed from
    // inside a test body still touch that test (and a test ending at `start`
    // or beginning at `start + 1` is conservatively touched as well).
    if (count === 0) byFile.get(file)!.push([Math.max(start, 1), start + 1]);
    else byFile.get(file)!.push([start, start + count - 1]);
  }
  for (const [k, ranges] of byFile) {
    if (ranges.length === 0) byFile.delete(k);
    else byFile.set(k, merge(ranges));
  }
  return byFile;
}

function merge(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [sorted[0]!];
  for (const [s, e] of sorted.slice(1)) {
    const last = out.at(-1)!;
    if (s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Does `[line, endLine]` intersect any changed range for this file? */
export function touchesChange(ranges: ChangedRanges, file: string, line: number, endLine: number): boolean {
  const list = ranges.get(file);
  if (!list) return false;
  return list.some(([s, e]) => line <= e && endLine >= s);
}

/**
 * The diff cut into one section per file, keyed by post-image path -- or, for
 * a file the change deletes, by its pre-image path.
 *
 * This is where `parseUnifiedDiff` and this function deliberately part ways.
 * Ranges answer "which test bodies did the change touch", and a deleted file
 * has no post-image line any test body can sit on. Sections answer "what
 * should the model see", and deleting a source file is one of the changes
 * most likely to break a test -- dropping it would hide the change from the
 * judgment it matters most to.
 *
 * The state builder drops whole sections to fit its budget, and a section is
 * the smallest piece that still reads as a diff.
 */
export function splitDiffByFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split("\n");
  let buf: string[] = [];
  let post: string | null = null;
  let pre: string | null = null;
  let named: string | null = null;
  let inHunk = false;
  const flush = () => {
    // A section with no `---`/`+++` (binary, mode-only) is still a change
    // the model should see, named by its `diff --git` line.
    const key = post ?? pre ?? named;
    if (key && buf.length > 0) out.set(key, buf.join("\n"));
    buf = [];
    post = null;
    pre = null;
    named = null;
    inHunk = false;
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      named = gitHeaderPath(line);
      buf.push(line);
      continue;
    }
    buf.push(line);
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    // Headers only before the first hunk; see `parseUnifiedDiff`.
    if (inHunk) continue;
    if (line.startsWith("--- ")) pre = headerPath(line);
    else if (line.startsWith("+++ ")) post = headerPath(line);
  }
  flush();
  return out;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

export interface DiffOptions {
  cwd?: string;
  /** Compare against the merge base with this ref, the way a pull request does. */
  base?: string | null;
  staged?: boolean;
}

export interface Diff {
  /** The unified diff, zero context, for the `state`. */
  text: string;
  /** `git diff --stat`, which survives truncation of the text. */
  stat: string;
  /**
   * Ranges keyed by path relative to `cwd`, the way test discovery names
   * files. git prints repository-root-relative paths, so from a subdirectory
   * the two spellings differ; files outside `cwd` are left out here (no
   * discovered test can live there) but stay in `text` for the model.
   */
  ranges: ChangedRanges;
}

/** `git rev-parse --show-prefix`: where `cwd` sits inside the repository, `""` at its root. */
export async function repoPrefix(cwd: string): Promise<string> {
  return (await git(["rev-parse", "--show-prefix"], cwd)).trim();
}

/** Re-key root-relative ranges to paths relative to the directory at `prefix`. */
export function rebaseRanges(ranges: ChangedRanges, prefix: string): ChangedRanges {
  if (prefix === "") return ranges;
  const out: ChangedRanges = new Map();
  for (const [file, list] of ranges) {
    if (file.startsWith(prefix)) out.set(file.slice(prefix.length), list);
  }
  return out;
}

/**
 * The change under review.
 *
 * With `base`, `base...HEAD` -- commits that landed on the base branch
 * meanwhile are not this change's doing. Without it, the working tree against
 * HEAD, so a selection can be taken before anything is committed.
 *
 * The prefixes are pinned because a user's `diff.mnemonicPrefix` would
 * otherwise rename them and the parser's paths would match no file.
 */
export async function loadDiff({ cwd = process.cwd(), base = null, staged = false }: DiffOptions = {}): Promise<Diff> {
  // Deletions are NOT filtered out. `parseUnifiedDiff` already drops them
  // from the ranges, because a deleted file has no post-image line for a test
  // body to overlap; but removing a source file is exactly the kind of change
  // the model has to see, so it stays in the text.
  //
  // `--no-textconv` keeps a repository `diff=<driver>` attribute from running
  // a textconv over the text, and `--no-relative` keeps a user's
  // `diff.relative` from making the paths cwd-relative (`rebaseRanges`
  // expects them from the repository root). `core.quotePath=false` keeps
  // non-ASCII paths unquoted; `unquotePath` handles what git still quotes.
  //
  // A file git treats as binary -- by content, or because a repository
  // `.gitattributes` says `-diff`/`binary` -- is printed as "Binary files ...
  // differ" with no hunk, so nothing in it would count as touched. Its bytes
  // are not wanted in the state either, so instead of `--text` the binary
  // files are listed with `--numstat` and touched whole.
  const common = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/"];
  // A base spelled like an option would be read by git as one
  // (`--output=<file>` writes the diff elsewhere and leaves this run empty).
  if (base?.startsWith("-")) throw new Error(`invalid base ref: ${base}`);
  const range: string[] = [];
  if (staged) range.push("--cached");
  if (base) range.push(`${base}...HEAD`);
  else if (!staged) range.push("HEAD");

  const config = ["-c", "core.quotePath=false"];
  const text = await git([...config, "diff", "--unified=0", ...common, ...range], cwd);
  const stat = await git([...config, "diff", "--stat", ...common, ...range], cwd);
  const numstat = await git(["diff", "--numstat", "-z", "--no-renames", ...common, ...range], cwd);
  const ranges = parseUnifiedDiff(text);
  for (const file of binaryFiles(numstat)) ranges.set(file, [[1, Number.MAX_SAFE_INTEGER]]);
  return { text, stat, ranges: rebaseRanges(ranges, await repoPrefix(cwd)) };
}

/** The files `git diff --numstat -z --no-renames` reports as binary (`-\t-\t<path>`). */
export function binaryFiles(numstat: string): string[] {
  return numstat
    .split("\0")
    .filter((entry) => entry.startsWith("-\t-\t"))
    .map((entry) => entry.slice(4))
    .filter((file) => file !== "");
}

/**
 * The commit a ref names, or null when it names none -- no repository, no
 * commit yet, or a ref that does not exist.
 *
 * Null rather than a throw: the sha only labels a record, and a run that
 * could select tests must not fail because it could not label them.
 */
export async function resolveSha(ref: string, cwd = process.cwd()): Promise<string | null> {
  try {
    const out = (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd)).trim();
    return /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}
