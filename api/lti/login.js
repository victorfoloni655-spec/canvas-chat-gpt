// /api/lti/login.js
// Inicia o fluxo OIDC do LTI 1.3 no Canvas.
// Deve ser chamado pelo Canvas com ?login_hint=...&lti_message_hint=...

import crypto from "crypto";

function assertEnv(name, value) {
  if (!value) {
    throw new Error(`Environment variable ${name} is missing`);
  }
  return value;
}

export default async function handler(req, res) {
  try {
    // --- Variáveis obrigatórias (configure na Vercel: Settings → Environment Variables) ---
    const clientId    = assertEnv("LTI_CLIENT_ID",               process.env.LTI_CLIENT_ID);
    const issuer      = assertEnv("LTI_ISSUER",                  process.env.LTI_ISSUER); // não é usado aqui, mas bom validar
    const auth        = assertEnv("LTI_AUTHORIZATION_ENDPOINT",  process.env.LTI_AUTHORIZATION_ENDPOINT);
    const redirectUri = assertEnv("LTI_REDIRECT_URI",            process.env.LTI_REDIRECT_URI);

    // --- Parâmetros vindos do Canvas ---
    const { login_hint = "", lti_message_hint = "", iss = "" } = req.query || {};

    // Logs de diagnóstico (veja em Vercel → Deployments → View Functions Logs)
    console.log("LTI LOGIN query:", req.query);
    console.log("issuer (iss):", iss);
    console.log("login_hint:", login_hint, "lti_message_hint:", lti_message_hint);

    // Se você abrir esta URL manualmente no navegador, estes params virão vazios.
    if (!login_hint || !lti_message_hint) {
      // Ajuda a diagnosticar configurações incorretas de placement/instalação
      return res.status(400).json({
        error: "missing_login_or_message_hint",
        detail:
          "Este endpoint deve ser chamado pelo Canvas (LTI 1.3) com login_hint e lti_message_hint. " +
          "Verifique se o app foi instalado por Client ID e se o Course Navigation aponta para /api/lti/login.",
        received: { login_hint, lti_message_hint }
      });
    }

    // --- Proteções de CSRF/Replay ---
    const state = crypto.randomUUID();
    const nonce = crypto.randomUUID();

    // Cookies httpOnly para validar o retorno (valem por 5 minutos)
    res.setHeader("Set-Cookie", [
      `lti_state=${state}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=300`,
      `lti_nonce=${nonce}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=300`,
    ]);

    // --- Redireciona para o authorize_redirect do Canvas com os parâmetros obrigatórios ---
    const params = new URLSearchParams({
      response_type: "id_token",
      response_mode: "form_post",
      scope: "openid",
      prompt: "none",
      client_id: clientId,
      redirect_uri: redirectUri, // /api/lti/launch
      state,
      nonce,
      login_hint,
      lti_message_hint,
    });

    const location = `${auth}?${params.toString()}`;
    console.log("Redirecting to:", location);

    res.writeHead(302, { Location: location });
    res.end();
  } catch (e) {
    console.error("LTI LOGIN error:", e);
    res.status(500).json({ error: e?.message || "login error" });
  }
}
