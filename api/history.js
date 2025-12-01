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

// Normaliza cada item vindo do Redis:
// - se vier string, faz JSON.parse
// - se vier objeto, usa direto
// - se não tiver "kind", assume "chat"
function normalizeItem(raw) {
  if (!raw) return null;

  let item = raw;

  if (typeof raw === "string") {
    try {
      item = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (!item || typeof item !== "object") return null;

  if (!item.kind) {
    item.kind = "chat";
  }

  return item;
}

// Resolve identidade igual ao /api/chat e /api/speaking
async function resolveUserId(req) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const uidParam = url.searchParams.get("uid");
  const tQuery   = url.searchParams.get("t");

  // 1) uid explícito na URL (se algum dia usar)
  if (uidParam) return uidParam;

  // 2) token t (LTI mobile Canvas)
  if (tQuery) {
    const fromT = await getUserFromToken(tQuery);
    if (fromT) return fromT;
  }

  // 3) cookie LTI (Canvas web)
  const cookies = parseCookies(req.headers.cookie || "");
  if (cookies["lti_user"]) return cookies["lti_user"];

  return null;
}

export default async function handler(req, res) {
  try {
    // desliga cache pra sempre pegar o histórico mais novo
    res.setHeader("Cache-Control", "no-store");

    const url = new URL(req.url, `https://${req.headers.host}`);
    const kindFilter = url.searchParams.get("kind"); // opcional
    const limitParam = url.searchParams.get("limit");

    let limit = Number(limitParam) || 400;
    if (limit < 10) limit = 10;
    if (limit > 1000) limit = 1000;

    const userId = await resolveUserId(req);

    if (!userId) {
      return res.status(401).json({
        error: "no_identity",
        detail: "Não foi possível identificar o usuário para recuperar o histórico.",
      });
    }

    const key = historyKey(userId);

    // pega os últimos N registros (user+assistant, chat+speaking)
    const raw = await redis.lrange(key, -limit, -1);

    let items =
      (raw || [])
        .map(normalizeItem)
        .filter(Boolean) || [];

    // filtro por tipo de histórico (chat / speaking)
    if (kindFilter === "chat" || kindFilter === "speaking") {
      items = items.filter((it) => it.kind === kindFilter);
    }

    // ordena por timestamp
    items.sort((a, b) => {
      const ta = typeof a.ts === "number" ? a.ts : 0;
      const tb = typeof b.ts === "number" ? b.ts : 0;
      return ta - tb;
    });

    return res.status(200).json({
      items,
      userId,
      historyCount: items.length,
      key,
    });
  } catch (e) {
    console.error("HISTORY error:", e);
    return res.status(500).json({ error: e?.message || "history error" });
  }
}

export const config = { api: { bodyParser: false } };
