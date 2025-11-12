// /api/lti/launch.js
import {
  createRemoteJWKSet,
  jwtVerify,
  SignJWT,
  importPKCS8,
  importJWK,
} from "jose";
import { createHash, randomUUID } from "crypto";

/* ------------------ helpers ------------------ */
function parseCookies(h = "") {
  return Object.fromEntries((h || "").split(";").map(s => s.trim().split("=")));
}
async function readBody(req) {
  return await new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
}

// token curto (fallback mobile)
async function makeUserToken(userId) {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  return await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("1d")
    .sign(secret);
}

// importa a CHAVE PRIVADA para assinar RS256 (Deep Link)
async function getPrivateKey() {
  const pem = process.env.LTI_TOOL_PRIVATE_KEY_PEM && process.env.LTI_TOOL_PRIVATE_KEY_PEM.trim();
  if (pem && pem.startsWith("-----BEGIN")) {
    return await importPKCS8(pem, "RS256");
  }
  const jwkStr = process.env.LTI_TOOL_PRIVATE_KEY_JWK;
  if (jwkStr) {
    const jwk = JSON.parse(jwkStr);
    return await importJWK(jwk, "RS256");
  }
  throw new Error("Missing private key: defina LTI_TOOL_PRIVATE_KEY_PEM (PEM PKCS#8) ou LTI_TOOL_PRIVATE_KEY_JWK.");
}

// util para montar origin da sua app (ex.: https://canvas-chat-gpt.vercel.app)
function appOriginFromReq(req) {
  return `https://${req.headers.host}`;
}

/* ------------------ handler ------------------ */
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
    if (!state || state !== cookies["lti_state"]) {
      return res.status(400).send("bad state");
    }

    // verifica id_token do Canvas (LTI 1.3)
    const jwks = createRemoteJWKSet(new URL(process.env.LTI_JWKS_ENDPOINT));
    const { payload } = await jwtVerify(id_token, jwks, {
      issuer:   process.env.LTI_ISSUER,
      audience: process.env.LTI_CLIENT_ID,
    });

    // nonce anti-replay
    if (!cookies["lti_nonce"] || payload.nonce !== cookies["lti_nonce"]) {
      return res.status(400).send("bad nonce");
    }

    // identifica aluno -> hash estável
    const rawId = (payload.email && String(payload.email)) || String(payload.sub);
    const norm  = rawId.trim().toLowerCase();
    const userHash = createHash("sha256").update(norm, "utf8").digest("hex");

    // grava cookie (quando 3rd-party cookies permitidos)
    const setUser   = `lti_user=${userHash}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=2592000`; // 30 dias
    const clearSt   = `lti_state=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
    const clearNonc = `lti_nonce=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
    res.setHeader("Set-Cookie", [setUser, clearSt, clearNonc]);

    // token de fallback (mobile/iframe sem cookies)
    const t = await makeUserToken(userHash);

    // --------------- Deep Linking? ---------------
    const dl = payload["https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings"];
    if (dl && dl.deep_link_return_url) {
      const privateKey = await getPrivateKey();
      const kid = process.env.LTI_TOOL_KID;
      const now = Math.floor(Date.now() / 1000);

      // "iss" do Tool no deep link response (pode ser o origin da sua app)
      const toolIssuer =
        process.env.TOOL_ISSUER ||
        appOriginFromReq(req);

      const aud = payload.iss; // issuer do Canvas
      const deploymentId = payload["https://purl.imsglobal.org/spec/lti/claim/deployment_id"];

      // URL que o item inserido vai abrir quando clicado no Canvas
      const targetUrl =
        process.env.LTI_REDIRECT_TARGET ||
        `${appOriginFromReq(req)}/?t=${encodeURIComponent(t)}`;

      // conteúdo padrão: um "link"
      const contentItems = [
        {
          type: "link",
          title: "Chat do curso (GPT)",
          url: targetUrl,
        },
      ];

      const deepLinkJwt = await new SignJWT({
        // claims IMS para deep link
        "https://purl.imsglobal.org/spec/lti-dl/claim/content_items": contentItems,
        "https://purl.imsglobal.org/spec/lti-dl/claim/version": "1.3.0",
        "https://purl.imsglobal.org/spec/lti-dl/claim/msg": "Item adicionado com sucesso",
        "https://purl.imsglobal.org/spec/lti/claim/deployment_id": deploymentId,
      })
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(toolIssuer)
        .setAudience(aud)
        .setJti(randomUUID())
        .setIssuedAt(now)
        .setExpirationTime(now + 300) // 5 minutos
        .sign(privateKey);

      // Responde com auto-POST para o deep_link_return_url
      const returnUrl = dl.deep_link_return_url;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(`<!doctype html>
<html><body onload="document.forms[0].submit()">
  <form action="${returnUrl}" method="POST">
    <input type="hidden" name="JWT" value="${deepLinkJwt}">
    <noscript><button type="submit">Voltar ao Canvas</button></noscript>
  </form>
</body></html>`);
    }

    // --------------- Launch normal (ResourceLink) ---------------
    // redireciona para a UI com ?t=... para o front guardar no localStorage
    res.writeHead(302, { Location: `/?t=${encodeURIComponent(t)}` });
    res.end();
  } catch (e) {
    console.error("LTI LAUNCH error:", e);
    res.status(500).send(e?.message || "launch error");
  }
}

export const config = { api: { bodyParser: false } };
