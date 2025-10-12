// /api/chat.js  (Vercel Serverless Function – Node runtimes)

function setCORS(res, origin) {
  const allow = (process.env.ORIGIN_ALLOWLIST || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const ok = origin && allow.some(p => {
    if (p.startsWith("https://*.")) {
      const base = p.replace("https://*.", "");
      return origin === `https://${base}` || origin.endsWith(`.${base}`);
    }
    return origin === p;
  });
  res.setHeader("Access-Control-Allow-Origin", ok ? origin : (allow[0] || "*"));
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
}

export default async function handler(req, res) {
  setCORS(res, req.headers.origin || null);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { messages, max_history = 12, stream = true } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
    }

    // reduz custo: envia só as últimas N trocas
    const trimmed = messages.slice(-Math.max(2, max_history));

    const payload = {
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: trimmed,
      temperature: 0.2,
      stream
    };

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).json({ error: txt });
    }

    if (stream) {
      // repassa Streaming SSE diretamente para o cliente
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value));
      }
      return res.end();
    }

    // modo não-stream
    const data = await r.json();
    const reply = data?.choices?.[0]?.message?.content ?? "";
    return res.status(200).json({ reply });

  } catch (e) {
    return res.status(500).json({ error: e?.message || "Internal error" });
  }
}
