// /api/lti/jwks.js
// Serve a(s) chave(s) pública(s) do seu app em formato JWKS.
// Configure o JSON completo em LTI_TOOL_JWKS nas variáveis da Vercel.

export default async function handler(req, res) {
  try {
    if ((req.method || "GET").toUpperCase() !== "GET") {
      return res.status(405).json({ error: "method not allowed" });
    }

    const jwks = process.env.LTI_TOOL_JWKS; // Ex.: {"keys":[{...}]}
    if (!jwks) {
      return res.status(500).json({ error: "LTI_TOOL_JWKS não configurada" });
    }

    let parsed;
    try {
      parsed = JSON.parse(jwks);
    } catch {
      return res.status(500).json({ error: "JWKS inválida (JSON malformado)" });
    }

    if (!parsed.keys || !Array.isArray(parsed.keys) || parsed.keys.length === 0) {
      return res.status(500).json({ error: "JWKS deve conter { keys: [...] }" });
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
    res.status(200).send(jwks);
  } catch (e) {
    res.status(500).json({ error: e?.message || "jwks error" });
  }
}
