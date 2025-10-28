// /api/lti/launch.js
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
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

async function makeUserToken(userId) {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  // Token curto: 1 dia. Ajuste se quiser.
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

    // Verifica id_token do Canvas
    const jwks = createRemoteJWKSet(new URL(process.env.LTI_JWKS_ENDPOINT)); // ex.: https://<seu-canvas>/api/lti/security/jwks
    const { payload } = await jwtVerify(id_token, jwks, {
      issuer:   process.env.LTI_ISSUER,     // ex.: https://<seu-canvas>
      audience: process.env.LTI_CLIENT_ID,  // Client ID do app
    });

    // Nonce anti-replay
    if (!cookies["lti_nonce"] || payload.nonce !== cookies["lti_nonce"]) {
      return res.status(400).send("bad nonce");
    }

    // Escolhe identificador estável do aluno (email se presente, senão "sub" do LTI)
    const rawId = (payload.email && String(payload.email)) || String(payload.sub);
    const norm  = rawId.trim().toLowerCase();

    // Hash (não reversível) para usar como ID interno
    const userHash = createHash("sha256").update(norm, "utf8").digest("hex");

    // 1) Cookie (quando o navegador permitir cookies 3rd-party)
    const setUser   = `lti_user=${userHash}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=2592000`; // 30 dias
    const clearSt   = `lti_state=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
    const clearNonc = `lti_nonce=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
    res.setHeader("Set-Cookie", [setUser, clearSt, clearNonc]);

    // 2) Fallback sem cookies: token curto (funciona no iframe em iOS/Android)
    const t = await makeUserToken(userHash);

    // Redireciona para a sua UI com ?t=... (o front lê e guarda no localStorage)
    res.writeHead(302, { Location: `/?t=${encodeURIComponent(t)}` });
    res.end();
  } catch (e) {
    console.error("LTI LAUNCH error:", e);
    res.status(500).send(e?.message || "launch error");
  }
}
