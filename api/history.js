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
function normalizeItem(item) {
  if (!item) return null;
  if (!item.kind) return { ...item, kind: "chat" };
  return item;
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
    const raw = await redis.lrange(key, -limit, -1); // últimos N registros

    let items =
      (raw || [])
        .map((str) => {
          try {
            return JSON.parse(str);
          } catch {
            return null;
          }
        })
        .map(normalizeItem)
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

    return res.status(200).json({ items, userId: user });
  } catch (e) {
    console.error("HISTORY error:", e);
    return res.status(500).json({ error: e?.message || "history error" });
  }
}

export const config = { api: { bodyParser: false } };
