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
    (h || "")
      .split(";")
      .map((s) => s.trim().split("="))
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

// Garante que todo item tenha um "kind"
function normalizeItem(item) {
  if (!item) return null;
  if (!item.kind) {
    return { ...item, kind: "chat" };
  }
  return item;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);

    const t          = url.searchParams.get("t");     // token JWT (opcional)
    const uidParam   = url.searchParams.get("uid");   // userId forçado (opcional)
    const kindFilter = url.searchParams.get("kind");  // "chat" ou "speaking" (opcional)
    const limitParam = url.searchParams.get("limit"); // qtd máx itens (opcional)

    // limite máx de itens retornados
    let limit = Number(limitParam) || 400;
    if (limit < 10)   limit = 10;
    if (limit > 1000) limit = 1000;

    let userId = null;

    // 1) se veio uid na query, ele manda
    if (uidParam) {
      userId = uidParam;
    }

    // 2) se não, tenta token t (JWT)
    if (!userId && t) {
      userId = await getUserFromToken(t);
    }

    // 3) se ainda não, cai no cookie lti_user
    if (!userId) {
      const cookies = parseCookies(req.headers.cookie || "");
      userId = cookies["lti_user"] || null;
    }

    if (!userId) {
      return res.status(401).json({
        error: "no_identity",
        detail: "Abra pelo Canvas (LTI) ou envie um token para recuperar o histórico.",
      });
    }

    const key = historyKey(userId);

    // pega só os últimos "limit" registros
    const raw = await redis.lrange(key, -limit, -1); // lista de strings JSON

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

    // ordena por timestamp crescente (se tiver ts)
    items.sort((a, b) => {
      const ta = typeof a.ts === "number" ? a.ts : 0;
      const tb = typeof b.ts === "number" ? b.ts : 0;
      return ta - tb;
    });

    // DEBUG importante:
    console.log("HISTORY endpoint →", {
      userId,
      key,
      count: items.length,
    });

    return res.status(200).json({ items, userId });
  } catch (e) {
    console.error("HISTORY error:", e);
    return res.status(500).json({ error: e?.message || "history error" });
  }
}

export const config = { api: { bodyParser: false } };
