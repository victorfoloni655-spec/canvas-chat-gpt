// /api/lti/launch.js
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { createHash } from "crypto";

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

async function makeUserToken(userId) {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  // Token curto: 1 dia (ajuste se quiser: "1h", "12h", etc.)
  return await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("1d")
    .sign(secret);
}

export default async function handler(req, res) {
  try {
    // Canvas envia via POST (response_mode=form_post)
    if ((req.method || "GET").toUpperCase() !== "POST") {
      return res.status(405).send("method not allowed");
    }

    const ctype = (req.headers["content-type"] || "").toLowerCase();
    let id_token, state;

    if (ctype.includes("application/x-www-form-urlencoded")) {
      const raw = await readBody(req);
      const p = new URLSearchParams(raw);
      id_token = p.get("id_token");
      state    = p.get("state");
    } else {
      // fallback (raro)
      id_token = req.body?.id_token;
      state    = req.body?.state;
    }

    if (!id_token) return res.status(400).send("missing id_token");

    const cookies = parseCookies(req.headers.cookie || "");
    if (!state || state !== cookies["lti_state"]) return res.status(400).send("bad state");

    // Verifica id_token do Canvas (iss/aud/JWKS)
    const jwks = createRemoteJWKSet(new URL(process.env.LTI_JWKS_ENDPOINT)); // ex.: https://SEU-CANVAS/api/lti/security/jwks
    const { payload } = await jwtVerify(id_token, jwks, {
      issuer:   process.env.LTI_ISSUER,     // ex.: https://SEU-CANVAS
      audience: process.env.LTI_CLIENT_ID,  // Client ID da Developer Key
    });

    // Nonce anti-replay
    if (!cookies["lti_nonce"] || payload.nonce !== cookies["lti_nonce"]) {
      return res.status(400).send("bad nonce");
    }

    // Identificador estável do aluno (usa email quando disponível)
    const rawId = (payload.email && String(payload.email)) || String(payload.sub);
    const norm  = rawId.trim().toLowerCase();
    const userHash = createHash("sha256").update(norm, "utf8").digest("hex");

    // 1) Cookie (desktop; se 3rd-party cookies permitidos)
    const setUser   = `lti_user=${userHash}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=2592000`; // 30 dias
    const clearSt   = `lti_state=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
    const clearNonc = `lti_nonce=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
    res.setHeader("Set-Cookie", [setUser, clearSt, clearNonc]);

    // 2) Token curto para iframe/mobile (contador via ?t=...)
    const t = await makeUserToken(userHash);

    // Redireciona para a UI com ?t=... (o front captura e salva no localStorage)
    res.writeHead(302, { Location: `/?t=${encodeURIComponent(t)}` });
    res.end();
  } catch (e) {
    console.error("LTI LAUNCH error:", e);
    res.status(500).send(e?.message || "launch error");
  }
}

// Desliga o body parser para receber form_post cru
export const config = { api: { bodyParser: false } };
