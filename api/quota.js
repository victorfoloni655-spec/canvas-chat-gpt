// /api/quota.js — devolve uso mensal do aluno atual
import { Redis } from "@upstash/redis";
import { jwtVerify } from "jose";

function parseCookies(h = "") {
  return Object.fromEntries((h || "").split(";").map(s => s.trim().split("=")));
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// IMPORTANTE: prefixo deve ser igual ao do /api/chat.js
const QUOTA_PREFIX  = process.env.QUOTA_PREFIX || "quota";
const MONTHLY_LIMIT = Number(process.env.MONTHLY_LIMIT || 400);

function monthKey(userId) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${QUOTA_PREFIX}:${y}-${m}:${userId}`;
}

async function verifyToken(t) {
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const { payload } = await jwtVerify(t, secret);
    return payload?.sub || null; // sub = userId
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    // 1) tenta cookie
    const cookies = parseCookies(req.headers.cookie || "");
    let user = cookies["lti_user"];

    // 2) fallback: token ?t=... na query (funciona dentro do iframe no iOS/Android)
    if (!user) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const t = url.searchParams.get("t");
      if (t) user = await verifyToken(t);
    }

    if (!user) {
      return res.status(401).json({
        error: "no_user",
        detail: "Abra o chat pelo Canvas (ou com token).",
      });
    }

    const key = monthKey(user);
    const used = Number((await redis.get(key)) || 0);
    const remaining = Math.max(0, MONTHLY_LIMIT - used);

    return res.status(200).json({ user, key, used, remaining, limit: MONTHLY_LIMIT });
  } catch (e) {
    console.error("QUOTA error:", e);
    return res.status(500).json({ error: e?.message || "quota error" });
  }
}
