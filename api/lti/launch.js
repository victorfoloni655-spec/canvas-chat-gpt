import { createRemoteJWKSet, jwtVerify } from "jose";
import { createHash } from "crypto";

function parseCookies(h=""){ return Object.fromEntries(h.split(";").map(s=>s.trim().split("="))); }
async function readBody(req){
  return await new Promise(r=>{ let d=""; req.on("data",c=>d+=c); req.on("end",()=>r(d)); });
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

    const jwks = createRemoteJWKSet(new URL(process.env.LTI_JWKS_ENDPOINT)); // JWKS do Canvas
    const { payload } = await jwtVerify(id_token, jwks, {
      issuer:   process.env.LTI_ISSUER,
      audience: process.env.LTI_CLIENT_ID,
    });

    if (!cookies["lti_nonce"] || payload.nonce !== cookies["lti_nonce"]) {
      return res.status(400).send("bad nonce");
    }

    // usa email (se enviado) ou sub (ID estável) como base, depois faz hash
    const rawId = (payload.email && String(payload.email)) || String(payload.sub);
    const norm  = rawId.trim().toLowerCase();
    const hash  = createHash("sha256").update(norm, "utf8").digest("hex");

    // cookie com hash por 30 dias
    const setUser   = `lti_user=${hash}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=2592000`;
    const clearSt   = `lti_state=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
    const clearNonc = `lti_nonce=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
    res.setHeader("Set-Cookie", [setUser, clearSt, clearNonc]);

    res.writeHead(302, { Location: "/" }); // volta para a UI
    res.end();
  } catch (e) {
    res.status(500).send(e?.message || "launch error");
  }
}
