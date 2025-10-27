// /api/admin/users.js
// Lista os usuários ativos no mês e suas mensagens usadas.
// Protegido por ADMIN_SECRET. Suporta ?month=YYYY-MM (opcional).

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const QUOTA_PREFIX = process.env.QUOTA_PREFIX || "quota";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

function monthKey(userId, y, m) {
  return `${QUOTA_PREFIX}:${y}-${m}:${userId}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
    if (!ADMIN_SECRET) return res.status(500).json({ error: "admin_secret_missing" });

    // Auth: Authorization: Bearer <ADMIN_SECRET>
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (auth !== ADMIN_SECRET) return res.status(403).json({ error: "forbidden" });

    // mês atual por padrão
    const now = new Date();
    const _y = now.getUTCFullYear();
    const _m = String(now.getUTCMonth() + 1).padStart(2, "0");

    const month = (req.query?.month || `${_y}-${_m}`).toString();
    const [y, m] = month.split("-");
    if (!y || !m) return res.status(400).json({ error: "bad_month", example: "YYYY-MM" });

    const setKey = `${QUOTA_PREFIX}_users:${y}-${m}`;
    const users = (await redis.smembers(setKey)) || [];

    // busca os "used" de cada user
    const keys = users.map(u => monthKey(u, y, m));
    const usedArr = keys.length ? await redis.mget(...keys) : [];

    const list = users.map((u, i) => ({
      user: u,
      used: Number(usedArr?.[i] || 0),
      key: keys[i],
    }));

    // ordena por mais usado
    list.sort((a, b) => b.used - a.used);

    return res.status(200).json({ month, totalUsers: list.length, users: list });
  } catch (e) {
    console.error("ADMIN users error:", e);
    return res.status(500).json({ error: e?.message || "admin_users_error" });
  }
}
