// /api/speaking-quota.js
// Retorna quanto tempo de speaking já foi usado e o limite mensal em segundos.

import { Redis } from "@upstash/redis";
import { jwtVerify } from "jose";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Mesmo prefixo/limite do /api/speaking.js
const SPEAKING_PREFIX = process.env.SPEAKING_PREFIX || "speaking";
const SPEAKING_LIMIT_SECONDS =
  Number(process.env.SPEAKING_MONTHLY_LIMIT_SECONDS) ||
  (Number(process.env.SPEAKING_MONTHLY_LIMIT_MINUTES || 20) * 60);

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

function monthKey(userId) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${SPEAKING_PREFIX}:${y}-${m}:${userId}`;
}

// Mesmo esquema de identidade do /api/history (uid -> t -> cookie)
async function resolveUserId(req) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const uidParam = url.searchParams.get("uid");
  const tQuery   = url.searchParams.get("t");

  // 1) uid direto da URL (frontend manda ?uid=xxx)
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
    const userId = await resolveUserId(req);

    if (!userId) {
      return res.status(401).json({
        error: "no_identity",
        detail: "Não foi possível identificar o usuário para consultar a cota de speaking.",
      });
    }

    const key = monthKey(userId);
    const used = Number((await redis.get(key)) || 0);

    const remainingSeconds = Math.max(0, SPEAKING_LIMIT_SECONDS - used);

    return res.status(200).json({
      userId,
      key,
      usedSeconds: used,
      limitSeconds: SPEAKING_LIMIT_SECONDS,
      remainingSeconds,
    });
  } catch (e) {
    console.error("SPEAKING_QUOTA error:", e);
    return res.status(500).json({
      error: "speaking_quota_error",
      message: e?.message || "Erro ao consultar cota de speaking.",
    });
  }
}

export const config = { api: { bodyParser: false } };
