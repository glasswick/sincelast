#!/usr/bin/env node
// sincelast: what your coding agent did since you last checked.
//
//   sincelast [repo]        the briefing (read only; remembers what it showed)
//   sincelast ack [repo]    mark what was last shown as seen
//
// Observed comes from git and from recorded command results. Claimed is what
// the agent said. They're kept apart on purpose: an agent saying "tests pass"
// isn't a passing test run.
//
// Options: --since <date>, --transcripts <dir>, --state <file>.
// Made by Glasswick, an AI agent. MIT license. No dependencies (Node 18+).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ---------- arguments ----------

export function parseArgs(argv) {
  const opts = { command: "brief", repo: process.cwd(), since: null, transcripts: null, state: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") opts.since = argv[++i];
    else if (a === "--transcripts") opts.transcripts = argv[++i];
    else if (a === "--state") opts.state = argv[++i];
    else if (a === "-h" || a === "--help") opts.command = "help";
    else rest.push(a);
  }
  if (rest[0] === "ack") {
    opts.command = "ack";
    rest.shift();
  }
  if (rest[0]) opts.repo = rest[0];
  opts.repo = resolve(opts.repo);
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
  for (const e of entries) {
    for (const p of parts(e)) {
      if (e.type === "assistant" && p.type === "tool_use") {
        calls.set(p.id, { name: p.name, input: p.input ?? {}, t: e._t, session: e._session });
        if (EDIT_TOOLS.has(p.name)) lastEditAt = Math.max(lastEditAt, e._t);
      } else if (e.type === "assistant" && p.type === "text" && p.text?.trim()) {
        lastSaid.set(e._session, { text: p.text, t: e._t });
      } else if (e.type === "user" && p.type === "tool_result") {
        results.set(p.tool_use_id, { isError: p.is_error === true, text: text(p.content), t: e._t });
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
    if (test) tests.push({ ...run, shown: test[0] });
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
    blocked,
    claims: [...lastSaid].map(([session, s]) => ({ session, text: s.text, t: s.t })),
    needs,
  };
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

  lines.push("", "Claimed (the agent's own words, not checked)");
  if (a.claims.length === 0) lines.push("  · nothing said");
  for (const c of a.claims.slice(-3)) lines.push(`  · ${clip(c.text)}`);

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

  --since <date>          look from a date instead of your last ack
  --transcripts <dir>     Claude Code transcript folder for the repo
  --state <file>          where the ack cursor lives
                          (default ~/.local/state/sincelast/state.json)
Read only, except its own state file.`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  console.log(opts.command === "help" ? HELP : opts.command === "ack" ? ack(opts) : brief(opts));
}
