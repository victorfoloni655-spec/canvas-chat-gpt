// /api/lti/launch.js
import { createRemoteJWKSet, jwtVerify, SignJWT, importJWK } from "jose";
import { createHash } from "crypto";

function parseCookies(h = "") {
  return Object.fromEntries((h || "").split(";").map(s => s.trim().split("=")));
}
async function readBody(req) {
  return await new Promise(r => {
    let d = ""; req.on("data", c => d += c); req.on("end", () => r(d));
  });
}

// ---------- token curto para fallback mobile (iframe sem cookies) ----------
async function makeUserToken(userId) {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  return await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("1d")
    .sign(secret);
}

// ---------- resposta Deep Linking (Canvas) ----------
async function deepLinkResponseHTML(idTokenPayload) {
  const BASE_URL = process.env.BASE_URL;                  // ex: https://seu-app.vercel.app
  const PRIVATE_JWK_JSON = process.env.LTI_TOOL_PRIVATE_JWK; // chave PRIVADA (JWK), mesma família do LTI_TOOL_JWKS

  if (!BASE_URL || !PRIVATE_JWK_JSON) {
    throw new Error("BASE_URL ou LTI_TOOL_PRIVATE_JWK não configuradas");
  }

  // Claims do id_token do Canvas
  const msgType = idTokenPayload["https://purl.imsglobal.org/spec/lti/claim/message_type"];
  const dlData  = idTokenPayload["https://purl.imsglobal.org/spec/lti-dl/claim/data"];         // ecoar de volta se existir
  const returnUrl = idTokenPayload["https://purl.imsglobal.org/spec/lti-dl/claim/return_url"]; // para onde postar a resposta
  const deploymentId = idTokenPayload["https://purl.imsglobal.org/spec/lti/claim/deployment_id"];
  const audFromIdToken = idTokenPayload.aud;
  const issPlatform = idTokenPayload.iss;

  if (msgType !== "LtiDeepLinkingRequest" || !returnUrl) {
    throw new Error("Deep Linking inválido (message_type/return_url ausentes)");
  }

  // Conteúdo que o Canvas vai inserir (um LTI Resource Link que inicia OIDC em /api/lti/login)
  const contentItems = [
    {
      type: "ltiResourceLink",
      title: "IA English Journey",
      url: `${BASE_URL}/api/lti/login`,
      // opcional: custom fields, lineItem, etc.
    }
  ];

  // Prepara chave privada
  let privateJwk;
  try { privateJwk = JSON.parse(PRIVATE_JWK_JSON); } catch { throw new Error("LTI_TOOL_PRIVATE_JWK inválida"); }
  const key = await importJWK(privateJwk, "RS256");

  // Monta JWT Deep Linking Response (Canvas é tolerante; estes campos funcionam bem)
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({
      "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiDeepLinkingResponse",
      "https://purl.imsglobal.org/spec/lti-dl/claim/version": "1.0.0",
      "https://purl.imsglobal.org/spec/lti-dl/claim/content_items": contentItems,
      "https://purl.imsglobal.org/spec/lti/claim/deployment_id": deploymentId,
      ...(dlData ? { "https://purl.imsglobal.org/spec/lti-dl/claim/data": dlData } : {})
    })
    // Header RS256 com o mesmo kid da sua JWKS pública
    .setProtectedHeader({ alg: "RS256", kid: privateJwk.kid })
    // Issuer: seu tool (BASE_URL). Audience: plataforma (issuer do id_token).
    .setIssuer(BASE_URL)
    .setAudience(issPlatform || audFromIdToken)
    .setIssuedAt(now)
    .setExpirationTime(now + 300) // 5 min
    .sign(key);

  // HTML com autosubmit para o return_url do Canvas
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Returning to Canvas…</title></head>
<body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding: 24px;">
  <p>Concluindo seleção…</p>
  <form id="f" method="POST" action="${returnUrl}">
    <input type="hidden" name="JWT" value="${jwt}">
  </form>
  <script>document.getElementById('f').submit();</script>
</body></html>`;
}

export default async function handler(req, res) {
  try {
    const ctype = req.headers["content-type"] || "";
    let id_token, state;

    if (ctype.includes("application/x-www-form-urlencoded")) {
      const raw = await readBody(req);
      const p = new URLSearchParams(raw);
      id_token = p.get("id_token");
      state    = p.get("state");
    } else {
      id_token = req.body?.id_token;
      state    = req.body?.state;
    }
    if (!id_token) return res.status(400).send("missing id_token");

    const cookies = parseCookies(req.headers.cookie || "");
    if (!state || state !== cookies["lti_state"]) return res.status(400).send("bad state");

    // Verifica id_token vindo do Canvas
    const jwks = createRemoteJWKSet(new URL(process.env.LTI_JWKS_ENDPOINT));
    const { payload } = await jwtVerify(id_token, jwks, {
      issuer:   process.env.LTI_ISSUER,
      audience: process.env.LTI_CLIENT_ID,
    });

    // Confere nonce anti-replay
    if (!cookies["lti_nonce"] || payload.nonce !== cookies["lti_nonce"]) {
      return res.status(400).send("bad nonce");
    }

    // Se for Deep Linking: responde com o item e encerra aqui
    const msgType = payload["https://purl.imsglobal.org/spec/lti/claim/message_type"];
    if (msgType === "LtiDeepLinkingRequest") {
      const html = await deepLinkResponseHTML(payload);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(html);
      return;
    }

    // ---------- Lançamento LTI normal ----------
    // usa email (se enviado) ou sub (ID estável) como base, depois faz hash
    const rawId = (payload.email && String(payload.email)) || String(payload.sub);
    const norm  = rawId.trim().toLowerCase();
    const userHash = createHash("sha256").update(norm, "utf8").digest("hex");

    // 1) Cookie 3rd-party (quando permitido pelo navegador)
    const setUser   = `lti_user=${userHash}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=2592000`;
    const clearSt   = `lti_state=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
    const clearNonc = `lti_nonce=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
    res.setHeader("Set-Cookie", [setUser, clearSt, clearNonc]);

    // 2) Fallback mobile sem cookies: token curto no query (?t=...)
    const t = await makeUserToken(userHash);

    // Volta para a UI principal (o front lê ?t=..., salva e usa no /api/chat e /api/quota)
    res.writeHead(302, { Location: `/?t=${encodeURIComponent(t)}` });
    res.end();
  } catch (e) {
    console.error("LTI LAUNCH error:", e);
    res.status(500).send(e?.message || "launch error");
  }
}
