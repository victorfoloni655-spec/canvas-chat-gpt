// /api/history.js — devolve histórico de mensagens do aluno atual
// Usa a mesma lógica de identificação do /api/quota.js (token t OU cookie lti_user)

import { Redis } from "@upstash/redis";
import { jwtVerify } from "jose";

function parseCookies(h = "") {
  return Object.fromEntries((h || "").split(";").map(s => s.trim().split("=")));
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// prefixo das chaves de histórico no Redis
const HISTORY_PREFIX = process.env.HISTORY_PREFIX || "history";

async function getUserFromToken(t) {
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const { payload } = await jwtVerify(t, secret);
    return payload?.sub || null; // sub = userId (hash) que geramos no launch
  } catch {
    return null;
  }
}

function historyKey(userId) {
  return `${HISTORY_PREFIX}:${userId}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "method_not_allowed" });
    }

    // 1) tenta token 't' (mobile/iframe)
    const url = new URL(req.url, `https://${req.headers.host}`);
    const t = url.searchParams.get("t");

    let user = null;
    if (t) {
      user = await getUserFromToken(t);
    }

    // 2) fallback: cookie (desktop)
    if (!user) {
      const cookies = parseCookies(req.headers.cookie || "");
      user = cookies["lti_user"] || null;
    }

    if (!user) {
      return res.status(401).json({
        error: "no_identity",
        detail: "Abra pelo Canvas (LTI) para identificar você.",
      });
    }

    const key = historyKey(user);

    // pega até as últimas 100 entradas (cada entrada = {role, content, ts})
    const raw = await redis.lrange(key, 0, 99);

    const items = (raw || [])
      .map((x) => {
        try { return JSON.parse(x); } catch { return null; }
      })
      .filter(Boolean)
      .reverse(); // mais antigas primeiro

    return res.status(200).json({ items });
  } catch (e) {
    console.error("HISTORY error:", e);
    return res.status(500).json({ error: e?.message || "history error" });
  }
}

export const config = { api: { bodyParser: false } };
