// /api/speaking.js
// Recebe áudio do Speaking Lab, controla uso em segundos
// e devolve: transcrição, frase correta, feedback e TTS em base64.

import { Redis } from "@upstash/redis";
import { jwtVerify } from "jose";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const SPEAKING_PREFIX = process.env.SPEAKING_PREFIX || "speaking";

// prioridade: segundos -> minutos -> 20 min
const SPEAKING_LIMIT_SECONDS =
  Number(process.env.SPEAKING_MONTHLY_LIMIT_SECONDS) ||
  (Number(process.env.SPEAKING_MONTHLY_LIMIT_MINUTES || 20) * 60);

function parseCookies(h = "") {
  return Object.fromEntries((h || "").split(";").map(s => s.trim().split("=")));
}

function monthKey(userId) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${SPEAKING_PREFIX}:${y}-${m}:${userId}`;
}

async function getUserIdFromToken(t) {
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const { payload } = await jwtVerify(t, secret);
    return payload?.sub || null;
  } catch {
    return null;
  }
}

async function readJson(req) {
  const raw = await new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

// --------- OpenAI helpers ---------

async function transcribeAudio(base64Audio) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY não configurada para speaking.");
  }

  const audioBuffer = Buffer.from(base64Audio, "base64");

  // usa FormData/Blob do ambiente Node 18+ (Vercel)
  const form = new FormData();
  form.append(
    "file",
    new Blob([audioBuffer], { type: "audio/webm" }),
    "audio.webm"
  );
  form.append("model", "whisper-1");
  form.append("language", "en");
  form.append("response_format", "json");

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Erro na transcrição (${resp.status}): ${txt}`);
  }

  const data = await resp.json();
  return (data.text || "").trim();
}

async function buildFeedback(transcript) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  // Parte fixa
  const baseSystem =
    "Você é um professor de inglês que ajuda alunos brasileiros a melhorar a pronúncia.\n" +
    "Você receberá a transcrição aproximada da fala do aluno (vinda de um modelo de reconhecimento de fala).\n\n" +
    "Sua tarefa é:\n" +
    "1) Deduzir qual deveria ser a frase correta em inglês.\n" +
    "2) Dar um feedback curto em português sobre pronúncia.\n\n";

  // Parte flexível, vinda da Vercel (você já preencheu na SPEAKING_FEEDBACK_PROMPT_PT)
  const extra = process.env.SPEAKING_FEEDBACK_PROMPT_PT || "";

  const systemPrompt = baseSystem + extra;

  const userPrompt =
    `Transcrição aproximada da fala do aluno:\n"${transcript}".\n\n` +
    "1) Deduz a frase correta em inglês.\n" +
    "2) Depois, no feedback em português, foque em 1 a 3 pontos de pronúncia importantes para esse caso.";

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Erro no chat de feedback (${resp.status}): ${txt}`);
  }

  const json = await resp.json();
  const content = json?.choices?.[0]?.message?.content || "";

  // TENTAR interpretar como JSON, mas com fallback seguro
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = null;
  }

  let correct_sentence = transcript || "";
  let feedback_text = "";

  if (parsed && typeof parsed === "object") {
    if (typeof parsed.correct_sentence === "string") {
      correct_sentence = parsed.correct_sentence;
    }
    if (typeof parsed.feedback_pt === "string") {
      feedback_text = parsed.feedback_pt;
    }
  } else {
    // se o modelo não mandou JSON, usamos o texto bruto como feedback
    feedback_text = content;
  }

  return { correct_sentence, feedback_text };
}

async function synthesizeSpeech(text) {
  if (!text) return null;

  const model = process.env.SPEAKING_TTS_MODEL || "tts-1";
  const voice = process.env.SPEAKING_TTS_VOICE || "alloy";

  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      voice,
      input: text,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Erro no TTS (${resp.status}): ${txt}`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  return buf.toString("base64");
}

// --------- handler principal ---------

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = await readJson(req);
    const { audio, durationMs, t } = body || {};

    if (!audio || typeof audio !== "string") {
      return res.status(400).json({ error: "audio base64 é obrigatório" });
    }

    // identidade: cookie LTI -> token t
    const cookies = parseCookies(req.headers.cookie || "");
    let userId = cookies["lti_user"] || null;

    if (!userId && t) {
      userId = await getUserIdFromToken(t);
    }

    if (!userId) {
      return res.status(401).json({
        error: "no_user",
        message: "Abra pelo Canvas (LTI) para usar o Speaking Lab.",
      });
    }

    // segundos desta chamada (justo, baseado no tempo real)
    let secondsThisCall = 0;

    if (typeof durationMs === "number" && durationMs > 0) {
      secondsThisCall = Math.round(durationMs / 1000);
    } else {
      // fallback bem conservador, caso durationMs não venha
      const approxSeconds = Math.round((audio.length * 3) / (4 * 32000));
      secondsThisCall = approxSeconds > 0 ? approxSeconds : 1;
    }
    if (secondsThisCall < 1) secondsThisCall = 1;

    const key = monthKey(userId);
    const current = Number((await redis.get(key)) || 0);
    const newTotal = current + secondsThisCall;

    if (newTotal > SPEAKING_LIMIT_SECONDS) {
      const usedMinutes = current / 60;
      const limitMinutes = SPEAKING_LIMIT_SECONDS / 60;
      return res.status(429).json({
        error: "limit_reached",
        message: "Limite mensal de prática de áudio atingido.",
        usedSeconds: current,
        limitSeconds: SPEAKING_LIMIT_SECONDS,
        usedMinutes,
        limitMinutes,
      });
    }

    // atualiza uso e configura expiração (1º dia do próximo mês)
    await redis.set(key, newTotal);
    if (!current) {
      const now = new Date();
      const expireAt = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() + 1,
        1
      ) / 1000;
      await redis.expireat(key, expireAt);
    }

    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY não configurada.");
    }

    const transcript = await transcribeAudio(audio);
    const { correct_sentence, feedback_text } = await buildFeedback(transcript || "");
    const audioBase64 = await synthesizeSpeech(correct_sentence);

    return res.status(200).json({
      transcript,
      correct_sentence,
      feedback_text,
      audioBase64,
      usedSeconds: newTotal,
      limitSeconds: SPEAKING_LIMIT_SECONDS,
    });
  } catch (e) {
    console.error("SPEAKING error:", e);
    return res.status(500).json({
      error: "speaking_error",
      message: e?.message || "Erro interno no Speaking Lab.",
    });
  }
}

export const config = { api: { bodyParser: false } };
