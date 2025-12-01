// /api/history.js
// Retorna o histórico unificado do aluno (chat + speaking).

import { Redis } from "@upstash/redis";
import { jwtVerify } from "jose";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// AGORA usa "history2" por padrão
const HISTORY_PREFIX = process.env.HISTORY_PREFIX || "history2";

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

function historyKey(userId) {
  return `${HISTORY_PREFIX}:${userId}`;
}

function normalizeItem(src) {
  if (!src || typeof src !== "object") return null;

  const out = { ...src };

  if (!out.kind) out.kind = "chat";
  if (!out.role) out.role = "assistant";

  if (typeof out.content !== "string") {
    if (out.content == null) {
      out.content = "";
    } else {
      try {
        out.content = JSON.stringify(out.content);
      } catch {
        out.content = String(out.content);
      }
    }
  }

  if (typeof out.ts !== "number") {
    if (typeof out.timestamp === "number") {
      out.ts = out.timestamp;
    } else {
      out.ts = 0;
    }
  }

  return out;
}

function parseHistoryValue(raw) {
  if (raw == null) return null;

  let s = typeof raw === "string" ? raw : String(raw);
  let trimmed = s.trim();

  if (/^\[object\b/i.test(trimmed)) {
    return null;
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      const inner = JSON.parse(trimmed);
      if (typeof inner === "string") {
        const innerTrim = inner.trim();
        if (/^\[object\b/i.test(innerTrim)) return null;
        return normalizeItem({
          kind: "chat",
          role: "assistant",
          content: innerTrim,
          ts: 0,
        });
      }
      return normalizeItem(inner);
    } catch {
      // segue
    }
  }

  try {
    const parsed = JSON.parse(trimmed);

    if (typeof parsed === "string") {
      const innerTrim = parsed.trim();
      if (/^\[object\b/i.test(innerTrim)) return null;
      return normalizeItem({
        kind: "chat",
        role: "assistant",
        content: innerTrim,
        ts: 0,
      });
    }

    return normalizeItem(parsed);
  } catch {
    if (/^\[object\b/i.test(trimmed)) return null;
    return normalizeItem({
      kind: "chat",
      role: "assistant",
      content: trimmed,
      ts: 0,
    });
  }
}

async function resolveUserId(req) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const uidParam = url.searchParams.get("uid");
  const tQuery   = url.searchParams.get("t");

  if (uidParam) return uidParam;

  if (tQuery) {
    const fromT = await getUserFromToken(tQuery);
    if (fromT) return fromT;
  }

  const cookies = parseCookies(req.headers.cookie || "");
  if (cookies["lti_user"]) return cookies["lti_user"];

  return null;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const kindFilter = url.searchParams.get("kind");
    const limitParam = url.searchParams.get("limit");

    let limit = Number(limitParam) || 400;
    if (limit < 10) limit = 10;
    if (limit > 1000) limit = 1000;

    const user = await resolveUserId(req);

    if (!user) {
      return res.status(401).json({
        error: "no_identity",
        detail: "Não foi possível identificar o usuário para recuperar o histórico.",
      });
    }

    const key = historyKey(user);

    const rawAll = await redis.lrange(key, 0, -1);
    const historyCount = rawAll?.length || 0;

    const raw =
      historyCount > limit ? rawAll.slice(historyCount - limit) : rawAll;

    let items =
      (raw || [])
        .map((str) => parseHistoryValue(str))
        .filter(Boolean) || [];

    if (kindFilter === "chat" || kindFilter === "speaking") {
      items = items.filter((it) => it.kind === kindFilter);
    }

    items.sort((a, b) => {
      const ta = typeof a.ts === "number" ? a.ts : 0;
      const tb = typeof b.ts === "number" ? b.ts : 0;
      return ta - tb;
    });

    return res.status(200).json({
      items,
      userId: user,
      historyCount,
    });
  } catch (e) {
    console.error("HISTORY error:", e);
    return res
      .status(500)
      .json({ error: e?.message || "history error" });
  }
}

export const config = { api: { bodyParser: false } };
