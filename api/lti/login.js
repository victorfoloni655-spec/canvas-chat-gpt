import crypto from "crypto";

export default async function handler(req, res) {
  try {
    const clientId    = process.env.LTI_CLIENT_ID;                // ex.: 1234...
    const issuer      = process.env.LTI_ISSUER;                    // ex.: https://SEU_CANVAS.instructure.com
    const auth        = process.env.LTI_AUTHORIZATION_ENDPOINT;    // ex.: https://SEU_CANVAS.instructure.com/api/lti/authorize_redirect
    const redirectUri = process.env.LTI_REDIRECT_URI;              // ex.: https://canvas-chat-gpt.vercel.app/api/lti/launch

    const { login_hint = "", lti_message_hint = "" } = req.query || {};
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
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      nonce,
      login_hint,
      lti_message_hint,
    });

    res.writeHead(302, { Location: `${auth}?${params.toString()}` });
    res.end();
  } catch (e) {
    res.status(500).send(e?.message || "login error");
  }
}
