// /api/lti/login.js
import crypto from "crypto";

function assertEnv(name, value) {
  if (!value) throw new Error(`Environment variable ${name} is missing`);
  return value;
}

async function readBody(req) {
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

export default async function handler(req, res) {
  try {
    const clientId    = assertEnv("LTI_CLIENT_ID",              process.env.LTI_CLIENT_ID);
    const auth        = assertEnv("LTI_AUTHORIZATION_ENDPOINT", process.env.LTI_AUTHORIZATION_ENDPOINT);
    const redirectUri = assertEnv("LTI_REDIRECT_URI",           process.env.LTI_REDIRECT_URI);
    assertEnv("LTI_ISSUER", process.env.LTI_ISSUER); // só valida, não usamos aqui

    let login_hint = "";
    let lti_message_hint = "";
    let iss = "";

    const ctype = (req.headers["content-type"] || "").toLowerCase();

    if (req.method === "POST" && ctype.includes("application/x-www-form-urlencoded")) {
      const raw = await readBody(req);
      const p = new URLSearchParams(raw);
      login_hint = p.get("login_hint") || "";
      lti_message_hint = p.get("lti_message_hint") || "";
      iss = p.get("iss") || "";
    } else {
      // GET (ou POST sem form): tenta pegar pela querystring
      const q = req.query || {};
      login_hint = q.login_hint || "";
      lti_message_hint = q.lti_message_hint || "";
      iss = q.iss || "";
    }

    console.log("LTI LOGIN method:", req.method, "ctype:", ctype);
    console.log("LTI LOGIN values:", { iss, login_hint, lti_message_hint });

    if (!login_hint || !lti_message_hint) {
      return res.status(400).json({
        error: "missing_login_or_message_hint",
        detail:
          "O Canvas deve chamar este endpoint (LTI 1.3) com login_hint e lti_message_hint. " +
          "Se o erro persistir, verifique a instalação por Client ID e o placement Course Navigation → /api/lti/login.",
        received: { login_hint, lti_message_hint, iss, method: req.method }
      });
    }

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

    const location = `${auth}?${params.toString()}`;
    console.log("Redirecting to authorize:", location);
    res.writeHead(302, { Location: location });
    res.end();
  } catch (e) {
    console.error("LTI LOGIN error:", e);
    res.status(500).json({ error: e?.message || "login error" });
  }
}
