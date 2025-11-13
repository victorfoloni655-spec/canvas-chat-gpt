// /api/lti/login.js
// Inicia o fluxo OIDC de LTI 1.3: cria state/nonce (cookies) e redireciona
// para o Authorization Endpoint do Canvas com os parâmetros corretos.

import crypto from "crypto";

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Environment variable ${name} is missing`);
  return v;
}

async function readBody(req) {
  return await new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
}

export default async function handler(req, res) {
  try {
    const CLIENT_ID   = must("LTI_CLIENT_ID");                // ex: 100000000000123
    const AUTH_URL    = must("LTI_AUTHORIZATION_ENDPOINT");   // ex: https://SEU-CANVAS/api/lti/authorize_redirect
    const REDIRECT_URI= must("LTI_REDIRECT_URI");             // ex: https://seu-app.vercel.app/api/lti/launch
    must("LTI_ISSUER"); // só para garantir que foi configurado

    let login_hint = "";
    let lti_message_hint = "";
    let iss = "";

    const ctype = (req.headers["content-type"] || "").toLowerCase();

    if (req.method === "POST" && ctype.includes("application/x-www-form-urlencoded")) {
      const raw = await readBody(req);
      const p = new URLSearchParams(raw);
      login_hint      = p.get("login_hint") || "";
      lti_message_hint= p.get("lti_message_hint") || "";
      iss             = p.get("iss") || "";
    } else {
      const q = req.query || {};
      login_hint      = q.login_hint || "";
      lti_message_hint= q.lti_message_hint || "";
      iss             = q.iss || "";
    }

    if (!login_hint || !lti_message_hint) {
      return res.status(400).json({
        error: "missing_login_or_message_hint",
        detail:
          "O Canvas deve chamar este endpoint com login_hint e lti_message_hint. " +
          "Verifique a instalação por Client ID e o placement (Course Navigation / Editor Button / Link Selection).",
        received: { iss, login_hint, lti_message_hint, method: req.method },
      });
    }

    // state/nonce válidos por 5 minutos
    const state = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    res.setHeader("Set-Cookie", [
      `lti_state=${state}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=300`,
      `lti_nonce=${nonce}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=300`,
    ]);

    const params = new URLSearchParams({
      response_type: "id_token",
      response_mode: "form_post",
      scope: "openid",
      prompt: "none",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state,
      nonce,
      login_hint,
      lti_message_hint,
    });

    const location = `${AUTH_URL}?${params.toString()}`;
    res.writeHead(302, { Location: location });
    res.end();
  } catch (e) {
    console.error("LTI LOGIN error:", e);
    res.status(500).json({ error: e?.message || "login error" });
  }
}

export const config = { api: { bodyParser: false } };
