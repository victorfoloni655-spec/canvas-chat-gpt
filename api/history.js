// /api/history.js
// Retorna o histórico unificado do aluno (chat + speaking).

import { Redis } from "@upstash/redis";
import { jwtVerify } from "jose";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const HISTORY_PREFIX = process.env.HISTORY_PREFIX || "history";

function parseCookies(h = "") {
  return Object.fromEntries(
    (h || "").split(";").map((s) => s.trim().split("="))
  );
}

async function getUserFromToken(t) {
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

// Garante que itens antigos (sem "kind") sejam tratados como chat
function normalizeItem(obj) {
  if (!obj) return null;
  if (!obj.kind) {
    return { ...obj, kind: "chat" };
  }
  return obj;
}

// Converte uma string crua do Redis em objeto de histórico
function parseHistoryString(str) {
  if (!str) return null;

  // 💥 Valores antigos que foram gravados como [object Object]
  // não têm conteúdo útil, então ignoramos.
  if (typeof str === "string" && /^\[object\b/i.test(str)) {
    return null;
  }

  // Tenta interpretar como JSON primeiro
  try {
    const parsed = JSON.parse(str);
    return normalizeItem(parsed);
  } catch {
    // Fallback: se não for JSON mas também não for "[object Object]",
    // tratamos como uma mensagem de chat do assistant com esse texto.
    return normalizeItem({
      kind: "chat",
      role: "assistant",
      content: String(str),
      ts: 0, // sem timestamp real
    });
  }
}

// Resolve identidade de forma consistente com /api/chat e /api/speaking
async function resolveUserId(req) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const uidParam = url.searchParams.get("uid");
  const tQuery   = url.searchParams.get("t");

  // 1) uid da URL (frontend manda ?uid=xxx)
  if (uidParam) return uidParam;

  // 2) token t (se existir)
  if (tQuery) {
    const fromT = await getUserFromToken(tQuery);
    if (fromT) return fromT;
  }

  // 3) cookie LTI (Canvas)
  const cookies = parseCookies(req.headers.cookie || "");
  if (cookies["lti_user"]) return cookies["lti_user"];

  return null;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const kindFilter = url.searchParams.get("kind"); // "chat" ou "speaking" (opcional)
    const limitParam = url.searchParams.get("limit");

    let limit = Number(limitParam) || 400;
    if (limit < 10) limit = 10;
    if (limit > 1000) limit = 1000;

    const user = await resolveUserId(req);

    if (!user) {
      return res.status(401).json({
        error: "no_identity",
        detail: "Não foi possível identificar o usuário para recuperar o histórico.",
      });
    }

    const key = historyKey(user);

    // Lê TUDO que tem no Redis pra esse usuário
    const rawAll = await redis.lrange(key, 0, -1); // lista de strings
    const historyCount = rawAll?.length || 0;

    // Mantém só os últimos "limit" em memória
    const raw = historyCount > limit ? rawAll.slice(historyCount - limit) : rawAll;

    let items =
      (raw || [])
        .map((str) => parseHistoryString(str))
        .filter(Boolean) || [];

    // filtro opcional por tipo
    if (kindFilter === "chat" || kindFilter === "speaking") {
      items = items.filter((it) => it.kind === kindFilter);
    }

    // ordena por timestamp crescente
    items.sort((a, b) => {
      const ta = typeof a.ts === "number" ? a.ts : 0;
      const tb = typeof b.ts === "number" ? b.ts : 0;
      return ta - tb;
    });

    return res.status(200).json({
      items,
      userId: user,
      historyCount,
    });
  } catch (e) {
    console.error("HISTORY error:", e);
    return res.status(500).json({ error: e?.message || "history error" });
  }
}

export const config = { api: { bodyParser: false } };
