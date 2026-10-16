#!/usr/bin/env node
// Voxtakes MCP server (stdio, zero dependencies, node >= 18).
// Wraps the Voxtakes dubbing API with an x-api-key header so agents can:
//   dub_video -> (script gate) -> get_script -> edit_line -> approve_script
//   -> wait_job -> download_master, plus redub_line (1 line = 1 minute billing).
//
// Config (env): VOXTAKES_API_KEY (required), VOXTAKES_BASE (default https://app.voxtakes.com)
//
// Protocol: JSON-RPC 2.0 over stdio, newline-delimited. Implements initialize,
// tools/list, tools/call — the minimum honest MCP surface, no SDK needed.

const KEY = process.env.VOXTAKES_API_KEY || "";
const BASE = (process.env.VOXTAKES_BASE || "https://app.voxtakes.com").replace(/\/+$/, "");
const PROTOCOL = "2024-11-05";

if (!KEY) {
  process.stderr.write("voxtakes-mcp: VOXTAKES_API_KEY is not set (create one at app.voxtakes.com/keys)\n");
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "x-api-key": KEY, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML error pages */ }
  if (!res.ok) {
    const msg = (json && (json.error || (json.data && json.data.error))) || `HTTP ${res.status}`;
    const err = new Error(msg); err.status = res.status; err.code = json && json.code; throw err;
  }
  return json ? (json.data !== undefined ? json.data : json) : {};
}

// upload a local file straight to the returned presigned PUT url
async function uploadFile(name, bytesB64) {
  const size = Math.floor(bytesB64.length * 3 / 4);
  const { key, putUrl } = await api("POST", "/api/uploads", { name, type: "video/mp4", size });
  const buf = Buffer.from(bytesB64, "base64");
  const r = await fetch(putUrl, { method: "PUT", body: buf, headers: { "content-type": "video/mp4" } });
  if (!r.ok) throw new Error("upload PUT failed (" + r.status + ")");
  return key;
}

const LANGS = ["en", "es", "de", "ja", "fr", "ko", "pt", "zh"];

const TOOLS = [
  {
    name: "dub_video",
    description: "Translate + dub a video. src = {kind:'url',url} (YouTube etc.) or {kind:'upload',key} (from presign_upload). langs: subset of en,es,de,ja,fr,ko,pt,zh. delivery: voice|subs|clean(hard-sub erase). gate:true (default) returns a free preview + script first — call approve_script to bill the full render. Returns job id/status.",
    inputSchema: { type: "object", properties: {
      src: { type: "object" }, langs: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
      delivery: { type: "object", properties: { voice: { type: "boolean" }, subs: { type: "boolean" }, clean: { type: "boolean" } } },
      style: { type: "string", enum: ["clean", "karaoke", "karaoke_tw", "bilingual"] },
      gate: { type: "boolean" } }, required: ["src", "langs"] },
  },
  {
    name: "presign_upload",
    description: "Get an upload slot: returns {key, putUrl}. PUT the video bytes to putUrl (Content-Type video/mp4), then pass key to dub_video as src={kind:'upload',key}. Trial plan caps at 20 MB.",
    inputSchema: { type: "object", properties: {
      name: { type: "string" }, size: { type: "number" } }, required: ["name", "size"] },
  },
  {
    name: "upload_video",
    description: "One-shot convenience: base64 video bytes -> presigned PUT -> returns the key for dub_video. Prefer presign_upload for large files.",
    inputSchema: { type: "object", properties: {
      name: { type: "string" }, data_b64: { type: "string" } }, required: ["name", "data_b64"] },
  },
  {
    name: "get_job",
    description: "Poll a job: status queued|script|running|done|error|cancelled, minutes billed, per-language results with keys. Also advances server-side state.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "wait_job",
    description: "Poll until terminal (done/error/cancelled) or a parked 'script' gate state, with backoff. Default timeout 10 min.",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, timeout_s: { type: "number" } }, required: ["id"] },
  },
  {
    name: "get_script",
    description: "When a gated job reaches status 'script': full per-line translation (src+tgt, QC scores, glossary misses) + the preview sample URL. Free checkpoint — review before approving.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "approve_script",
    description: "Release a gated render; optionally fix lines first: edits={lang:{lineIndex:'new text'}}. Billing starts here: 1 credit-minute per finished minute per language (preview lines already synthesised are reused, not re-billed).",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, edits: { type: "object" } }, required: ["id"] },
  },
  {
    name: "redub_line",
    description: "Re-record ONE line of a finished job (text change, speed 0.75-1.5, or retake:true re-roll). Bills 1 credit-minute per edited line — never a full re-render.",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, lang: { type: "string" }, line: { type: "number" },
      text: { type: "string" }, speed: { type: "number" }, retake: { type: "boolean" } },
      required: ["id", "line"] },
  },
  {
    name: "download_master",
    description: "Short-lived (600s) URL of the dubbed master mp4 for one language.",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, lang: { type: "string" } }, required: ["id"] },
  },
  {
    name: "get_lines",
    description: "Per-line transcript of a finished language version: start/end/src/tgt/qc(0-1)/qc_text/gloss_miss.",
    inputSchema: { type: "object", properties: {
      id: { type: "string" }, lang: { type: "string" } }, required: ["id"] },
  },
  {
    name: "get_credits",
    description: "Plan + remaining credits in milli-minutes (1000 = 1 credit-minute = 1 finished video minute).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cancel_job",
    description: "Cancel a queued/running job. Cancelling at the 'script' gate is always free.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

async function callTool(name, args) {
  switch (name) {
    case "dub_video": {
      const body = { src: args.src, langs: args.langs,
        ...(args.delivery ? { delivery: args.delivery } : {}),
        ...(args.style ? { style: args.style } : {}),
        ...(args.gate === undefined ? {} : { gate: args.gate }) };
      const job = await api("POST", "/api/jobs", body);
      return { id: job.id, status: job.status, langs: job.langs,
        note: job.status === "queued" && args.gate !== false
          ? "gated: wait_job -> get_script -> (approve_script)" : "running; wait_job to finish" };
    }
    case "presign_upload":
      return api("POST", "/api/uploads", { name: args.name, type: "video/mp4", size: args.size });
    case "upload_video":
      return { key: await uploadFile(args.name, args.data_b64) };
    case "get_job":
      return api("GET", `/api/jobs/${args.id}`);
    case "wait_job": {
      const deadline = Date.now() + (args.timeout_s || 600) * 1000;
      let delay = 2000;
      for (;;) {
        const j = await api("GET", `/api/jobs/${args.id}`);
        if (["done", "error", "cancelled", "script"].includes(j.status)) return j;
        if (Date.now() > deadline) return { ...j, note: "timeout, still " + j.status };
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(15000, Math.round(delay * 1.5));
      }
    }
    case "get_script": {
      const j = await api("GET", `/api/jobs/${args.id}`);
      const lines = await api("GET", `/api/jobs/${args.id}/lines?script=1`).catch(() => null);
      return { job: j, script: lines, previews: (j.gate && j.gate.previews) || [] };
    }
    case "approve_script":
      return api("POST", `/api/jobs/${args.id}/approve`, { approved: args.edits || {} });
    case "redub_line": {
      const e = { i: args.line };
      if (args.text) e.tgt = args.text;
      if (args.speed) e.speed = args.speed;
      if (args.retake) e.retake = true;
      if (!e.tgt && !e.speed && !e.retake) throw new Error("need text, speed or retake");
      return api("POST", `/api/jobs/${args.id}/redub`, { lines: [e], ...(args.lang ? { lang: args.lang } : {}) });
    }
    case "download_master":
      return api("GET", `/api/jobs/${args.id}/download?kind=video${args.lang ? "&lang=" + args.lang : ""}`);
    case "get_lines":
      return api("GET", `/api/jobs/${args.id}/lines${args.lang ? "?lang=" + args.lang : ""}`);
    case "get_credits":
      return api("GET", "/api/me");
    case "cancel_job":
      return api("POST", `/api/jobs/${args.id}/cancel`);
    default: throw new Error("unknown tool: " + name);
  }
}

// ---- JSON-RPC over stdio ---------------------------------------------------
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    handle(m).catch(e => replyErr(m.id ?? null, -32603, String(e && e.message || e)));
  }
});

async function handle(m) {
  const { id, method, params } = m;
  if (method === "initialize") {
    reply(id, { protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: "voxtakes-mcp", version: "0.1.0" } });
  } else if (method === "notifications/initialized") {
    // no response for notifications
  } else if (method === "tools/list") {
    reply(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    try {
      const out = await callTool(name, args || {});
      reply(id, { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] });
    } catch (e) {
      reply(id, { content: [{ type: "text", text: JSON.stringify({ error: String(e.message || e), code: e.code || null, http: e.status || null }) }],
        isError: true });
    }
  } else if (method === "ping") {
    reply(id, {});
  } else if (id !== undefined) {
    replyErr(id, -32601, "method not found: " + method);
  }
}

process.stderr.write(`voxtakes-mcp ready (base=${BASE}, key=${KEY.slice(0, 11)}…)\n`);
