// /api/lti/launch.js
// Trata **tanto** LtiResourceLinkRequest (navegação) quanto LtiDeepLinkingRequest (Deep Link)

import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { createHash } from "crypto";

function parseCookies(h = "") {
  return Object.fromEntries((h || "").split(";").map(s => s.trim().split("=")));
}
async function readBody(req) {
  return await new Promise(r => {
    let d = ""; req.on("data", c => d += c); req.on("end", () => r(d));
  });
}

// Assina o JWT de resposta do Deep Link com **a chave privada do TOOL**
async function signDeepLinkResponse(payload) {
  const kid = process.env.LTI_TOOL_KID;
  const pem = process.env.LTI_TOOL_PRIVATE_KEY_PEM; // -----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----
  if (!kid || !pem) throw new Error("Faltam LTI_TOOL_KID ou LTI_TOOL_PRIVATE_KEY_PEM");

  // jose aceita PKCS8 PEM diretamente
  const encoder = new TextEncoder();
  // OBS: jose 5 aceita importação com crypto.subtle; em edge vercel funciona
  // Simplificando, usamos SignJWT com "key" PEM via webcrypto: 
  // Em ambientes sem importKey direto do PEM, seria preciso converter. Na Vercel funciona.

  // Para assegurar compatibilidade, usamos a API de chave diretamente no SignJWT com node18+:
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setAudience("https://purl.imsglobal.org/spec/lti-dl") // aud recomendado pela IMS
    .sign({
      // jose aceita "keyLike"; node 18+ consegue ler PEM string automaticamente
      // Em ambientes antigos, precisaria de importPKCS8. Aqui mantemos simples:
      // @ts-ignore
      key: pem
    });
}

// Gera o HTML que auto-posta o JWT para o Deep Link Return URL
function deepLinkResponseHTML(returnUrl, jwt) {
  return `<!doctype html><html><body>
<form id="f" method="POST" action="${returnUrl}">
  <input type="hidden" name="JWT" value="${jwt}">
</form>
<script>document.getElementById('f').submit()</script>
</body></html>`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method not allowed");

    const ctype = (req.headers["content-type"] || "").toLowerCase();
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
    if (!state || state !== cookies["lti_state"]) {
      return res.status(400).send("bad state");
    }

    const jwks = createRemoteJWKSet(new URL(process.env.LTI_JWKS_ENDPOINT));
    const { payload } = await jwtVerify(id_token, jwks, {
      issuer:   process.env.LTI_ISSUER,
      audience: process.env.LTI_CLIENT_ID,
    });

    // Nonce anti-replay
    if (!cookies["lti_nonce"] || payload.nonce !== cookies["lti_nonce"]) {
      return res.status(400).send("bad nonce");
    }

    // Descobre o tipo de mensagem
    const msgType = payload["https://purl.imsglobal.org/spec/lti/claim/message_type"];
    // Claims úteis
    const deepLink = payload["https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings"];

    if (msgType === "LtiDeepLinkingRequest") {
      // === CAMINHO DE DEEP LINK ===
      if (!deepLink || !deepLink.deep_link_return_url) {
        return res.status(400).send("Deep Linking inválido: deep_link_return_url ausente");
      }

      // Monte os "content_items" (o que será inserido no Canvas)
      // Exemplo mínimo: um LTI Resource Link apontando para a sua página principal
      const targetUrl = `${new URL("/", `https://${req.headers.host}`).toString()}`;

      const contentItems = [
        {
          type: "ltiResourceLink",
          title: "IA English Journey",
          url: targetUrl,
          // opcional: custom fields
          // "custom": { "foo": "bar" }
        }
      ];

      const dlPayload = {
        "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiDeepLinkingResponse",
        "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
        "https://purl.imsglobal.org/spec/lti-dl/claim/content_items": contentItems,
        "https://purl.imsglobal.org/spec/lti-dl/claim/data": deepLink.data || undefined,
        // opcional: janela/sugestões de apresentação
        // "https://purl.imsglobal.org/spec/lti-dl/claim/manifest": { ... }
      };

      const jwt = await signDeepLinkResponse(dlPayload);
      const html = deepLinkResponseHTML(deepLink.deep_link_return_url, jwt);

      // Limpa os cookies de login/nonce/state para não vazar
      res.setHeader("Set-Cookie", [
        `lti_state=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`,
        `lti_nonce=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`,
      ]);
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send(html);
      return;
    }

    // === CAMINHO DE NAVEGAÇÃO (LtiResourceLinkRequest) ===
    // Escolhe identificador estável do aluno
    const rawId = (payload.email && String(payload.email)) || String(payload.sub);
    const norm  = rawId.trim().toLowerCase();
    const userHash = createHash("sha256").update(norm, "utf8").digest("hex");

    // Seta cookie do usuário (para quota etc.)
    const setUser   = `lti_user=${userHash}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=2592000`;
    const clearSt   = `lti_state=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
    const clearNonc = `lti_nonce=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
    res.setHeader("Set-Cookie", [setUser, clearSt, clearNonc]);

    // Volta para a UI principal
    res.writeHead(302, { Location: "/" });
    res.end();
  } catch (e) {
    console.error("LTI LAUNCH error:", e);
    res.status(500).send(e?.message || "launch error");
  }
}

export const config = { api: { bodyParser: false } };
