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

  const systemPrompt =
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
    "Ao avaliar a PRONÚNCIA, preste atenção ESPECIAL nestes erros comuns de falantes brasileiros:\n\n" +
    "1. Sons de TH:\n" +
    "   - /θ/ como em \"think\", \"thirty\".\n" +
    "   - /ð/ como em \"this\", \"mother\".\n" +
    "   Erro comum: virar /t/, /d/, /f/, /s/ (ex: \"tink\" em vez de \"think\").\n\n" +
    "2. Vogais longas vs curtas:\n" +
    "   - ship /ʃɪp/ x sheep /ʃiːp/.\n" +
    "   - live /lɪv/ x leave /liːv/.\n" +
    "   Brasileiros costumam não alongar as vogais.\n\n" +
    "3. Vogal /æ/:\n" +
    "   - \"cat\", \"bad\", \"man\".\n" +
    "   Erro comum: pronunciar como /ɛ/ (\"bed\") ou /e/ (ex: \"cét\").\n\n" +
    "4. Consoantes finais:\n" +
    "   - Sons finais em palavras como \"cat\", \"big\", \"worked\".\n" +
    "   Erro comum: engolir /t/, /d/, /k/, /p/, /s/, /z/.\n\n" +
    "5. Plural e 3ª pessoa do singular:\n" +
    "   - Não pronunciar o -s ou -es no final:\n" +
    "     \"He work\" em vez de \"He works\" /wɜːrks/.\n" +
    "     \"Two cat\" em vez de \"two cats\" /kæts/.\n\n" +
    "6. Terminações -ED:\n" +
    "   - Três possibilidades: /t/, /d/, /ɪd/.\n" +
    "   Ex: \"worked\" /wɜːrkt/, \"played\" /pleɪd/, \"wanted\" /ˈwɒntɪd/.\n\n" +
    "7. Posição da sílaba tônica (stress):\n" +
    "   - PREsent (substantivo) x preSENT (verbo).\n" +
    "   - ADvertise x adVERtisement.\n\n" +
    "8. Ritmo e ligação entre palavras (connected speech):\n" +
    "   - \"a lot of\" ≈ /ə ˈlɑːɾəv/.\n" +
    "   - \"want to\" ≈ \"wanna\".\n" +
    "   Você pode comentar quando o aluno estiver falando muito sílaba por sílaba.\n\n" +
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
    "Não inclua comentários adicionais, nem texto fora desse JSON.";

  const userPrompt =
    `Transcrição aproximada da fala do aluno:\n"${transcript}".\n\n` +
    "1) Deduz a frase correta em inglês.\n" +
    "2) Depois, no campo feedback_pt, dê as dicas de pronúncia seguindo as instruções.";

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

// --------- OpenAI: TTS (voz da frase + dica) ---------

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

// Monta o texto que a IA vai falar no áudio:
// "Check this: <frase correta>. <dica curta em português>"
function buildSpokenText(correct_sentence, feedback_text) {
  const sent = (correct_sentence || "").trim();
  let tip = (feedback_text || "").trim();

  // tenta pegar só a primeira frase da dica, pra ficar curto
  if (tip) {
    const dotIndex = tip.indexOf(".");
    if (dotIndex > 0 && dotIndex < 220) {
      tip = tip.slice(0, dotIndex + 1);
    } else if (tip.length > 220) {
      tip = tip.slice(0, 220) + "...";
    }
  }

  if (!tip) {
    tip = "Dica rápida: preste atenção na pronúncia e no ritmo dessa frase.";
  }

  if (!sent) {
    return `Check this. ${tip}`;
  }

  // inglês + dica em português
  return `Check this: ${sent}. ${tip}`;
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

    // >>> AQUI entra o novo comportamento do áudio
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
