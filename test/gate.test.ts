import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DraftInput, Gate, GateError } from "../src/gate.js";

const draft: DraftInput = {
  idempotencyKey: "enquiry-1-first-reply",
  channel: "email",
  recipient: "sam@example.com",
  body: "Hi Sam, could you share your budget?",
  reason: "Enquiry is missing a budget",
};

const fresh = () => new Gate(join(mkdtempSync(join(tmpdir(), "gate-")), "log.jsonl"));

test("a repeated idempotency key returns the original request", () => {
  const gate = fresh();
  const first = gate.request(draft);
  const second = gate.request(draft);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.approval.id, first.approval.id);
  assert.equal(gate.list().length, 1);
});

test("reusing a key for a different message is refused", () => {
  const gate = fresh();
  gate.request(draft);
  assert.throws(() => gate.request({ ...draft, body: "Something else" }), GateError);
});

test("a person's edit becomes the text that gets claimed", () => {
  const gate = fresh();
  const { approval } = gate.request(draft);
  gate.approve(approval.id, "ray", { editedBody: "Hi Sam, what budget do you have in mind?" });
  assert.equal(gate.claim(approval.id).finalBody, "Hi Sam, what budget do you have in mind?");
});

test("nothing can be claimed before approval or after rejection", () => {
  const gate = fresh();
  const { approval } = gate.request(draft);
  assert.throws(() => gate.claim(approval.id), /is pending/);
  gate.reject(approval.id, "ray", "Wrong person");
  assert.throws(() => gate.claim(approval.id), /is rejected/);
  assert.equal(gate.get(approval.id)?.note, "Wrong person");
});

test("approved text can only be claimed once", () => {
  const gate = fresh();
  const { approval } = gate.request(draft);
  gate.approve(approval.id, "ray");
  gate.claim(approval.id);
  assert.throws(() => gate.claim(approval.id), /is claimed/);
});

test("a decision cannot be changed once made", () => {
  const gate = fresh();
  const { approval } = gate.request(draft);
  gate.reject(approval.id, "ray");
  assert.throws(() => gate.approve(approval.id, "ray"), /is rejected/);
});

test("state survives a restart, because the log is the only store", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  const path = join(dir, "log.jsonl");
  const { approval } = new Gate(path).request(draft);
  new Gate(path).approve(approval.id, "ray");
  assert.equal(new Gate(path).get(approval.id)?.status, "approved");
});

test("verify catches an edited log line", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  const path = join(dir, "log.jsonl");
  const gate = new Gate(path);
  const { approval } = gate.request(draft);
  gate.approve(approval.id, "ray");
  assert.deepEqual(gate.verify(), { ok: true, events: 2 });
  writeFileSync(path, readFileSync(path, "utf8").replace("Hi Sam", "Hi Pat"));
  assert.deepEqual(gate.verify(), { ok: false, brokenAtLine: 1 });
});

test("verify catches a forged approval appended to the log", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  const path = join(dir, "log.jsonl");
  const gate = new Gate(path);
  const { approval } = gate.request(draft);
  appendFileSync(
    path,
    JSON.stringify({ type: "approved", id: approval.id, by: "agent", finalBody: "x", at: "2026-01-01", prev: "f", hash: "f" }) + "\n",
  );
  assert.deepEqual(gate.verify(), { ok: false, brokenAtLine: 2 });
});
