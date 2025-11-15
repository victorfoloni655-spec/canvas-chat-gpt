// /api/lti/deeplink.js
// Valida o id_token do Canvas e responde com o Deep Link Response (JWT RS256).
import {
  createRemoteJWKSet,
  jwtVerify,
  SignJWT,
  importPKCS8,
  importJWK,
} from "jose";
import { createHash, randomUUID } from "crypto";

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
  const pem =
    process.env.LTI_TOOL_PRIVATE_KEY_PEM &&
    process.env.LTI_TOOL_PRIVATE_KEY_PEM.trim();
  if (pem && pem.startsWith("-----BEGIN")) {
    return await importPKCS8(pem, "RS256");
  }
  const jwkStr = process.env.LTI_TOOL_PRIVATE_KEY_JWK;
  if (jwkStr) {
    const jwk = JSON.parse(jwkStr);
    return await importJWK(jwk, "RS256");
  }
  throw new Error(
    "Missing private key: defina LTI_TOOL_PRIVATE_KEY_PEM (PEM PKCS#8) ou LTI_TOOL_PRIVATE_KEY_JWK."
  );
}

function appOriginFromReq(req) {
  return `https://${req.headers.host}`;
}

export default async function handler(req, res) {
  try {
    const ctype = req.headers["content-type"] || "";
    let id_token, state;

    if (ctype.includes("application/x-www-form-urlencoded")) {
      const raw = await readBody(req);
      const p = new URLSearchParams(raw);
      id_token = p.get("id_token");
      state = p.get("state");
    } else {
      id_token = req.body?.id_token;
      state = req.body?.state;
    }
    if (!id_token) return res.status(400).send("missing id_token");

    const cookies = parseCookies(req.headers.cookie || "");
    if (!state || state !== cookies["lti_state"]) {
      return res.status(400).send("bad state");
    }

    const jwks = createRemoteJWKSet(new URL(process.env.LTI_JWKS_ENDPOINT));
    const { payload } = await jwtVerify(id_token, jwks, {
      issuer: process.env.LTI_ISSUER,
      audience: process.env.LTI_CLIENT_ID,
    });

    if (!cookies["lti_nonce"] || payload.nonce !== cookies["lti_nonce"]) {
      return res.status(400).send("bad nonce");
    }

    // identificar o usuário (para gerar ?t=...)
    const rawId =
      (payload.email && String(payload.email)) || String(payload.sub);
    const norm = rawId.trim().toLowerCase();
    const userHash = createHash("sha256").update(norm, "utf8").digest("hex");
    const t = await makeUserToken(userHash);

    // claims de Deep Link
    const dl =
      payload[
        "https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings"
      ];
    if (!dl || !dl.deep_link_return_url) {
      return res.status(400).send("missing deep_link_return_url");
    }

    const privateKey = await getPrivateKey();
    const kid = process.env.LTI_TOOL_KID;
    const now = Math.floor(Date.now() / 1000);

    // IMPORTANTE:
    // Para o Canvas, o JWT de Deep Link deve ter:
    //   iss = client_id da ferramenta
    //   sub = client_id da ferramenta
    //   aud = issuer do Canvas (https://canvas.instructure.com)
    const clientId = process.env.LTI_CLIENT_ID;
    const platformIssuer = process.env.LTI_ISSUER || payload.iss;

    const deploymentId =
      payload["https://purl.imsglobal.org/spec/lti/claim/deployment_id"];

    const targetUrl =
      process.env.LTI_REDIRECT_TARGET ||
      `${appOriginFromReq(req)}/?t=${encodeURIComponent(t)}`;

        const contentItems = [
  {
    type: "ltiResourceLink",
    title: "Chat do curso (GPT)",
    url: targetUrl,
    // dica pro Canvas: abrir em iframe dentro da página
    presentation: {
      documentTarget: "iframe",
    },
  },
];
    
    // só pra depuração (se quiser olhar depois nos logs da Vercel):
    console.log("DEEPLINK building JWT", {
      iss: clientId,
      sub: clientId,
      aud: platformIssuer,
      returnUrl: dl.deep_link_return_url,
    });

    const deepLinkJwt = await new SignJWT({
      "https://purl.imsglobal.org/spec/lti-dl/claim/content_items": contentItems,
      "https://purl.imsglobal.org/spec/lti-dl/claim/version": "1.3.0",
      "https://purl.imsglobal.org/spec/lti-dl/claim/msg":
        "Item adicionado com sucesso",
      "https://purl.imsglobal.org/spec/lti/claim/deployment_id": deploymentId,
    })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(clientId) // iss = Client ID
      .setSubject(clientId) // sub = Client ID
      .setAudience(platformIssuer) // aud = issuer do Canvas
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);

    const returnUrl = dl.deep_link_return_url;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(`<!doctype html>
<html><body onload="document.forms[0].submit()">
  <form action="${returnUrl}" method="POST">
    <input type="hidden" name="JWT" value="${deepLinkJwt}">
    <noscript><button type="submit">Voltar ao Canvas</button></noscript>
  </form>
</body></html>`);
  } catch (e) {
    console.error("LTI DEEPLINK error:", e);
    res.status(500).send(e?.message || "deeplink error");
  }
}

export const config = { api: { bodyParser: false } };
