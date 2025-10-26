// /api/quota.js — devolve uso mensal do aluno atual (via cookie lti_user)
import { Redis } from "@upstash/redis";

function parseCookies(h = "") {
  return Object.fromEntries((h || "").split(";").map(s => s.trim().split("=")));
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// IMPORTANTe: prefixo e chave devem ser IGUAIS aos do /api/chat.js
const QUOTA_PREFIX = process.env.QUOTA_PREFIX || "quota";

function monthKey(userId) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${QUOTA_PREFIX}:${y}-${m}:${userId}`;
}

export default async function handler(req, res) {
  try {
    const cookies = parseCookies(req.headers.cookie || "");
    const user = cookies["lti_user"]; // setado em /api/lti/launch

    if (!user) {
      return res.status(401).json({
        error: "no_lti_cookie",
        detail: "Abra o chat pelo Canvas para identificarmos você.",
      });
    }

    const limit = Number(process.env.MONTHLY_LIMIT || 4);
    const key = monthKey(user);
    const used = Number((await redis.get(key)) || 0);
    const remaining = Math.max(0, limit - used);

    res.status(200).json({ user, key, used, remaining, limit });
  } catch (e) {
    res.status(500).json({ error: e?.message || "quota error" });
  }
}
