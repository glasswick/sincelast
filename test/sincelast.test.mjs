// Run: node --test lanes/main/projects/sincelast/test/
// Builds a throwaway git repo and fixture Claude Code transcripts in test/work/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ack, analyze, brief, parseSince } from "../sincelast.mjs";

const WORK = join(import.meta.dirname, "work");
const REPO = join(WORK, "repo");
const TRANSCRIPTS = join(WORK, "transcripts");
const STATE = join(WORK, "state.json");
const opts = () => ({ command: "brief", repo: REPO, since: null, transcripts: TRANSCRIPTS, state: STATE });

const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
function commit(file, message) {
  writeFileSync(join(REPO, file), message);
  git("add", file);
  git("commit", "-q", "-m", message);
}

const T0 = Date.parse("2026-10-30T08:00:00Z");
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const say = (min, words) => ({ type: "assistant", timestamp: at(min), sessionId: "s1", message: { content: [{ type: "text", text: words }] } });
const call = (min, id, name, input) => ({ type: "assistant", timestamp: at(min), sessionId: "s1", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (min, id, out, isError = false) => ({ type: "user", timestamp: at(min), sessionId: "s1", message: { content: [{ type: "tool_result", tool_use_id: id, content: out, is_error: isError }] } });
const writeTranscript = (entries) => writeFileSync(join(TRANSCRIPTS, "s1.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

function fresh() {
  rmSync(WORK, { recursive: true, force: true }); // a fixed path inside this test folder
  mkdirSync(REPO, { recursive: true });
  mkdirSync(TRANSCRIPTS, { recursive: true });
  git("init", "-q");
  git("config", "commit.gpgsign", "false");
  commit("a.txt", "first commit");
}

test("a run with a pass, an unfixed failure and an open question", () => {
  fresh();
  commit("b.txt", "add rate limiter");
  writeTranscript([
    call(1, "t1", "Bash", { command: "npm test" }),
    result(2, "t1", "42 passing"),
    call(3, "l1", "Bash", { command: "npm run lint" }),
    result(4, "l1", "1 error: unused variable", true),
    say(5, "Done. All tests pass and the limiter is shipped."),
    call(6, "q1", "AskUserQuestion", { question: "Merge the branch?" }),
  ]);
  const out = brief({ ...opts(), since: "2026-10-30T07:00:00Z" }, T0 + 60 * 60_000);
  assert.match(out, /add rate limiter/);
  assert.match(out, /last test run passed: npm test/);
  assert.doesNotMatch(out, /may not hold now/);
  assert.match(out, /Claimed[\s\S]*All tests pass/);
  assert.match(out, /Needs you \(2\)/);
  assert.match(out, /`npm run lint` failed/);
  assert.match(out, /a question is waiting/);
});

test("a test run followed by edits is marked as maybe stale", () => {
  const a = analyze([
    call(1, "t1", "Bash", { command: "pytest -q" }),
    result(2, "t1", "3 passed"),
    call(3, "e1", "Edit", { file_path: "x.py" }),
    result(3, "e1", "ok"),
  ].map((e) => ({ ...e, _t: Date.parse(e.timestamp), _session: "s1" })));
  assert.equal(a.lastTest.ok, true);
  assert.equal(a.lastTest.stale, true);
});

// Cases found by the first run on a real repo's transcripts (2026-10-30).
const entries = (list) => list.map((e) => ({ ...e, _t: Date.parse(e.timestamp), _session: "s1" }));

test("a hook blocking a command is not a failure that needs you", () => {
  const a = analyze(entries([
    call(1, "h1", "Bash", { command: "python3 edit.py" }),
    result(2, "h1", "PreToolUse:Bash hook error: blocked by policy", true),
    call(3, "ok", "Bash", { command: "git status" }),
    result(4, "ok", "clean"),
  ]));
  assert.equal(a.needs.length, 0);
  assert.equal(a.blocked, 1);
});

test("a one-off failed command mid-session doesn't need you", () => {
  const a = analyze(entries([
    call(1, "l1", "Bash", { command: "ls missing.md" }),
    result(2, "l1", "No such file or directory", true),
    call(3, "ok", "Bash", { command: "git log -1" }),
    result(4, "ok", "abc123"),
  ]));
  assert.equal(a.needs.length, 0);
});

test("the session's last command failing does need you", () => {
  const a = analyze(entries([
    call(1, "d1", "Bash", { command: "./deploy.sh" }),
    result(2, "d1", "permission denied", true),
  ]));
  assert.equal(a.needs.length, 1);
});

test("a test run inside a longer shell line is shown as the test part", () => {
  const a = analyze(entries([
    call(1, "t1", "Bash", { command: "cat > LICENSE <<'EOF'\nMIT\nEOF\nnode --test test/ | grep ok" }),
    result(2, "t1", "6 ok"),
  ]));
  assert.equal(a.lastTest.shown, "node --test");
});

test("a failure fixed later doesn't need you", () => {
  const a = analyze([
    call(1, "b1", "Bash", { command: "npm run build" }),
    result(2, "b1", "error", true),
    call(3, "b2", "Bash", { command: "npm run build" }),
    result(4, "b2", "built"),
  ].map((e) => ({ ...e, _t: Date.parse(e.timestamp), _session: "s1" })));
  assert.equal(a.needs.length, 0);
});

test("ack shows only what's new afterwards, and never skips unseen work", () => {
  fresh();
  assert.match(ack(opts()), /Nothing to ack/);
  brief(opts(), T0);
  commit("c.txt", "work done after the briefing was shown");
  ack(opts()); // acks what was shown, not the commit that came after
  const out = brief(opts(), T0 + 5 * 60_000);
  assert.match(out, /since you last acked/);
  assert.match(out, /work done after the briefing was shown/);
  ack(opts());
  assert.match(brief(opts(), T0 + 10 * 60_000), /no new commits/);
});

test("--since takes dates and 'N hours ago', and explains anything else", () => {
  assert.equal(parseSince("3 hours ago", T0), at(-180));
  assert.equal(parseSince("2 days ago", T0), at(-2 * 1440));
  assert.equal(parseSince("2026-10-30T08:00:00Z", T0), at(0));
  assert.equal(parseSince("last tuesday", T0), null);
  assert.match(brief({ ...opts(), since: "last tuesday" }), /Can't read --since/);
});

test("not a git repo, no transcripts: says so instead of failing", () => {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  // test/work sits inside another repo; stop git from finding it.
  process.env.GIT_CEILING_DIRECTORIES = import.meta.dirname;
  let out;
  try {
    out = brief({ ...opts(), repo: WORK, transcripts: join(WORK, "none") });
  } finally {
    delete process.env.GIT_CEILING_DIRECTORIES;
  }
  assert.match(out, /not a git repo/);
  assert.match(out, /git only \(no transcripts found\)/);
});
