// /api/credits/add.js
// Credita mensagens extras reduzindo o "used" do mês.
// Protegido por ADMIN_SECRET. Pode creditá-las para qualquer usuário (hash),
// ou para o usuário atual (via cookie lti_user).

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const QUOTA_PREFIX  = process.env.QUOTA_PREFIX || "quota";
const ADMIN_SECRET  = process.env.ADMIN_SECRET || "";

function monthKey(userId) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${QUOTA_PREFIX}:${y}-${m}:${userId}`;
}

function parseCookies(h = "") {
  return Object.fromEntries((h || "").split(";").map(s => s.trim().split("=")));
}

async function readJson(req) {
  const raw = await new Promise(r => {
    let d = ""; req.on("data", c => d += c); req.on("end", () => r(d));
  });
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

    if (!ADMIN_SECRET) return res.status(500).json({ error: "admin_secret_missing" });

    // Autorização: header Authorization: Bearer <ADMIN_SECRET>
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (auth !== ADMIN_SECRET) return res.status(403).json({ error: "forbidden" });

    const body = await readJson(req);
    let { user, amount } = body || {};

    // Se não veio um user explícito, tenta cookie lti_user (abrindo como o aluno)
    if (!user) {
      const cookies = parseCookies(req.headers.cookie || "");
      user = cookies["lti_user"];
    }

    amount = Number(amount);
    if (!user)   return res.status(400).json({ error: "missing_user" });
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "bad_amount", detail: "amount deve ser número > 0" });
    }

    const key = monthKey(user);
    const current = Number((await redis.get(key)) || 0);
    const newUsed = Math.max(0, current - amount); // reduz "used"
    await redis.set(key, newUsed);

    return res.status(200).json({ ok: true, user, key, was: current, now: newUsed, credited: amount });
  } catch (e) {
    console.error("CREDITS add error:", e);
    return res.status(500).json({ error: e?.message || "internal_error" });
  }
}
