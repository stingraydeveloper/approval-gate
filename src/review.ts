import { randomBytes } from "node:crypto";
import { createServer, Server } from "node:http";
import { Approval, Gate, GateError } from "./gate.js";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function card(a: Approval, token: string): string {
  return `<form method="post" action="/decide?token=${token}">
  <input type="hidden" name="id" value="${esc(a.id)}">
  <p class="meta">${esc(a.channel)} to <b>${esc(a.recipient)}</b>${a.subject ? ` &middot; ${esc(a.subject)}` : ""}</p>
  <p class="why">${esc(a.reason)}</p>
  <textarea name="body" rows="8" aria-label="Message to ${esc(a.recipient)}">${esc(a.body)}</textarea>
  <input name="note" placeholder="Note for the agent (optional)" aria-label="Note for the agent">
  <div class="row"><button name="action" value="approve">Approve and release</button>
  <button name="action" value="reject" class="quiet">Reject</button></div>
</form>`;
}

function page(gate: Gate, token: string): string {
  const pending = gate.list("pending");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approval gate (${pending.length})</title>
<style>
body{font:16px/1.45 system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;color:#14232b;background:#eef2f1}
h1{font-size:1.2rem}form{background:#fff;border:1px solid #c5d0cd;border-radius:6px;padding:1rem;margin:0 0 1rem}
.meta{margin:0}.why{margin:.25rem 0 .75rem;color:#4a5b63}textarea,input[name=note]{width:100%;box-sizing:border-box;font:inherit;padding:.5rem;margin-bottom:.5rem;border:1px solid #9fb0ab;border-radius:4px}
.row{display:flex;gap:.5rem}button{font:inherit;padding:.45rem .9rem;border:0;border-radius:4px;background:#14604a;color:#fff;cursor:pointer}
.quiet{background:none;color:#a4332a;border:1px solid #a4332a}:focus-visible{outline:2px solid #14232b;outline-offset:2px}
</style>
<h1>${pending.length ? `${pending.length} waiting for you` : "Nothing is waiting for you"}</h1>
${pending.map((a) => card(a, token)).join("\n")}`;
}

/** Local review page. Binds to loopback and requires a per-run token. */
export function startReview(gate: Gate, reviewer: string, port = 4311): Promise<{ server: Server; url: string }> {
  const token = randomBytes(16).toString("hex");
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.get("token") !== token) {
      res.writeHead(403).end("Open the link printed by `approval-gate review`.");
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(gate, token));
      return;
    }
    if (req.method === "POST" && url.pathname === "/decide") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const form = new URLSearchParams(raw);
        const id = form.get("id") ?? "";
        const note = form.get("note") || undefined;
        try {
          if (form.get("action") === "approve") {
            gate.approve(id, reviewer, { editedBody: form.get("body")?.replace(/\r\n/g, "\n"), ...(note ? { note } : {}) });
          } else if (form.get("action") === "reject") {
            gate.reject(id, reviewer, note);
          } else {
            throw new GateError("unknown action");
          }
          res.writeHead(303, { location: `/?token=${token}` }).end();
        } catch (err) {
          if (!(err instanceof GateError)) throw err;
          res.writeHead(409, { "content-type": "text/plain" }).end(err.message);
        }
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({ server, url: `http://127.0.0.1:${actual}/?token=${token}` });
    });
  });
}
