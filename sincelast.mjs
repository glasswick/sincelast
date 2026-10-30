#!/usr/bin/env node
// sincelast: what your coding agent did since you last checked.
//
//   sincelast [repo]        the briefing (read only; remembers what it showed)
//   sincelast ack [repo]    mark what was last shown as seen
//   sincelast receipts      receipts to end an agent's report with
//
// Observed comes from git and from recorded command results. Claimed is what
// the agent said. They're kept apart on purpose: an agent saying "tests pass"
// isn't a passing test run.
//
// Options: --since <date>, --transcripts <dir>, --state <file>.
// Made by Glasswick, an AI agent. MIT license. No dependencies (Node 18+).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ---------- arguments ----------

export function parseArgs(argv) {
  const opts = { command: "brief", repo: process.cwd(), since: null, transcripts: null, state: null };
  const rest = [];
  // `check` takes the rest of the line, untouched, as the command to run.
  if (argv[0] === "check") {
    opts.command = "check";
    opts.run = argv.slice(argv[1] === "--" ? 2 : 1);
    argv = [];
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") opts.since = argv[++i];
    else if (a === "--transcripts") opts.transcripts = argv[++i];
    else if (a === "--state") opts.state = argv[++i];
    else if (a === "-h" || a === "--help") opts.command = "help";
    else rest.push(a);
  }
  if (rest[0] === "receipts") {
    opts.command = "receipts";
    rest.shift();
  } else if (rest[0] === "ack") {
    opts.command = "ack";
    rest.shift();
  }
  if (rest[0]) opts.repo = rest[0];
  opts.repo = resolve(opts.repo);
  // Run from a subfolder, a repo is still its top level: checks and acks
  // recorded there must be found by receipts run from anywhere in it.
  opts.repo = git(opts.repo, "rev-parse", "--show-toplevel") ?? opts.repo;
  opts.state ??= process.env.SINCELAST_STATE ?? join(homedir(), ".local", "state", "sincelast", "state.json");
  // Claude Code keeps a project's transcripts in a folder named after its path.
  opts.transcripts ??= join(homedir(), ".claude", "projects", opts.repo.replace(/[^a-zA-Z0-9]/g, "-"));
  return opts;
}

// ---------- git ----------

function git(repo, ...args) {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd();
  } catch {
    return null;
  }
}

export function gitObserved(repo, cursor) {
  const head = git(repo, "rev-parse", "HEAD");
  if (head === null) return { head: null, commits: [], dirty: [] };
  // Prefer ancestry from the acknowledged commit; fall back to time.
  const fromHead = cursor?.head && git(repo, "merge-base", "--is-ancestor", cursor.head, "HEAD") !== null;
  const range = fromHead ? [`${cursor.head}..HEAD`] : ["--since", cursor.at];
  const log = git(repo, "log", ...range, "--format=%h%x09%s") ?? "";
  const commits = log.split("\n").filter(Boolean).map((l) => {
    const [hash, subject] = l.split("\t");
    return { hash, subject };
  });
  const status = git(repo, "status", "--short") ?? "";
  return { head, commits, dirty: status.split("\n").filter(Boolean) };
}

// ---------- transcripts ----------

const TEST_COMMAND = /\b(npm (run )?test|pnpm test|yarn test|bun test|node --test|npx (jest|vitest)|jest|vitest|pytest|python -m (pytest|unittest)|go test|cargo test|make test|rspec|phpunit|mix test|dotnet test)\b/;
// Commands whose failure matters even mid-session: builds, linters, type checks.
const CHECK_COMMAND = /\b(lint|eslint|biome|ruff|mypy|tsc|typecheck|type-check|build|clippy|cargo (build|check)|go (build|vet)|npm run check)\b/;
// A tool call a hook or permission system refused: not a failure for a human to fix.
const BLOCKED = /hook error|PreToolUse|blocked by (a )?hook|permission (was )?denied for this tool|user (denied|rejected) (this|the) tool/i;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// Claude Code's reply when a command is started in the background, and the
// notice that arrives when it ends. The launch is not the result.
const BACKGROUND_LAUNCH = /^Command running in background with ID: ([\w-]+)/;
const TASK_DONE = /<task-id>([\w-]+)<\/task-id>[\s\S]*?<status>(\w+)<\/status>(?:[\s\S]*?\(exit code (\d+)\))?/g;
const PERSON_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

const parts = (e) => (Array.isArray(e?.message?.content) ? e.message.content : []);
const text = (c) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("\n") : "";
const clip = (s, n = 160) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : one.slice(0, one.lastIndexOf(" ", n)) + " …";
};

/** Every transcript entry since `at`, from all .jsonl files in `dir`. */
export function readTranscripts(dir, at) {
  if (!dir || !existsSync(dir)) return [];
  const since = Date.parse(at);
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    if (statSync(path).mtimeMs < since) continue; // untouched since the cursor
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue; // a line still being written
      }
      const t = Date.parse(e.timestamp ?? "");
      if (Number.isNaN(t) || t < since) continue;
      out.push({ ...e, _t: t, _session: e.sessionId ?? name.replace(/\.jsonl$/, "") });
    }
  }
  return out.sort((a, b) => a._t - b._t);
}

/** Tests run, what each session last said, and what's waiting on a person. */
export function analyze(entries) {
  const calls = new Map(); // tool_use id -> { name, input, t, session }
  const results = new Map(); // tool_use id -> { isError, text, t }
  const lastSaid = new Map(); // session -> { text, t }
  let lastEditAt = 0;
  const edits = []; // { t, file }, for checking "tests pass" claims
  const finished = new Map(); // background task id -> { t, ok, code }
  for (const e of entries) {
    for (const p of parts(e)) {
      if (e.type === "assistant" && p.type === "tool_use") {
        calls.set(p.id, { name: p.name, input: p.input ?? {}, t: e._t, session: e._session });
        if (EDIT_TOOLS.has(p.name)) {
          lastEditAt = Math.max(lastEditAt, e._t);
          edits.push({ t: e._t, file: String(p.input?.file_path ?? p.input?.notebook_path ?? "a file").split("/").pop() });
        }
      } else if (e.type === "assistant" && p.type === "text" && p.text?.trim()) {
        lastSaid.set(e._session, { text: p.text, t: e._t });
      } else if (e.type === "user" && p.type === "tool_result") {
        results.set(p.tool_use_id, { isError: p.is_error === true, text: text(p.content), t: e._t });
      }
    }
    // A background command's result arrives later, as a notice in a prompt.
    if (e.type === "user") {
      const said = typeof e.message?.content === "string" ? e.message.content : parts(e).map((p) => p?.text ?? "").join("\n");
      for (const m of said.matchAll(TASK_DONE)) {
        const code = m[3] === undefined ? null : Number(m[3]);
        finished.set(m[1], { t: e._t, ok: m[2] === "completed" && (code === null || code === 0), code });
      }
    }
  }

  const tests = [];
  const failures = new Map(); // command -> latest failed run, cleared by a later success
  const lastBash = new Map(); // session -> id of its last shell command
  const needs = [];
  let blocked = 0;
  for (const [id, call] of calls) {
    const result = results.get(id);
    if (PERSON_TOOLS.has(call.name) && !result) {
      needs.push({ what: `${call.name === "AskUserQuestion" ? "a question" : "a plan"} is waiting for an answer`, session: call.session });
      continue;
    }
    if (call.name !== "Bash" || !result) continue;
    if (result.isError && BLOCKED.test(result.text)) {
      blocked++;
      continue;
    }
    lastBash.set(call.session, id);
    const command = String(call.input.command ?? "");
    const test = TEST_COMMAND.exec(command);
    const run = { id, command, ok: !result.isError, t: result.t, session: call.session, tail: clip(result.text.split("\n").slice(-3).join(" "), 120) };
    // Launching a command in the background succeeds at once; its real
    // result is the completion notice, if one has arrived.
    const bg = BACKGROUND_LAUNCH.exec(result.text);
    if (bg) {
      const done = finished.get(bg[1]);
      if (done) Object.assign(run, { ok: done.ok, t: done.t, background: true });
      else Object.assign(run, { ok: null, pending: true, background: true });
    }
    if (test) tests.push({ ...run, shown: test[0] });
    if (run.pending) continue;
    if (run.ok) failures.delete(command);
    else failures.set(command, run);
  }
  // Agents try things that fail all the time. A failure needs a human only if
  // it's a test, build or check that never passed afterwards, or the last
  // thing a session did.
  for (const f of failures.values()) {
    const matters = TEST_COMMAND.test(f.command) || CHECK_COMMAND.test(f.command) || lastBash.get(f.session) === f.id;
    if (matters) needs.push({ what: `\`${clip(f.command, 70)}\` failed and wasn't fixed afterwards`, detail: f.tail, session: f.session });
  }
  const lastTest = tests.at(-1) ?? null;
  return {
    lastTest: lastTest && { ...lastTest, stale: lastEditAt > lastTest.t },
    testCount: tests.length,
    tests,
    edits,
    blocked,
    claims: [...lastSaid].map(([session, s]) => ({ session, text: s.text, t: s.t })),
    needs,
  };
}

// ---------- receipts for claims ----------

const CLAIM_SENTENCES = (text) =>
  text
    .replace(/\n{2,}/g, "\n")
    .split("\n")
    .flatMap((l) => l.replace(/^\s*([-*]|\d+\.)\s+/, "").split(/(?<=[.!?])\s+(?=[A-Z*`])/))
    .map((s) => s.replace(/\*\*/g, "").trim())
    .filter((s) => s.length > 3);

const HEAD_RECEIPT = /\bHEAD `([0-9a-f]{7,40})`(?:, (not pushed)| on `([^`]+)`)/;
const CHECK_RECEIPT = /\blast check: `([^`]+)` (passed|failed)\b/;
const PASS_CLAIM = /\b(tests? (all |still )?pass(es|ed)?|all \d+ (tests )?pass|\d+ tests? pass|build (passes|passed|succeeds|succeeded)|lint (passes|is clean)|type ?check(s)? pass(es)?)\b/i;
const CLEAN_CLAIM = /\b(working tree:? (is )?clean|nothing (is )?uncommitted|no uncommitted changes|git status( --short)?`? (is )?clean)\b/i;
const DONE_CLAIM = /\b(done|fixed|implemented|resolved|completed|works now|it works)\b/i;
const HYPOTHETICAL = /\b(would|could|might|should)\b|^if\b/i;

/**
 * Check each claim in an agent's message against the evidence: ✓ a receipt
 * was found, ✗ the evidence contradicts it, ? nothing here can check it.
 * Only kinds git and the transcript decide exactly; never a guess.
 * ctx: { repo, tests: [{t, ok, shown}], edits: [{t, file}], at, commits }
 */
export function checkClaims(text, ctx) {
  const marks = [];
  for (const s of CLAIM_SENTENCES(text)) {
    if (HYPOTHETICAL.test(s)) continue;
    // sincelast's own receipt lines, read back exactly.
    const head = HEAD_RECEIPT.exec(s);
    if (head) {
      const [, h, notPushed, remote] = head;
      const exists = git(ctx.repo, "cat-file", "-e", `${h}^{commit}`) !== null;
      const on = (git(ctx.repo, "branch", "-r", "--contains", h) ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.includes("->"));
      if (!exists) marks.push({ mark: "✗", s, why: `no commit ${h} in this repo` });
      else if (remote && !on.includes(remote)) marks.push({ mark: "✗", s, why: `${h} isn't on ${remote}` });
      else marks.push({ mark: "✓", s, why: notPushed ? `${h} exists` : `${h} is on ${remote}` });
      continue;
    }
    const check = CHECK_RECEIPT.exec(s);
    if (check) {
      const [, cmd, said] = check;
      const run = ctx.tests.filter((r) => r.t <= ctx.at && (r.shown === cmd || r.command === cmd)).at(-1);
      const after = run ? [...ctx.edits.filter((e) => e.t > run.t && e.t <= ctx.at), ...changedSince(ctx.repo, run.t).map((f) => ({ file: f.split("/").pop() }))] : [];
      if (!run) marks.push({ mark: "✗", s, why: `no run of ${cmd} found` });
      else if (run.pending) marks.push({ mark: "✗", s, why: `${cmd} is still running` });
      else if ((said === "passed") !== run.ok) marks.push({ mark: "✗", s, why: `${cmd} ${run.ok ? "passed" : "failed"}, not ${said}` });
      else if (said === "passed" && after.length && /nothing edited after/.test(s)) marks.push({ mark: "✗", s, why: `${after.at(-1).file} was edited after it` });
      else marks.push({ mark: "✓", s, why: `${cmd} ${said}${after.length ? "" : ", nothing edited after"}` });
      continue;
    }
    const hashes = [...s.matchAll(/`([0-9a-f]{7,40})`/g)].map((m) => m[1]);
    if (hashes.length && /\b(commit|committed|pushed|as)\b/i.test(s)) {
      const pushedSaid = /\bpushed\b/i.test(s);
      const bad = hashes.find((h) => git(ctx.repo, "cat-file", "-e", `${h}^{commit}`) === null);
      if (bad) marks.push({ mark: "✗", s, why: `no commit ${bad} in this repo` });
      else if (pushedSaid && hashes.some((h) => !(git(ctx.repo, "branch", "-r", "--contains", h) ?? "").trim()))
        marks.push({ mark: "✗", s, why: "the commit exists but isn't on any remote branch" });
      else marks.push({ mark: "✓", s, why: `commit ${hashes.join(", ")} exists${pushedSaid ? " and is pushed" : ""}` });
      continue;
    }
    if (PASS_CLAIM.test(s)) {
      const run = ctx.tests.filter((r) => r.t <= ctx.at).at(-1);
      if (!run) marks.push({ mark: "?", s, why: "no test or check run found" });
      else if (run.pending) marks.push({ mark: "✗", s, why: `${run.shown} was still running in the background; its result wasn't in yet` });
      else if (!run.ok) marks.push({ mark: "✗", s, why: `the last run failed: ${run.shown}` });
      else {
        const after = ctx.edits.filter((e) => e.t > run.t && e.t <= ctx.at);
        if (after.length) marks.push({ mark: "✗", s, why: `${run.shown} passed, but ${after.at(-1).file} was edited after it` });
        else marks.push({ mark: "✓", s, why: `${run.shown} passed, nothing edited after` });
      }
      continue;
    }
    if (CLEAN_CLAIM.test(s)) {
      const dirty = (git(ctx.repo, "status", "--short") ?? "").trim();
      marks.push(dirty ? { mark: "✗", s, why: `git status shows changes now: ${dirty.split("\n")[0].trim()}` } : { mark: "✓", s, why: "git status is clean now" });
      continue;
    }
    if (DONE_CLAIM.test(s)) marks.push({ mark: "?", s, why: "no receipt" });
  }
  return marks;
}

/**
 * Uncommitted files changed on disk after time t, by modification time. This
 * catches edits made by shell commands and scripts, which the transcript's
 * edit tools don't show.
 */
export function changedSince(repo, t) {
  const dirty = (git(repo, "status", "--short", "--untracked-files=all") ?? "").split("\n").filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ""));
  return dirty.filter((f) => {
    try {
      return statSync(join(repo, f)).mtimeMs > t;
    } catch {
      return false; // deleted: nothing to date
    }
  });
}

/**
 * Receipts an agent can end a report with: computed from git and the
 * transcript, never from memory, and checkable by checkClaims later.
 */
export function receipts(repo, a, now = Date.now(), declared = []) {
  const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);
  const out = [];
  const head = git(repo, "rev-parse", "--short=7", "HEAD");
  if (head) {
    const on = (git(repo, "branch", "-r", "--contains", "HEAD") ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.includes("->"));
    out.push(on.length ? `HEAD \`${head}\` on \`${on[0]}\`` : `HEAD \`${head}\`, not pushed`);
  }
  const dirty = (git(repo, "status", "--short") ?? "").split("\n").filter(Boolean);
  out.push(dirty.length ? `working tree: ${dirty.length} uncommitted (${dirty.slice(0, 3).map((d) => d.slice(3)).join(", ")}${dirty.length > 3 ? ", …" : ""})` : "working tree: clean");
  const run = withDeclared(a.tests, declared).filter((r) => r.t <= now).at(-1);
  if (!run) out.push("last check: none recorded");
  else if (run.pending) out.push(`last check: \`${run.shown}\` still running`);
  else {
    const after = [...a.edits.filter((e) => e.t > run.t && e.t <= now).map((e) => e.file), ...changedSince(repo, run.t).map((f) => f.split("/").pop())];
    out.push(`last check: \`${run.shown}\` ${run.ok ? "passed" : "failed"} at ${hhmm(run.t)}, ${after.length ? `but ${after.at(-1)} was edited after` : "nothing edited after"}`);
  }
  return out;
}

// ---------- declared checks ----------

/**
 * Checks an agent ran through `sincelast check`, merged with the test runs
 * found in the transcript, oldest first. A script that exits 0 is as much a
 * check as `npm test`, but no pattern can tell which scripts are checks, so
 * the agent says so by running it through sincelast.
 */
export function withDeclared(tests, declared) {
  const shown = (c) => (c.length > 60 ? c.slice(0, 59) + "…" : c);
  return [...tests, ...declared.map((d) => ({ ...d, shown: shown(d.command), declared: true }))].sort((x, y) => x.t - y.t);
}

/** Run a command as a check, record its result for this repo, return its exit code. */
export function runCheck(opts, now = () => Date.now()) {
  if (!opts.run?.length) {
    console.error("usage: sincelast check -- <command>");
    return 2;
  }
  // One argument is a shell line, as typed. Several are separate words,
  // quoted so a query like q='label:"x"' reaches the program intact.
  const shq = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\''") + "'");
  const command = opts.run.length === 1 ? opts.run[0] : opts.run.map(shq).join(" ");
  // Run where the agent ran it; only the record belongs to the whole repo.
  const r = spawnSync(command, { shell: true, stdio: "inherit", cwd: process.cwd() });
  const code = r.status ?? 1;
  const state = loadState(opts.state);
  const repo = (state.repos[opts.repo] ??= {});
  repo.checks = [...(repo.checks ?? []), { command, ok: code === 0, t: now() }].slice(-20);
  saveState(opts.state, state);
  return code;
}

// ---------- state ----------

function loadState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { schema: 1, repos: {} };
  }
}
function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

// ---------- the briefing ----------

/** A date, or "3 hours ago" / "2 days ago" / "30 minutes ago". Null if neither. */
export function parseSince(value, now = Date.now()) {
  const rel = /^(\d+)\s*(minute|min|hour|day|week)s?\s+ago$/i.exec(value.trim());
  if (rel) {
    const unit = { minute: 60_000, min: 60_000, hour: 3600_000, day: 86_400_000, week: 604_800_000 }[rel[2].toLowerCase()];
    return new Date(now - Number(rel[1]) * unit).toISOString();
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const ago = (fromIso, now) => {
  const m = Math.round((now - Date.parse(fromIso)) / 60_000);
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d`;
};

export function brief(opts, now = Date.now()) {
  const state = loadState(opts.state);
  const acked = state.repos[opts.repo]?.acked ?? null;
  let cursor = acked ?? { at: new Date(now - 24 * 3600_000).toISOString(), head: null };
  if (opts.since) {
    const at = parseSince(opts.since, now);
    if (!at) return `Can't read --since "${opts.since}". Try a date (2026-10-30 09:00) or "3 hours ago".`;
    cursor = { at, head: null };
  }
  const g = gitObserved(opts.repo, cursor);
  const a = analyze(readTranscripts(opts.transcripts, cursor.at));
  a.tests = withDeclared(a.tests, (state.repos[opts.repo]?.checks ?? []).filter((c) => c.t >= Date.parse(cursor.at)));
  if (a.tests.length) a.lastTest = { ...a.tests.at(-1), stale: a.edits.some((e) => e.t > a.tests.at(-1).t) };

  const lines = [];
  const label = opts.since ? `since ${opts.since}` : acked ? "since you last acked" : "in the last 24h (nothing acked yet)";
  lines.push(`SINCE LAST CHECK · ${ago(cursor.at, now)} · ${label}`, "");

  lines.push("Observed");
  if (g.head === null) lines.push("  · not a git repo");
  else if (g.commits.length === 0) lines.push("  · no new commits");
  for (const c of g.commits.slice(0, 10)) lines.push(`  · ${c.hash}  ${c.subject}`);
  if (g.commits.length > 10) lines.push(`  · …and ${g.commits.length - 10} more`);
  if (g.dirty.length) lines.push(`  · ${g.dirty.length} uncommitted change${g.dirty.length === 1 ? "" : "s"}: ${g.dirty.slice(0, 3).map((d) => d.slice(3)).join(", ")}${g.dirty.length > 3 ? ", …" : ""}`);
  if (a.lastTest) {
    const t = a.lastTest;
    lines.push(`  · last test run ${t.ok ? "passed" : "FAILED"}: ${t.shown}${t.stale ? " (files were edited after it, so it may not hold now)" : ""}`);
  } else lines.push("  · no test runs recorded");
  if (a.blocked) lines.push(`  · ${a.blocked} command${a.blocked === 1 ? " was" : "s were"} blocked by a hook or permission rule`);

  lines.push("", "Claimed (the agent's own words, checked where the evidence can decide)");
  if (a.claims.length === 0) lines.push("  · nothing said");
  for (const c of a.claims.slice(-3)) {
    lines.push(`  · ${clip(c.text)}`);
    const marks = checkClaims(c.text, { repo: opts.repo, tests: a.tests, edits: a.edits, at: c.t, commits: g.commits.length });
    for (const m of marks.slice(0, 6)) lines.push(`      ${m.mark} "${clip(m.s, 70)}": ${m.why}`);
  }

  lines.push("", `Needs you (${a.needs.length})`);
  if (a.needs.length === 0) lines.push("  · nothing found");
  for (const n of a.needs) lines.push(`  · ${n.what}${n.detail ? `: ${n.detail}` : ""}`);

  lines.push("", `Evidence: git${existsSync(opts.transcripts) ? " + Claude Code transcripts" : " only (no transcripts found)"}. Seen it? sincelast ack`);

  // Remember exactly what was shown, so ack never skips unseen work.
  state.repos[opts.repo] = { ...(state.repos[opts.repo] ?? {}), shown: { at: new Date(now).toISOString(), head: g.head } };
  saveState(opts.state, state);
  return lines.join("\n");
}

export function ack(opts) {
  const state = loadState(opts.state);
  const shown = state.repos[opts.repo]?.shown;
  if (!shown) return "Nothing to ack: run sincelast first, then ack what you saw.";
  state.repos[opts.repo].acked = shown;
  saveState(opts.state, state);
  return `Acked up to ${shown.at.slice(0, 16).replace("T", " ")}${shown.head ? ` (${shown.head.slice(0, 7)})` : ""}. Next time you'll see only what's new.`;
}

const HELP = `sincelast: what your coding agent did since you last checked.

  sincelast [repo]        briefing: observed, claimed, needs you
  sincelast ack [repo]    mark what was last shown as seen
  sincelast check -- <cmd>  run any command as a check (a script, a
                          validator, an install test) and record whether
                          it passed, so receipts count it
  sincelast receipts      receipts to end an agent's report with (HEAD,
                          working tree, last check), from git and the
                          transcript; sincelast checks them when read back.
                          Run it as its own step, after your checks.

  --since <date>          look from a date instead of your last ack
  --transcripts <dir>     Claude Code transcript folder for the repo
  --state <file>          where the ack cursor lives
                          (default ~/.local/state/sincelast/state.json)
Read only, except its own state file (and whatever you ask \`check\` to run).`;

// Run directly, or through npx's symlink in node_modules/.bin: compare real paths.
const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === "receipts") {
    // The last day of this repo's transcripts is enough to find the last check.
    const a = analyze(readTranscripts(opts.transcripts, new Date(Date.now() - 24 * 3600_000).toISOString()));
    const declared = loadState(opts.state).repos[opts.repo]?.checks ?? [];
    console.log(["Receipts (from git and the transcript, by sincelast):", ...receipts(opts.repo, a, Date.now(), declared).map((l) => `- ${l}`)].join("\n"));
  } else if (opts.command === "check") process.exitCode = runCheck(opts);
  else console.log(opts.command === "help" ? HELP : opts.command === "ack" ? ack(opts) : brief(opts));
}
