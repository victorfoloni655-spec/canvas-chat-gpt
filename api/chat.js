// /api/chat.js
// Chat + limitador mensal + histórico simples no Redis.
// Identidade: uid (body) OU token 't' (JWT) OU cookie lti_user.

import { Redis } from "@upstash/redis";
import { jwtVerify } from "jose";

// ====== CONFIG ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini";

const MONTHLY_LIMIT  = Number(process.env.MONTHLY_LIMIT || 400);
const QUOTA_PREFIX   = process.env.QUOTA_PREFIX || "quota";

// Links de checkout (opcionais)
const CHECKOUT_URL_50  = process.env.CHECKOUT_URL_50  || null;
const CHECKOUT_URL_100 = process.env.CHECKOUT_URL_100 || null;
const CHECKOUT_URL_200 = process.env.CHECKOUT_URL_200 || null;

// Histórico
const HISTORY_PREFIX = process.env.HISTORY_PREFIX || "history";
const HISTORY_MAX    = Number(process.env.HISTORY_MAX || 40);

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ====== UTILS ======
function parseCookies(h = "") {
  return Object.fromEntries((h || "").split(";").map((s) => s.trim().split("=")));
}

function monthKey(userId) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${QUOTA_PREFIX}:${y}-${m}:${userId}`;
}

async function incrMonthlyAndCheck(key, limit) {
  const used = await redis.incr(key);
  if (used === 1) {
    const now = new Date();
    const expireAt = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() + 1,
      1
    ) / 1000;
    await redis.expireat(key, expireAt);
  }
  return { used, blocked: used > limit };
}

async function getUserIdFromToken(t) {
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const { payload } = await jwtVerify(t, secret);
    return payload?.sub || null;
  } catch {
    return null;
  }
}

function historyKey(userId) {
  return `${HISTORY_PREFIX}:${userId}`;
}

// resolve identidade de forma consistente com /api/history
async function resolveUserId(req, body) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const uidParam = url.searchParams.get("uid");
  const tQuery   = url.searchParams.get("t");

  const uidBody = body?.uid;
  const tBody   = body?.t;

  // 1) uid vindo do body (frontend manda em todas as chamadas)
  if (uidBody) return uidBody;

  // 2) uid via query (se algum dia usar)
  if (uidParam) return uidParam;

  // 3) token t
  const token = tBody || tQuery;
  if (token) {
    const fromT = await getUserIdFromToken(token);
    if (fromT) return fromT;
  }

  // 4) cookie LTI
  const cookies = parseCookies(req.headers.cookie || "");
  if (cookies["lti_user"]) {
    return cookies["lti_user"];
  }

  return null;
}

// ====== HISTÓRICO ======
async function appendHistory(userId, userText, botText) {
  try {
    const key = historyKey(userId);
    const now = Date.now();

    const entryUser = JSON.stringify({
      kind: "chat",
      role: "user",
      content: String(userText || ""),
      ts: now,
    });

    const entryBot = JSON.stringify({
      kind: "chat",
      role: "assistant",
      content: String(botText || ""),
      ts: now,
    });

    await redis.rpush(key, entryUser, entryBot);
    await redis.ltrim(key, -HISTORY_MAX, -1);
  } catch (e) {
    console.error("Erro ao salvar histórico:", e);
  }
}

// ====== OPENAI ======
async function callOpenAI(messages) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada");

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: OPENAI_MODEL, messages, temperature: 0.7 }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`OpenAI erro ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

async function readJson(req) {
  const raw = await new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

// ====== HANDLER ======
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = await readJson(req);
    const { messages } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages must be a non-empty array" });
    }

    const userId = await resolveUserId(req, body);

    if (!userId) {
      return res.status(401).json({
        error: "no_user",
        detail: "Não foi possível identificar o aluno (uid / token / cookie ausentes).",
      });
    }

    // Limite mensal
    const quotaKey = monthKey(userId);
    const { used, blocked } = await incrMonthlyAndCheck(quotaKey, MONTHLY_LIMIT);
    if (blocked) {
      const packages = [];
      if (CHECKOUT_URL_50)  packages.push({ label: "+50 mensagens",  url: CHECKOUT_URL_50,  amount: 50  });
      if (CHECKOUT_URL_100) packages.push({ label: "+100 mensagens", url: CHECKOUT_URL_100, amount: 100 });
      if (CHECKOUT_URL_200) packages.push({ label: "+200 mensagens", url: CHECKOUT_URL_200, amount: 200 });

      return res.status(429).json({
        error: "limit_reached",
        message: "Limite mensal atingido.",
        used,
        limit: MONTHLY_LIMIT,
        packages,
      });
    }

    // Texto da última mensagem do aluno (pra salvar no histórico)
    const lastUserMsg = messages
      .slice()
      .reverse()
      .find((m) => m.role === "user");
    const userTextForHistory = lastUserMsg?.content || "";

    // Chamada ao OpenAI
    const reply = await callOpenAI(messages);

    // Salva histórico
    await appendHistory(userId, userTextForHistory, reply);

    // Debug: quantos itens existem nessa lista?
    let historyDebugCount = 0;
    try {
      const debugRaw = await redis.lrange(historyKey(userId), 0, -1);
      historyDebugCount = debugRaw.length;
    } catch (e) {
      console.error("Erro ao ler histórico para debug:", e);
    }

    return res.status(200).json({
      reply,
      used,
      limit: MONTHLY_LIMIT,
      userId,
      historyDebugCount,
    });
  } catch (e) {
    console.error("CHAT error:", e);
    return res.status(500).json({ error: e?.message || "internal error" });
  }
}

export const config = { api: { bodyParser: false } };
