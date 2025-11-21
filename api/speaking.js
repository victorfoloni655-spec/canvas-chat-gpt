// /api/speaking.js
// Recebe áudio (base64), identifica o aluno via LTI, transcreve com gpt-4o-mini-transcribe
// e gera feedback de pronúncia com gpt-4o-mini (texto).

import { jwtVerify } from "jose";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_TEXT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

if (!OPENAI_API_KEY) {
  console.warn("⚠️ OPENAI_API_KEY não configurada — /api/speaking não vai funcionar.");
}

// --- helpers básicos ---

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

// --- chama Audio API para transcrever ---

async function transcribeAudioFromBase64(base64) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada");

  const buffer = Buffer.from(base64, "base64");

  // Node 18+ / Vercel: Blob e FormData disponíveis via fetch/undici
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
  // campo padrão da API é "text"
  return data.text || "";
}

// --- chama gpt-4o-mini para corrigir e dar feedback ---

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

  // tenta interpretar como JSON
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // fallback: manda tudo como feedback bruto
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

// --- handler principal ---

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

    // (aqui no futuro podemos somar minutos em Redis, etc.)

    // 1) Transcreve o áudio
    const transcript = await transcribeAudioFromBase64(audio);

    // 2) Gera correção + feedback
    const feedback = await buildFeedbackFromTranscript(transcript || "");

    return res.status(200).json({
      user: userId,
      transcript,
      correct_sentence: feedback.correct_sentence,
      feedback_text: feedback.feedback_text,
    });
  } catch (e) {
    console.error("SPEAKING error:", e);
    return res.status(500).json({ error: e?.message || "speaking internal error" });
  }
}

export const config = { api: { bodyParser: false } };
