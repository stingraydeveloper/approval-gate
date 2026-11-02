# approval-gate

An MCP server that stops an AI agent from sending anything until a person says yes.

The agent can ask for approval, check on it, and collect the approved text. It has no tool that can approve. That matters when the agent reads messages from strangers: an instruction hidden in an email can change what the agent wants to do, but it cannot reach a tool that does not exist.

```
agent ── request_approval ──▶ gate ◀── approve / edit / reject ── person
agent ◀── claim_approved ──── gate      (local review page or CLI)
```

[Try the rules in your browser](https://stingraydeveloper.github.io/#gate).

## What it guarantees

Each of these has a test.

- **No self-approval.** The MCP server exposes three tools: `request_approval`, `check_approval` and `claim_approved`.
- **A retry can't send twice.** Requests carry an idempotency key, and approved text can be claimed once.
- **The person's wording wins.** If they edit the draft, the agent gets the edited version.
- **A decision stays made.** A rejected draft can't be approved later.
- **Changes to the record show up.** The log is append-only and hash-chained, and `approval-gate verify` names the first line that doesn't match. This detects casual edits and forged lines. It isn't a defence against someone who rewrites the whole chain, so ship the log somewhere the agent can't write if that's in your threat model.

## Use it

```bash
git clone https://github.com/stingraydeveloper/approval-gate
cd approval-gate && npm ci && npm run build
```

Add it to any MCP client:

```json
{
  "mcpServers": {
    "approval-gate": {
      "command": "node",
      "args": ["/path/to/approval-gate/dist/cli.js", "serve"],
      "env": { "APPROVAL_GATE_LOG": "/path/to/approvals.jsonl" }
    }
  }
}
```

Then, in your own terminal:

```bash
node dist/cli.js review     # prints a local link to a page for approving, editing or rejecting
node dist/cli.js list       # or work from the command line
node dist/cli.js approve apr_35c592c45e76 --note "Fine"
node dist/cli.js verify     # ok: 2 events
```

The review page binds to `127.0.0.1` and needs a token that changes on every run.

## What it does not do

It doesn't send anything. Your agent or workflow does the sending after `claim_approved`, which keeps the gate independent of email, WhatsApp or whatever channel you use. It also doesn't stop an agent that has its own direct access to those channels, so take that access away.

One writer machine only: the lock is a local file. For several machines, put the same three tools in front of a database.

```bash
npm test
```

Built with Claude Code.
