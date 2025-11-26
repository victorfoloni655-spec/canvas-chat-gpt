// /api/history.js
// Retorna o histórico simples do aluno (lista de mensagens user/assistant).

import { Redis } from "@upstash/redis";
import { jwtVerify } from "jose";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const HISTORY_PREFIX = process.env.HISTORY_PREFIX || "history";

function parseCookies(h = "") {
  return Object.fromEntries((h || "").split(";").map(s => s.trim().split("=")));
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

export default async function handler(req, res) {
  try {
    // Identidade: token 't' (mobile) ou cookie lti_user (desktop)
    const url = new URL(req.url, `https://${req.headers.host}`);
    const t = url.searchParams.get("t");

    let user = null;
    if (t) {
      user = await getUserFromToken(t);
    }
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
    const raw = await redis.lrange(key, 0, -1); // lista de strings JSON
    const items = (raw || []).map(str => {
      try { return JSON.parse(str); } catch { return null; }
    }).filter(Boolean);

    return res.status(200).json({ items });
  } catch (e) {
    console.error("HISTORY error:", e);
    return res.status(500).json({ error: e?.message || "history error" });
  }
}

export const config = { api: { bodyParser: false } };
