// /api/lti/deeplink.js
// LTI 1.3 Deep Linking "launch" -> retorna a Deep Linking Response para o Canvas

import { createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8 } from "jose";

// Helpers
async function readBody(req) {
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}
function htmlAutoPost(url, params) {
  const inputs = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v)}"/>`)
    .join("");
  return `<!doctype html><meta charset="utf-8">
  <form action="${url}" method="POST">${inputs}</form>
  <script>document.forms[0].submit()</script>`;
}

export default async function handler(req, res) {
  try {
    // O Canvas manda o id_token por POST (form_post)
    const ctype = (req.headers["content-type"] || "").toLowerCase();
    if (!ctype.includes("application/x-www-form-urlencoded")) {
      return res.status(400).send("expected form_post");
    }

    const raw = await readBody(req);
    const p = new URLSearchParams(raw);
    const id_token = p.get("id_token");
    const state    = p.get("state");
    if (!id_token) return res.status(400).send("missing id_token");

    // Verifica id_token do Canvas (igual ao /api/lti/launch.js)
    const jwks = createRemoteJWKSet(new URL(process.env.LTI_JWKS_ENDPOINT));
    const { payload } = await jwtVerify(id_token, jwks, {
      issuer:   process.env.LTI_ISSUER,
      audience: process.env.LTI_CLIENT_ID,
    });

    // Confere tipo de mensagem Deep Linking
    const msgType = payload["https://purl.imsglobal.org/spec/lti/claim/message_type"];
    if (msgType !== "LtiDeepLinkingRequest") {
      return res.status(400).send("not a deep-linking launch");
    }

    // Pega o return_url do Canvas
    const deep = payload["https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings"] || {};
    const returnUrl = deep.deep_link_return_url;
    if (!returnUrl) return res.status(400).send("missing deep_link_return_url");

    // Recurso que vamos inserir (um ResourceLink apontando para o teu login LTI)
    const resourceUrl = new URL(process.env.LTI_REDIRECT_URI); // ex.: https://<seu domínio>/api/lti/launch
    // Opcionalmente, pode apontar para /api/lti/login (inicia OIDC) se preferir fluxo sempre fresco.

    const contentItems = [
      {
        "type": "ltiResourceLink",
        "title": "Chat do curso (GPT)",
        "url": resourceUrl.toString(),
        // Opcional: custom params
        "custom": {
          // exemplo: "theme": "dark"
        }
      }
    ];

    // Monta o JWT de Deep Linking Response (assinado com a chave do TEU TOOL)
    const now = Math.floor(Date.now() / 1000);
    const kid = process.env.LTI_TOOL_KID;
    const pem = process.env.LTI_TOOL_PRIVATE_KEY_PEM;
    if (!kid || !pem) return res.status(500).send("missing tool key (kid/pem)");

    const privateKey = await importPKCS8(pem, "RS256");

    const dlJwt = await new SignJWT({
      "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiDeepLinkingResponse",
      "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
      "https://purl.imsglobal.org/spec/lti-dl/claim/content_items": contentItems,
      "https://purl.imsglobal.org/spec/lti-dl/claim/data": deep.data || undefined
    })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(process.env.LTI_CLIENT_ID)       // o "iss" da resposta é o CLIENT_ID do Tool
      .setAudience(payload.iss)                   // aud = issuer do Canvas
      .setIssuedAt(now)
      .setExpirationTime(now + 60 * 5)            // 5 minutos
      .sign(privateKey);

    // Devolve via auto-POST para o Canvas
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(htmlAutoPost(returnUrl, { JWT: dlJwt, state: state || "" }));
  } catch (e) {
    console.error("DEEPLINK error:", e);
    res.status(500).send(e?.message || "deeplink error");
  }
}

export const config = { api: { bodyParser: false } };
