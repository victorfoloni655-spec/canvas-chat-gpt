// /api/quota.js — devolve uso mensal do aluno atual
// Suporta: cookie lti_user (desktop) OU token 't' (JWT) via query (mobile/iframe)

import { Redis } from "@upstash/redis";
import { jwtVerify } from "jose";

function parseCookies(h = "") {
  return Object.fromEntries((h || "").split(";").map(s => s.trim().split("=")));
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const QUOTA_PREFIX = process.env.QUOTA_PREFIX || "quota";
const MONTHLY_LIMIT = Number(process.env.MONTHLY_LIMIT || 400);

function monthKey(userId) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${QUOTA_PREFIX}:${y}-${m}:${userId}`;
}

async function getUserFromToken(t) {
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const { payload } = await jwtVerify(t, secret);
    return payload?.sub || null; // sub = userId (hash) que geramos no launch
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  try {
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

    const key = monthKey(user);
    const used = Number((await redis.get(key)) || 0);
    const remaining = Math.max(0, MONTHLY_LIMIT - used);

    res.status(200).json({ user, key, used, remaining, limit: MONTHLY_LIMIT });
  } catch (e) {
    res.status(500).json({ error: e?.message || "quota error" });
  }
}

export const config = { api: { bodyParser: false } };
