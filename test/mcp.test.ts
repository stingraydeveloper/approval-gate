import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Gate } from "../src/gate.js";
import { createServer } from "../src/server.js";

async function connect() {
  const gate = new Gate(join(mkdtempSync(join(tmpdir(), "gate-")), "log.jsonl"));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(gate).connect(serverSide);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const [first] = res.content as { text: string }[];
    return { isError: Boolean(res.isError), data: JSON.parse(first?.text ?? "{}") };
  };
  return { gate, client, call };
}

const request = {
  idempotency_key: "k1",
  channel: "whatsapp",
  recipient: "+15550100",
  body: "Thanks for your enquiry.",
  reason: "New enquiry on Saturday",
};

test("an agent has no tool that can approve or reject", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["check_approval", "claim_approved", "request_approval"]);
});

test("a full round trip over MCP sends the person's wording", async () => {
  const { gate, call } = await connect();
  const { data } = await call("request_approval", request);
  assert.equal(data.status, "pending");
  assert.equal(data.body, undefined, "status replies do not carry message text");

  const early = await call("claim_approved", { id: data.id });
  assert.equal(early.isError, true);

  gate.approve(data.id, "ray", { editedBody: "Thanks! We reply fully on Monday." });
  assert.equal((await call("check_approval", { id: data.id })).data.status, "approved");
  assert.equal((await call("claim_approved", { id: data.id })).data.body, "Thanks! We reply fully on Monday.");
  assert.equal((await call("claim_approved", { id: data.id })).isError, true);
});

test("an agent retry does not create a second request", async () => {
  const { gate, call } = await connect();
  await call("request_approval", request);
  const retry = await call("request_approval", request);
  assert.equal(retry.data.duplicate, true);
  assert.equal(gate.list().length, 1);
});
