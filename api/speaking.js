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

// prioridade: segundos -> minutos -> 20 min (padrão)
const SPEAKING_LIMIT_SECONDS =
  Number(process.env.SPEAKING_MONTHLY_LIMIT_SECONDS) ||
  (Number(process.env.SPEAKING_MONTHLY_LIMIT_MINUTES || 20) * 60);

// NOVO: URLs de checkout para minutos extras
const CHECKOUT_URL_SPEAK_5  = process.env.CHECKOUT_URL_SPEAK_5 || null;
const CHECKOUT_URL_SPEAK_10 = process.env.CHECKOUT_URL_SPEAK_10 || null;

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

// --------- OpenAI: transcrição (Whisper) ---------

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

// --------- OpenAI: feedback de pronúncia ---------

async function buildFeedback(transcript) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  // Prompt base (fixo no código)
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
    "7. Se você não entender o áudio (ruído, baixa qualidade, frase muito confusa), peça educadamente para o aluno repetir, em vez de dar uma resposta vazia.\n\n" +
    "Ao avaliar a PRONÚNCIA, você pode considerar (entre outros) pontos como:\n" +
    "- Sons de TH (/θ/ em \"think\", /ð/ em \"this\").\n" +
    "- Vogais longas vs. curtas (ship x sheep, live x leave).\n" +
    "- Vogal /æ/ (cat, bad, man).\n" +
    "- Consoantes finais (t, d, k, p, s, z).\n" +
    "- Plural e 3ª pessoa do singular na pronúncia (he works, two cats).\n" +
    "- Terminações -ED (/t/, /d/, /ɪd/).\n" +
    "- Posição da sílaba tônica.\n" +
    "- Ritmo e connected speech.\n\n" +
    "Sempre que possível, no feedback:\n" +
    "- Liste de 1 a 3 palavras em que a pronúncia possa melhorar.\n" +
    "- Mostre a forma correta + IPA americano.\n" +
    "- Explique em português, de forma direta e encorajadora.\n\n" +
    "FORMATO DA RESPOSTA (IMPORTANTE!):\n" +
    "Responda APENAS em JSON, sem nenhum texto antes ou depois.\n" +
    "Use exatamente este formato:\n" +
    "{\n" +
    "  \"correct_sentence\": \"frase corrigida e natural em inglês\",\n" +
    "  \"feedback_pt\": \"texto em português com as dicas de pronúncia (máx. 3 pontos principais)\"\n" +
    "}\n" +
    "Não inclua comentários adicionais, nem texto fora desse JSON.\n\n";

  // Complemento vindo da Vercel (você ajusta sem tocar no código)
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
    // fallback: se o modelo não respeitar o JSON, devolve o texto bruto como feedback
    feedback_text = content;
  }

  return { correct_sentence, feedback_text };
}

// --------- OpenAI: TTS (voz com "Check this" + dica rápida) ---------

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

// Pega APENAS a dica principal a partir do feedback em texto
function extractMainTip(feedback) {
  if (!feedback) return "";

  // separa em linhas e limpa
  const lines = feedback
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l);

  if (!lines.length) return "";

  let first = lines[0];

  // se a primeira linha for algo tipo "Feedback:" e houver outra, usa a segunda
  if (/^feedback\b/i.test(first) && lines[1]) {
    first = lines[1];
  }

  // remove bullets simples: "-", "•"
  first = first.replace(/^[\-\u2022]\s*/, "");

  // remove numeração tipo "1.", "1)", "1 -" no começo
  first = first.replace(/^[0-9]+\s*[\.\)\-]\s*/, "");

  return first;
}

// Monta o texto que a IA vai falar no áudio:
// "Check this: <frase correta>. Dica rápida: <uma dica curtinha em PT>"
function buildSpokenText(correct_sentence, feedback_text) {
  const sent = (correct_sentence || "").trim();
  const tip = extractMainTip(feedback_text || "");

  // se não conseguir extrair nada decente, usa uma dica genérica
  const ptPart = tip
    ? `Dica rápida: ${tip}`
    : "Dica rápida: preste atenção na pronúncia e no ritmo dessa frase.";

  if (!sent) {
    return `Check this. ${ptPart}`;
  }

  return `Check this: ${sent}. ${ptPart}`;
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
      // fallback conservador caso durationMs não venha
      const approxSeconds = Math.round((audio.length * 3) / (4 * 32000));
      secondsThisCall = approxSeconds > 0 ? approxSeconds : 1;
    }
    if (secondsThisCall < 1) secondsThisCall = 1;

    const key = monthKey(userId);
    const current = Number((await redis.get(key)) || 0);
    const newTotal = current + secondsThisCall;

    // 🔴 AQUI: limite mensal + pacotes de upgrade
    if (newTotal > SPEAKING_LIMIT_SECONDS) {
      const usedMinutes = current / 60;
      const limitMinutes = SPEAKING_LIMIT_SECONDS / 60;

      // monta lista de pacotes só se as URLs estiverem configuradas
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
        packages, // NOVO: o front vai usar isso para mostrar os botões
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

    // texto final que vira áudio: "Check this: ... Dica rápida: ..."
    const spokenText = buildSpokenText(correct_sentence, feedback_text);
    const audioBase64 = await synthesizeSpeech(spokenText);

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
