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

    // novo: uid vindo do front (o mesmo userId que o /api/chat usa)
    const uidParam   = url.searchParams.get("uid");
    const t          = url.searchParams.get("t");
    const kindFilter = url.searchParams.get("kind"); // opcional: "chat" ou "speaking"
    const limitParam = url.searchParams.get("limit");

    let limit = Number(limitParam) || 400;
    if (limit < 10) limit = 10;
    if (limit > 1000) limit = 1000;

    let user = null;

    // 1º prioridade: uid explícito (vem direto do /api/chat)
    if (uidParam) {
      user = uidParam;
    } else if (t) {
      // 2º: token JWT, se tiver
      user = await getUserFromToken(t);
    }

    // 3º: fallback cookie lti_user
    if (!user) {
      const cookies = parseCookies(req.headers.cookie || "");
      user = cookies["lti_user"] || null;
    }

    if (!user) {
      return res.status(401).json({
        error: "no_identity",
        detail: "Abra pelo Canvas (LTI) para recuperar o histórico.",
      });
    }

    const key = historyKey(user);

    // pega só os últimos "limit" registros
    const raw = await redis.lrange(key, -limit, -1);

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

    if (kindFilter === "chat" || kindFilter === "speaking") {
      items = items.filter((it) => it.kind === kindFilter);
    }

    items.sort((a, b) => {
      const ta = typeof a.ts === "number" ? a.ts : 0;
      const tb = typeof b.ts === "number" ? b.ts : 0;
      return ta - tb;
    });

    return res.status(200).json({
      items,
      // debug leve, só pra conferência se precisar
      // debug: { user, key, count: items.length },
    });
  } catch (e) {
    console.error("HISTORY error:", e);
    return res.status(500).json({ error: e?.message || "history error" });
  }
}

export const config = { api: { bodyParser: false } };
