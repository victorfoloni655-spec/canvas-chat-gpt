// /api/lti/launch.js
import { createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8 } from "jose";
import { createHash } from "crypto";

function parseCookies(h = "") {
  return Object.fromEntries((h || "").split(";").map(s => s.trim().split("=")));
}
async function readBody(req) {
  return await new Promise(r => {
    let d = "";
    req.on("data", c => d += c);
    req.on("end", () => r(d));
  });
}

// --------- helpers p/ Deep Linking ----------
function dlContentItem({ title, url, iframeHeight = 650 }) {
  return {
    type: "ltiResourceLink",
    title,
    url,
    // Preferências de apresentação (Canvas respeita para iframe)
    iframe: { width: 800, height: iframeHeight }
  };
}
async function signDeepLinkJwt({ iss, aud, deployment_id, deep_link_return_url, content_items }) {
  const kid = process.env.LTI_TOOL_KID;
  const pkcs8 = process.env.LTI_TOOL_PRIVATE_KEY_PEM;
  if (!kid || !pkcs8) throw new Error("Faltam LTI_TOOL_KID e/ou LTI_TOOL_PRIVATE_KEY_PEM");

  const privateKey = await importPKCS8(pkcs8, "RS256");
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    iss,                // sua ferramenta
    aud,                // Canvas issuer
    iat: now,
    exp: now + 5 * 60,
    nonce: cryptoRandom(),

    "https://purl.imsglobal.org/spec/lti/claim/deployment_id": deployment_id,
    "https://purl.imsglobal.org/spec/lti-dl/claim/content_items": content_items,
    "https://purl.imsglobal.org/spec/lti-dl/claim/data": ""
  };

  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid })
    .sign(privateKey)
    .then(id_token => deepLinkResponseHTML(deep_link_return_url, id_token));
}
function deepLinkResponseHTML(returnUrl, id_token) {
  return `<!doctype html>
<html><body>
  <form id="f" method="POST" action="${returnUrl}">
    <input type="hidden" name="JWT" value="${id_token}"/>
  </form>
  <script>document.getElementById('f').submit()</script>
</body></html>`;
}
function cryptoRandom() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2,"0")).join("");
}
// -------------------------------------------

async function makeUserToken(userId) {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  return await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("1d")
    .sign(secret);
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

    const jwks = createRemoteJWKSet(new URL(process.env.LTI_JWKS_ENDPOINT));
    const { payload } = await jwtVerify(id_token, jwks, {
      issuer:   process.env.LTI_ISSUER,
      audience: process.env.LTI_CLIENT_ID,
    });

    // nonce anti-replay
    if (!cookies["lti_nonce"] || payload.nonce !== cookies["lti_nonce"]) {
      return res.status(400).send("bad nonce");
    }

    // ── Branch 1: Deep Linking ─────────────────────────────────
    const msgType = payload["https://purl.imsglobal.org/spec/lti/claim/message_type"];
    if (msgType === "LtiDeepLinkingRequest") {
      const returnUrl = payload["https://purl.imsglobal.org/spec/lti-dl/claim/deep_link_return_url"];
      if (!returnUrl) return res.status(400).send("missing deep_link_return_url");

      const deployment_id = payload["https://purl.imsglobal.org/spec/lti/claim/deployment_id"];
      const iss = process.env.LTI_TOOL_ISS || `https://${req.headers.host}`;
      const aud = payload.iss;

      // Vai embutir seu / no iframe (pode apontar para outra rota da sua UI se quiser)
      const origin = `https://${req.headers.host}`;
      const items = [dlContentItem({ title: "Chat do curso (GPT)", url: origin + "/", iframeHeight: 650 })];

      const html = await signDeepLinkJwt({
        iss, aud, deployment_id,
        deep_link_return_url: returnUrl,
        content_items: items
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(html);
      return;
    }

    // ── Branch 2: LtiResourceLinkRequest (ou outro) → fluxo normal do chat ─────
    const rawId = (payload.email && String(payload.email)) || String(payload.sub);
    const norm  = rawId.trim().toLowerCase();
    const userHash = createHash("sha256").update(norm, "utf8").digest("hex");

    // cookie + limpa state/nonce
    const setUser   = `lti_user=${userHash}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=2592000`;
    const clearSt   = `lti_state=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
    const clearNonc = `lti_nonce=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
    res.setHeader("Set-Cookie", [setUser, clearSt, clearNonc]);

    // fallback token (mobile/iframe)
    const t = await makeUserToken(userHash);
    res.writeHead(302, { Location: `/?t=${encodeURIComponent(t)}` });
    res.end();
  } catch (e) {
    console.error("LTI LAUNCH error:", e);
    res.status(500).send(e?.message || "launch error");
  }
}

export const config = { api: { bodyParser: false } };
