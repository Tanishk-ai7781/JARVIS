/* JARVIS AI server (Vercel serverless function)
   POST /api/chat   body: { message: string, history: [{role:"user"|"ai", text:string}] }
   reply:           { reply: string }
   GET  /api/chat   health check: shows which AI providers have a key set (never the keys).

   Keys live only in Vercel environment variables:
     GEMINI_API_KEY   (Google AI Studio)      optional
     OPENAI_API_KEY   (OpenAI / ChatGPT API)  optional
     AI_PROVIDER      "auto" (default), "gemini" or "openai"
     GEMINI_MODEL     default gemini-3.5-flash-lite
     OPENAI_MODEL     default gpt-5.4-mini
   In "auto" mode Gemini answers first and ChatGPT is the backup (or the other way round
   if only one key is set). */

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const MAX_MESSAGE = 2000;      // characters per question
const MAX_HISTORY = 12;        // earlier messages sent for context
const MAX_HISTORY_CHARS = 1500;
const RATE_PER_MINUTE = 15;    // per visitor IP (best effort, per server instance)
const UPSTREAM_TIMEOUT_MS = 20000;

const SYSTEM = [
  "You are JARVIS, a personal AI assistant owned and founded by Mr. Tanishk.",
  "Your replies are often read aloud, so write plain conversational text: no markdown symbols, no tables, no emoji.",
  "Keep answers short (one to four sentences) unless the user asks for detail or a step-by-step solution.",
  "For maths and science, show the steps in plain words and numbers.",
  "Reply in the language the user writes in (English, Hindi or Hinglish).",
  "Occasionally, not every time, address the user as boss.",
  "You are an AI. Be honest when you are unsure and never invent facts, quotes or sources.",
  "You cannot open apps, see photos or access the user's phone beyond what the app's built-in commands do, so do not claim to.",
  "Do not give certain medical, legal or financial advice; suggest a qualified person for important decisions.",
  "Politely refuse anything harmful, illegal or abusive."
].join(" ");

const hits = new Map(); // ip -> recent request times

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < 60000)) hits.delete(k);
  }
  return recent.length > RATE_PER_MINUTE;
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                 // not a browser request
  if (origin === "null") return true;       // the Android app (local file)
  try {
    if (new URL(origin).host === req.headers.host) return true;
  } catch (e) { /* ignore */ }
  const extra = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return extra.includes(origin);
}

/* Conversation as [{role:"user"|"assistant", text}], starting with the user, roles alternating. */
function buildTurns(history, message) {
  const list = [];
  const items = Array.isArray(history) ? history.slice(-MAX_HISTORY) : [];
  for (const m of items) {
    if (!m || typeof m.text !== "string") continue;
    const role = m.role === "user" ? "user" : m.role === "ai" ? "assistant" : null;
    if (!role) continue;
    list.push({ role, text: m.text.slice(0, MAX_HISTORY_CHARS) });
  }
  // The app adds the new question to history before sending; avoid sending it twice.
  if (list.length && list[list.length - 1].role === "user" && list[list.length - 1].text === message.slice(0, MAX_HISTORY_CHARS)) {
    list.pop();
  }
  list.push({ role: "user", text: message });
  while (list.length && list[0].role !== "user") list.shift();
  const merged = [];
  for (const m of list) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.text += "\n" + m.text;
    else merged.push({ role: m.role, text: m.text });
  }
  return merged;
}

function fail(status, kind) {
  const e = new Error(kind);
  e.status = status;
  e.kind = kind;
  return e;
}

async function callGemini(turns) {
  const key = process.env.GEMINI_API_KEY;
  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] })),
    generationConfig: { temperature: 0.7, maxOutputTokens: 700 }
  };
  let r;
  try {
    r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(GEMINI_MODEL) + ":generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      }
    );
  } catch (e) {
    throw fail(0, e && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network");
  }
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.text()).slice(0, 300); } catch (e) { /* ignore */ }
    console.error("Gemini error", r.status, GEMINI_MODEL, detail); // never the user's message
    throw fail(r.status, r.status === 429 ? "busy" : r.status === 404 ? "model" : r.status === 400 || r.status === 403 ? "key" : "upstream");
  }
  const data = await r.json();
  const cand = data && data.candidates && data.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p.text || "").join("").trim() : "";
  if (!text) {
    const blocked = (data && data.promptFeedback && data.promptFeedback.blockReason) || (cand && cand.finishReason === "SAFETY");
    return blocked ? "I can't help with that one, boss." : "";
  }
  return text;
}

async function callOpenAI(turns) {
  const key = process.env.OPENAI_API_KEY;
  const payload = {
    model: OPENAI_MODEL,
    messages: [{ role: "system", content: SYSTEM }].concat(turns.map((t) => ({ role: t.role, content: t.text }))),
    max_completion_tokens: 1200 // leaves room for hidden reasoning on newer models
  };
  let r;
  try {
    r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (e) {
    throw fail(0, e && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network");
  }
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.text()).slice(0, 300); } catch (e) { /* ignore */ }
    console.error("OpenAI error", r.status, OPENAI_MODEL, detail);
    throw fail(r.status, r.status === 429 ? "busy" : r.status === 404 ? "model" : r.status === 401 || r.status === 403 ? "key" : r.status === 400 ? "request" : "upstream");
  }
  const data = await r.json();
  const choice = data && data.choices && data.choices[0];
  const text = choice && choice.message && typeof choice.message.content === "string" ? choice.message.content.trim() : "";
  if (!text) {
    return choice && choice.message && choice.message.refusal ? "I can't help with that one, boss." : "";
  }
  return text;
}

function providerOrder() {
  const have = [];
  if (process.env.GEMINI_API_KEY) have.push("gemini");
  if (process.env.OPENAI_API_KEY) have.push("openai");
  const pref = (process.env.AI_PROVIDER || "auto").toLowerCase();
  if (pref === "gemini" || pref === "openai") {
    const rest = have.filter((p) => p !== pref);
    return have.includes(pref) ? [pref].concat(rest) : have; // backup if the preferred key is missing
  }
  return have; // auto: Gemini first, ChatGPT as backup
}

const MESSAGES = {
  busy: "The AI is busy right now. Try again shortly.",
  timeout: "The AI took too long to answer.",
  model: "The AI model name is not available. Check GEMINI_MODEL / OPENAI_MODEL on the server.",
  key: "The AI key or request was rejected. Check the API keys on the server.",
  request: "The AI could not handle that request.",
  network: "Could not reach the AI service.",
  upstream: "The AI service had a problem."
};

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      providers: providerOrder(),
      models: { gemini: GEMINI_MODEL, openai: OPENAI_MODEL }
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!originAllowed(req)) return res.status(403).json({ error: "Origin not allowed." });

  const order = providerOrder();
  if (!order.length) return res.status(500).json({ error: "No AI key is configured on the server." });

  const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  if (rateLimited(ip)) return res.status(429).json({ error: "Too many requests. Try again in a minute." });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const message = body && typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return res.status(400).json({ error: "Message is required." });
  if (message.length > MAX_MESSAGE) return res.status(400).json({ error: "Message is too long." });

  const turns = buildTurns(body.history, message);
  let lastKind = "upstream";
  let lastStatus = 502;

  for (const name of order) {
    try {
      const text = name === "gemini" ? await callGemini(turns) : await callOpenAI(turns);
      if (text) {
        res.setHeader("X-JARVIS-Provider", name);
        return res.status(200).json({ reply: text });
      }
      lastKind = "empty";
    } catch (e) {
      lastKind = (e && e.kind) || "upstream";
      lastStatus = e && e.status === 429 ? 429 : e && e.kind === "timeout" ? 504 : 502;
    }
    // try the next provider, if there is one
  }

  if (lastKind === "empty") {
    return res.status(200).json({ reply: "I couldn't come up with an answer. Please try asking again." });
  }
  return res.status(lastStatus).json({ error: MESSAGES[lastKind] || MESSAGES.upstream });
};
