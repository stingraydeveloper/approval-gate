import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Approval, Gate, GateError } from "./gate.js";

const reply = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/** The fields an agent may see. It gets the final text only by claiming it. */
function publicView(a: Approval) {
  return { id: a.id, status: a.status, note: a.note, decidedAt: a.decidedAt };
}

function guarded<A>(fn: (args: A) => ReturnType<typeof reply>) {
  return async (args: A) => {
    try {
      return fn(args);
    } catch (err) {
      if (err instanceof GateError) return reply({ error: err.message }, true);
      throw err;
    }
  };
}

/**
 * The agent's side of the gate. There is deliberately no approve or reject tool:
 * no prompt, and no instruction hidden in a message the agent reads, can reach one.
 */
export function createServer(gate: Gate): McpServer {
  const server = new McpServer({ name: "approval-gate", version: "0.1.0" });

  server.registerTool(
    "request_approval",
    {
      description:
        "Queue an outbound message for a person to review. Nothing is sent. Reusing an idempotency_key returns the original request.",
      inputSchema: {
        idempotency_key: z.string().min(1).describe("Stable per outbound action, e.g. enquiry-4821-first-reply"),
        channel: z.string().min(1).describe("email, sms, whatsapp, crm_note, ..."),
        recipient: z.string().min(1),
        subject: z.string().optional(),
        body: z.string().min(1),
        reason: z.string().min(1).describe("One sentence the reviewer reads: why this message, why now"),
      },
    },
    guarded(({ idempotency_key, channel, recipient, subject, body, reason }) => {
      const { approval, duplicate } = gate.request({
        idempotencyKey: idempotency_key,
        channel,
        recipient,
        body,
        reason,
        ...(subject ? { subject } : {}),
      });
      return reply({ ...publicView(approval), duplicate });
    }),
  );

  server.registerTool(
    "check_approval",
    {
      description: "Read the status of a request: pending, approved, rejected or claimed.",
      inputSchema: { id: z.string() },
    },
    guarded(({ id }) => {
      const approval = gate.get(id);
      return approval ? reply(publicView(approval)) : reply({ error: `no approval with id ${id}` }, true);
    }),
  );

  server.registerTool(
    "claim_approved",
    {
      description:
        "Take the approved text for sending. Works once per request, so a retry cannot send twice. Send exactly the returned body: the person may have edited it.",
      inputSchema: { id: z.string() },
    },
    guarded(({ id }) => {
      const approval = gate.claim(id);
      return reply({
        id: approval.id,
        channel: approval.channel,
        recipient: approval.recipient,
        subject: approval.subject,
        body: approval.finalBody,
      });
    }),
  );

  return server;
}
