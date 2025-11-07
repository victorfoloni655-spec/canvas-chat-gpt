// /api/admin/users.js
// Lista os usuários ativos no mês e suas mensagens usadas.
// Protegido por ADMIN_SECRET.
// Query params:
//   - month=YYYY-MM (opcional; default = mês UTC atual)
//   - offset=0&limit=50 (opcionais; paginação)
//   - format=csv (opcional; exporta CSV)

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const QUOTA_PREFIX = process.env.QUOTA_PREFIX || "quota";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const MONTHLY_LIMIT = Number(process.env.MONTHLY_LIMIT || 400);

function monthKey(userId, y, m) {
  return `${QUOTA_PREFIX}:${y}-${m}:${userId}`;
}

export default async function handler(req, res) {
  try {
    if ((req.method || "GET").toUpperCase() !== "GET") {
      return res.status(405).json({ error: "method_not_allowed" });
    }
    if (!ADMIN_SECRET) {
      return res.status(500).json({ error: "admin_secret_missing" });
    }

    // Auth: Authorization: Bearer <ADMIN_SECRET>
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (auth !== ADMIN_SECRET) {
      return res.status(403).json({ error: "forbidden" });
    }

    // Mês UTC atual por padrão
    const now = new Date();
    const defY = now.getUTCFullYear();
    const defM = String(now.getUTCMonth() + 1).padStart(2, "0");

    const q = req.query || {};
    const monthParam = (q.month || `${defY}-${defM}`).toString();

    // Valida month
    if (!/^\d{4}-\d{2}$/.test(monthParam)) {
      return res.status(400).json({ error: "bad_month", example: "YYYY-MM" });
    }
    const [y, m] = monthParam.split("-");

    // Paginação
    const offset = Math.max(0, parseInt(q.offset ?? "0", 10) || 0);
    const limit  = Math.max(1, Math.min(1000, parseInt(q.limit ?? "1000", 10) || 1000)); // padrão: tudo (até 1000)

    // Coleta usuários registrados no mês (set preenchido no /api/chat.js via SADD)
    const setKey = `${QUOTA_PREFIX}_users:${y}-${m}`;
    const users = (await redis.smembers(setKey)) || [];

    // Ordenação/used
    const keys = users.map((u) => monthKey(u, y, m));
    const usedArr = keys.length ? await redis.mget(...keys) : [];
    const listAll = users.map((u, i) => ({
      user: u,
      used: Number(usedArr?.[i] || 0),
      key: keys[i],
    }));

    // Ordena por mais usado
    listAll.sort((a, b) => b.used - a.used);

    // Recorte por paginação
    const slice = listAll.slice(offset, offset + limit);

    // CSV?
    if ((q.format || "").toString().toLowerCase() === "csv") {
      const rows = [
        "month,user,used,key,limit",
        ...slice.map((r) => `${monthParam},${r.user},${r.used},${r.key},${MONTHLY_LIMIT}`),
      ];
      const csv = rows.join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(csv);
    }

    // JSON (default)
    return res.status(200).json({
      month: monthParam,
      totalUsers: listAll.length,
      offset,
      limit,
      limitPerUser: MONTHLY_LIMIT,
      users: slice,
    });
  } catch (e) {
    console.error("ADMIN users error:", e);
    return res.status(500).json({ error: e?.message || "admin_users_error" });
  }
}
