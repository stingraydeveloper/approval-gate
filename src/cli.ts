#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Gate, GateError } from "./gate.js";
import { startReview } from "./review.js";
import { createServer } from "./server.js";

const USAGE = `approval-gate serve                 run the MCP server for your agent (stdio)
approval-gate review [--port 4311]  open a local page to approve or reject drafts
approval-gate list                  show drafts waiting for review
approval-gate approve <id> [--edit <file>] [--note <text>]
approval-gate reject <id> [--note <text>]
approval-gate verify                check the log has not been altered

The log lives at $APPROVAL_GATE_LOG, or ~/.approval-gate.jsonl by default.`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const gate = new Gate(process.env.APPROVAL_GATE_LOG ?? join(homedir(), ".approval-gate.jsonl"));
  const reviewer = userInfo().username;
  const note = flag(args, "--note");

  switch (command) {
    case "serve":
      await createServer(gate).connect(new StdioServerTransport());
      return 0;
    case "review": {
      const { url } = await startReview(gate, reviewer, Number(flag(args, "--port") ?? 4311));
      console.log(`Review drafts at ${url}`);
      return 0;
    }
    case "list":
      for (const a of gate.list("pending")) {
        console.log(`${a.id}  ${a.channel} to ${a.recipient}\n  why: ${a.reason}\n  ${a.body.replace(/\n/g, "\n  ")}\n`);
      }
      return 0;
    case "approve": {
      const edit = flag(args, "--edit");
      const a = gate.approve(args[0] ?? "", reviewer, {
        ...(edit ? { editedBody: readFileSync(edit, "utf8") } : {}),
        ...(note ? { note } : {}),
      });
      console.log(`${a.id} approved`);
      return 0;
    }
    case "reject":
      console.log(`${gate.reject(args[0] ?? "", reviewer, note).id} rejected`);
      return 0;
    case "verify": {
      const result = gate.verify();
      console.log(result.ok ? `ok: ${result.events} events` : `altered at line ${result.brokenAtLine}`);
      return result.ok ? 0 : 1;
    }
    default:
      console.log(USAGE);
      return command ? 1 : 0;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    if (!(err instanceof GateError)) throw err;
    console.error(err.message);
    process.exitCode = 1;
  });
