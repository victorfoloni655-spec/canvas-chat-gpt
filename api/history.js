// /api/history.js
// Lista/limpa o histórico mensal do aluno atual (identificado por cookie lti_user)
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});
const HISTORY_PREFIX = process.env.HISTORY_PREFIX || "history";

function parseCookies(h = "") {
  return Object.fromEntries((h || "").split(";").map(s => s.trim().split("=")));
}
function monthHistoryKey(userId) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${HISTORY_PREFIX}:${y}-${m}:${userId}`;
}

export default async function handler(req, res) {
  try {
    const cookies = parseCookies(req.headers.cookie || "");
    const user = cookies["lti_user"];
    if (!user) return res.status(401).json({ error: "no_lti_cookie", detail: "Abra pelo Canvas." });

    const key = monthHistoryKey(user);

    if (req.method === "GET") {
      const arr = await redis.lrange(key, 0, 99); // últimos 100
      const items = arr.map(s => {
        try { return JSON.parse(s); } catch { return null; }
      }).filter(Boolean);
      return res.status(200).json({ items });
    }

    if (req.method === "DELETE") {
      await redis.del(key);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (e) {
    console.error("HISTORY error:", e);
    return res.status(500).json({ error: e?.message || "history_error" });
  }
}
