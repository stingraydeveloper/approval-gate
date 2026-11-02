import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Gate } from "../src/gate.js";
import { startReview } from "../src/review.js";

const draft = {
  idempotencyKey: "k",
  channel: "email",
  recipient: "sam@example.com",
  body: "<script>alert(1)</script>",
  reason: "Test",
};

async function setup() {
  const gate = new Gate(join(mkdtempSync(join(tmpdir(), "gate-")), "log.jsonl"));
  const { approval } = gate.request(draft);
  const { server, url } = await startReview(gate, "ray", 0);
  const parsed = new URL(url);
  return { gate, id: approval.id, server, url, parsed };
}

test("the review page refuses a request without the token", async () => {
  const { server, parsed } = await setup();
  const res = await fetch(`${parsed.origin}/`);
  assert.equal(res.status, 403);
  server.close();
});

test("draft text is escaped on the review page", async () => {
  const { server, url } = await setup();
  const html = await (await fetch(url)).text();
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
  server.close();
});

test("approving through the page records the edited text and the reviewer", async () => {
  const { gate, id, server, parsed } = await setup();
  const res = await fetch(`${parsed.origin}/decide?${parsed.searchParams}`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ id, action: "approve", body: "Edited text" }),
  });
  assert.equal(res.status, 303);
  const approval = gate.get(id);
  assert.equal(approval?.finalBody, "Edited text");
  assert.equal(approval?.decidedBy, "ray");
  server.close();
});
