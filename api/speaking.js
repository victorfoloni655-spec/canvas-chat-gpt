// /api/speaking.js
// Recebe áudio do Speaking Lab, controla uso em segundos
// e devolve: transcrição, frase correta, feedback e TTS em base64.
// ALSO: salva histórico no mesmo Redis do chat (kind: "speaking") SEM guardar áudio.

import { Redis } from "@upstash/redis";
import { jwtVerify } from "jose";
import { randomUUID } from "crypto"; // ✅ NOVO: para gerar id único por tentativa

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Prefixo de uso mensal (segundos de áudio)
const SPEAKING_PREFIX = process.env.SPEAKING_PREFIX || "speaking";

// prioridade: segundos -> minutos -> 20 min (padrão)
const SPEAKING_LIMIT_SECONDS =
  Number(process.env.SPEAKING_MONTHLY_LIMIT_SECONDS) ||
  (Number(process.env.SPEAKING_MONTHLY_LIMIT_MINUTES || 20) * 60);

// URLs de checkout para minutos extras
const CHECKOUT_URL_SPEAK_5  = process.env.CHECKOUT_URL_SPEAK_5  || null;
const CHECKOUT_URL_SPEAK_10 = process.env.CHECKOUT_URL_SPEAK_10 || null;

// Histórico (mesmo prefixo do chat)
const HISTORY_PREFIX = process.env.HISTORY_PREFIX || "history";
const HISTORY_MAX    = Number(process.env.HISTORY_MAX || 80);

function parseCookies(h = "") {
  return Object.fromEntries((h || "").split(";").map(s => s.trim().split("=")));
}

function monthKey(userId) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${SPEAKING_PREFIX}:${y}-${m}:${userId}`;
}

function historyKey(userId) {
  return `${HISTORY_PREFIX}:${userId}`;
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

// --------- RESOLVE IDENTIDADE (mesma lógica de chat/history) ---------

async function resolveUserId(req, body) {
  const url   = new URL(req.url, `https://${req.headers.host}`);
  const tQ    = url.searchParams.get("t");
  const tBody = body?.t;

  // 1) token t (body ou query) -> decodifica JWT (sub)
  const token = tBody || tQ;
  if (token) {
    const fromT = await getUserIdFromToken(token);
    if (fromT) return fromT;
  }

  // 2) cookie LTI
  const cookies = parseCookies(req.headers.cookie || "");
  if (cookies["lti_user"]) return cookies["lti_user"];

  return null;
}

// --------- OpenAI: transcrição (Whisper) ---------

async function transcribeAudio(base64Audio) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY não configurada para speaking.");
  }

  const audioBuffer = Buffer.from(base64Audio, "base64");

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

// --------- OpenAI: feedback de pronúncia ---------

async function buildFeedback(transcript) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const baseSystem =
    "Você é um professor de inglês especializado em alunos brasileiros (falantes de português do Brasil).\n" +
    "Você recebe a TRANSCRIÇÃO aproximada de um áudio em inglês e deve ajudar o aluno a melhorar.\n\n" +
    "Sua tarefa é:\n" +
    "1. Confirmar o que você entendeu (em inglês, frase corrigida).\n" +
    "2. Corrigir a frase, deixando-a natural em inglês.\n" +
    "3. Focar em erros típicos de brasileiros na pronúncia.\n" +
    "4. Explicar em português, de forma simples.\n" +
    "5. Corrigir no máximo 3 pontos principais por vez para não sobrecarregar o aluno.\n" +
    "6. Responder o aluno de forma sincera para poder melhorar o nível atual, mas sem desmotivar.\n" +
    "7. Se você não entender o áudio (ruído, baixa qualidade, frase muito confusa), peça educadamente para o aluno repetir.\n\n" +
    "Ao avaliar a PRONÚNCIA, você pode considerar (entre outros) pontos como:\n" +
    "- Sons de TH (/θ/ em \"think\", /ð/ em \"this\").\n" +
    "- Vogais longas vs. curtas (ship x sheep, live x leave).\n" +
    "- Vogal /æ/ (cat, bad, man).\n" +
    "- Consoantes finais (t, d, k, p, s, z).\n" +
    "- Plural e 3ª pessoa do singular (he works, two cats).\n" +
    "- Terminações -ED (/t/, /d/, /ɪd/).\n" +
    "- Posição da sílaba tônica.\n" +
    "- Ritmo e connected speech.\n\n" +
    "Sempre que possível, no feedback:\n" +
    "- Liste de 1 a 3 palavras em que a pronúncia possa melhorar.\n" +
    "- Mostre a forma correta + IPA americano.\n" +
    "- Explique em português, de forma direta e encorajadora.\n\n" +
    "FORMATO DA RESPOSTA:\n" +
    "Responda APENAS em JSON, sem nenhum texto antes ou depois.\n" +
    "{\n" +
    "  \"correct_sentence\": \"frase corrigida e natural em inglês\",\n" +
    "  \"feedback_pt\": \"texto em português com as dicas de pronúncia (máx. 3 pontos principais)\"\n" +
    "}\n";

  const extra = process.env.SPEAKING_FEEDBACK_PROMPT_PT || "";
  const systemPrompt = baseSystem + (extra ? ("\n" + extra) : "");

  const userPrompt =
    `Transcrição aproximada da fala do aluno:\n"${transcript}".\n\n` +
    "1) Deduz a frase correta em inglês.\n" +
    "2) Preencha o campo correct_sentence com essa frase.\n" +
    "3) No campo feedback_pt, dê as dicas de pronúncia seguindo as instruções.";

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
    feedback_text = content;
  }

  return { correct_sentence, feedback_text };
}

// --------- OpenAI: TTS ---------

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

function extractMainTip(feedback) {
  if (!feedback) return "";

  const lines = feedback
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l);

  if (!lines.length) return "";

  let first = lines[0];

  if (/^feedback\b/i.test(first) && lines[1]) {
    first = lines[1];
  }

  first = first.replace(/^[\-\u2022]\s*/, "");
  first = first.replace(/^[0-9]+\s*[\.\)\-]\s*/, "");

  return first;
}

function buildSpokenText(correct_sentence, feedback_text) {
  const sent = (correct_sentence || "").trim();
  const tip  = extractMainTip(feedback_text || "");

  const ptPart = tip
    ? `Dica rápida: ${tip}`
    : "Dica rápida: preste atenção na pronúncia e no ritmo dessa frase.";

  if (!sent) {
    return `Check this. ${ptPart}`;
  }

  return `Check this: ${sent}. ${ptPart}`;
}

// --------- HISTÓRICO SPEAKING (sem áudio) ---------

async function appendSpeakingHistory(userId, {
  speakingId,
  userAudioBase64,
  transcript,
  correct_sentence,
  feedback_text,
  ttsAudioBase64,
}) {
  try {
    const key = historyKey(userId);
    const now = Date.now();

    // Não guardar audioBase64 no Redis, só texto + flags + id
    const entryUser = JSON.stringify({
      id: speakingId,
      kind: "speaking",
      role: "user",
      transcript: transcript || null,
      hasAudio: !!userAudioBase64,
      ts: now,
    });

    const entryBot = JSON.stringify({
      id: speakingId,
      kind: "speaking",
      role: "assistant",
      transcript: transcript || null,
      correct_sentence: correct_sentence || null,
      feedback_text: feedback_text || null,
      hasAudio: !!ttsAudioBase64,
      ts: now,
    });

    await redis.rpush(key, entryUser, entryBot);
    await redis.ltrim(key, -HISTORY_MAX, -1);
  } catch (e) {
    console.error("Erro ao salvar histórico speaking:", e);
  }
}

// --------- handler principal ---------

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = await readJson(req);
    const { audio, durationMs } = body || {};

    if (!audio || typeof audio !== "string") {
      return res.status(400).json({ error: "audio base64 é obrigatório" });
    }

    const userId = await resolveUserId(req, body);
    if (!userId) {
      return res.status(401).json({
        error: "no_user",
        message: "Abra pelo Canvas (LTI) ou com token 't' para usar o Speaking Lab.",
      });
    }

    // segundos desta chamada
    let secondsThisCall = 0;
    if (typeof durationMs === "number" && durationMs > 0) {
      secondsThisCall = Math.round(durationMs / 1000);
    } else {
      const approxSeconds = Math.round((audio.length * 3) / (4 * 32000));
      secondsThisCall = approxSeconds > 0 ? approxSeconds : 1;
    }
    if (secondsThisCall < 1) secondsThisCall = 1;

    const key = monthKey(userId);
    const current = Number((await redis.get(key)) || 0);
    const newTotal = current + secondsThisCall;

    if (newTotal > SPEAKING_LIMIT_SECONDS) {
      const usedMinutes  = current / 60;
      const limitMinutes = SPEAKING_LIMIT_SECONDS / 60;

      const packages = [];
      if (CHECKOUT_URL_SPEAK_5) {
        packages.push({
          label: "+ 5 minutos de speaking",
          url: CHECKOUT_URL_SPEAK_5,
        });
      }
      if (CHECKOUT_URL_SPEAK_10) {
        packages.push({
          label: "+ 10 minutos de speaking",
          url: CHECKOUT_URL_SPEAK_10,
        });
      }

      return res.status(429).json({
        error: "limit_reached",
        message: "Limite mensal de prática de áudio atingido.",
        usedSeconds: current,
        limitSeconds: SPEAKING_LIMIT_SECONDS,
        usedMinutes,
        limitMinutes,
        packages,
      });
    }

    // atualiza uso + expiração
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

    // ✅ gera id único pra essa tentativa de speaking
    const speakingId = randomUUID();

    const transcriptObj = await transcribeAudio(audio);
    const transcript    = transcriptObj || "";
    const { correct_sentence, feedback_text } = await buildFeedback(transcript);

    const spokenText = buildSpokenText(correct_sentence, feedback_text);
    const audioBase64 = await synthesizeSpeech(spokenText);

    // salva histórico (sem áudio)
    await appendSpeakingHistory(userId, {
      speakingId,
      userAudioBase64: audio,
      transcript,
      correct_sentence,
      feedback_text,
      ttsAudioBase64: audioBase64,
    });

    // debug: quantos registros totais (chat + speaking) esse user tem?
    let historyCount = 0;
    try {
      const debugRaw = await redis.lrange(historyKey(userId), 0, -1);
      historyCount = debugRaw.length;
    } catch (e) {
      console.error("Erro ao ler histórico speaking para debug:", e);
    }

    return res.status(200).json({
      id: speakingId,                  // ✅ importante para o localStorage
      transcript,
      correct_sentence,
      feedback_text,
      audioBase64,                     // TTS só volta aqui (não vai pro Redis)
      usedSeconds: newTotal,
      limitSeconds: SPEAKING_LIMIT_SECONDS,
      userId,
      historyCount,
      historyKey: historyKey(userId),
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
