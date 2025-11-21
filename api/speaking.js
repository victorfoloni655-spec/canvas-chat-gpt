// /api/speaking.js
// Recebe áudio (base64), identifica o aluno via LTI, controla minutos/mês em Redis,
// transcreve com gpt-4o-mini-transcribe, gera feedback de pronúncia com gpt-4o-mini
// e ainda gera um áudio (TTS) com a frase corrigida + dica.

import { Redis } from "@upstash/redis";
import { jwtVerify } from "jose";

const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const OPENAI_TEXT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const TRANSCRIBE_MODEL  = "gpt-4o-mini-transcribe";
const TTS_MODEL         = process.env.TTS_MODEL || "gpt-4o-mini-tts";

// ------- LIMITE DE ÁUDIO (MINUTOS / MÊS) -------
const SPEAKING_PREFIX        = process.env.SPEAKING_PREFIX || "speaking";
const SPEAKING_MINUTES_LIMIT = Number(process.env.SPEAKING_MINUTES_LIMIT || 20);
const SPEAKING_SECONDS_LIMIT = SPEAKING_MINUTES_LIMIT * 60; // 20 min -> 1200s

// Cada gravação, por enquanto, conta como 30 segundos.
const ESTIMATED_SECONDS_PER_RECORDING = 30;

// Redis (mesma config dos outros endpoints)
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

if (!OPENAI_API_KEY) {
  console.warn("⚠️ OPENAI_API_KEY não configurada — /api/speaking não vai funcionar.");
}

// ---------- helpers básicos ----------

function parseCookies(h = "") {
  return Object.fromEntries((h || "").split(";").map(s => s.trim().split("=")));
}

// lê JSON cru (igual /api/chat)
async function readJson(req) {
  const raw = await new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

async function getUserIdFromToken(t) {
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const { payload } = await jwtVerify(t, secret);
    return payload?.sub || null; // sub = hash de usuário que você gera no launch
  } catch {
    return null;
  }
}

// chave por mês (UTC) para o contador de segundos de áudio
function monthKey(userId) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${SPEAKING_PREFIX}:${y}-${m}:${userId}`;
}

// soma "seconds" ao contador do mês e verifica se passou do limite
async function addSecondsAndCheck(userId, secondsToAdd) {
  const key = monthKey(userId);
  const add = Math.max(1, Math.round(secondsToAdd || 0)); // garante >= 1s

  const usedSeconds = await redis.incrby(key, add);

  // primeira vez no mês: define expiração pro 1º dia do próximo mês (UTC)
  if (usedSeconds === add) {
    const now = new Date();
    const expireAt = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() + 1,
      1
    ) / 1000;
    await redis.expireat(key, expireAt);
  }

  const blocked = usedSeconds > SPEAKING_SECONDS_LIMIT;
  return { key, usedSeconds, blocked };
}

// ---------- OpenAI: transcrição ----------

async function transcribeAudioFromBase64(base64) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada");

  const buffer = Buffer.from(base64, "base64");

  const blob = new Blob([buffer], { type: "audio/webm" });
  const formData = new FormData();
  formData.append("file", blob, "audio.webm");
  formData.append("model", TRANSCRIBE_MODEL);

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: formData,
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Erro na transcrição (${resp.status}): ${txt}`);
  }

  const data = await resp.json();
  return data.text || "";
}

// ---------- OpenAI: feedback de pronúncia (texto) ----------

async function buildFeedbackFromTranscript(transcript) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada");

  const messages = [
    {
      role: "system",
      content: `
Você é um professor de inglês especializado em PRONÚNCIA.
O aluno falou uma frase em inglês, e temos uma transcrição aproximada do áudio (pode conter erros).

Responda SEMPRE em JSON puro, no formato:
{
  "correct_sentence": "frase corrigida em inglês",
  "feedback_text": "explicação curta em português sobre os principais pontos de pronúncia"
}

Não adicione texto fora do JSON.
      `.trim()
    },
    {
      role: "user",
      content: `
Transcrição aproximada do que o aluno falou:
"""${transcript}"""

1) Escreva a frase correta em inglês, no campo "correct_sentence".
2) No campo "feedback_text", explique em português, de forma simples, os principais pontos de pronúncia para melhorar.
      `.trim()
    }
  ];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_TEXT_MODEL,
      messages,
      temperature: 0.4,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Erro no GPT texto (${resp.status}): ${txt}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content?.trim() || "";

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      correct_sentence: null,
      feedback_text: content || "Não foi possível interpretar a resposta da IA.",
    };
  }

  return {
    correct_sentence: parsed.correct_sentence || null,
    feedback_text: parsed.feedback_text || "",
  };
}

// ---------- OpenAI: gerar áudio (TTS) ----------

async function generateSpeechAudio(text) {
  if (!text) return null;
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada");

  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: "alloy",
      input: text,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Erro no TTS (${resp.status}): ${txt}`);
  }

  const arrayBuffer = await resp.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);
  return buf.toString("base64"); // áudio em base64 (mp3)
}

// ---------- handler principal ----------

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = await readJson(req);
    const { audio, t } = body || {};

    if (!audio || typeof audio !== "string") {
      return res.status(400).json({ error: "Campo 'audio' (base64) é obrigatório" });
    }

    // Identidade do aluno: cookie LTI -> token 't'
    const cookies = parseCookies(req.headers.cookie || "");
    let userId = cookies["lti_user"];

    if (!userId && t) {
      userId = await getUserIdFromToken(t);
    }

    if (!userId) {
      return res.status(401).json({
        error: "no_user",
        detail: "Abra pelo Canvas (LTI) para usar o lab de fala.",
      });
    }

    // --------- CONTROLE DE USO MENSAL (minutos) ---------
    const { usedSeconds, blocked } = await addSecondsAndCheck(
      userId,
      ESTIMATED_SECONDS_PER_RECORDING
    );

    if (blocked) {
      const usedMin  = usedSeconds / 60;
      const limitMin = SPEAKING_SECONDS_LIMIT / 60;

      return res.status(429).json({
        error: "limit_reached",
        message: `Você atingiu o limite de ${limitMin} minutos de prática de áudio neste mês.`,
        usedSeconds,
        usedMinutes: Number(usedMin.toFixed(1)),
        limitSeconds: SPEAKING_SECONDS_LIMIT,
        limitMinutes: limitMin,
      });
    }

    // 1) Transcreve o áudio
    const transcript = await transcribeAudioFromBase64(audio);

    // 2) Gera correção + feedback (texto)
    const feedback = await buildFeedbackFromTranscript(transcript || "");

    // 3) Monta texto para TTS (inglês)
    const parts = [];
    if (feedback.correct_sentence) {
      parts.push(`The correct sentence is: ${feedback.correct_sentence}`);
    }
    if (feedback.feedback_text) {
      parts.push(feedback.feedback_text);
    }
    const speechText = parts.join(". ");

    let audioBase64 = null;
    try {
      audioBase64 = await generateSpeechAudio(speechText);
    } catch (err) {
      console.error("Erro ao gerar TTS:", err);
      audioBase64 = null;
    }

    return res.status(200).json({
      user: userId,
      transcript,
      correct_sentence: feedback.correct_sentence,
      feedback_text: feedback.feedback_text,
      usedSeconds,
      limitSeconds: SPEAKING_SECONDS_LIMIT,
      audioBase64, // áudio da IA em base64 (mp3)
    });
  } catch (e) {
    console.error("SPEAKING error:", e);
    return res.status(500).json({ error: e?.message || "speaking internal error" });
  }
}

export const config = { api: { bodyParser: false } };
