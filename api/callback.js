// Troca o código de autorização OAuth2 por tokens — usado uma vez, manualmente,
// pra conectar uma conta Olist nova (Rampa ou TF). A URL de autorização que o
// usuário abre no navegador deve incluir "&state=rampa" ou "&state=tf" pra essa
// função saber de qual empresa são as credenciais (a Tiny devolve o state de volta
// no redirect). Sem state, assume "rampa" (comportamento histórico).
const https = require("https");
const { getConfigEmpresa } = require("./_lib/empresas");

const REDIRECT_URI = "https://consulta-olist.vercel.app/api/callback";

function httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "POST", headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  const code = req.query.code;
  const error = req.query.error;
  const empresa = String(req.query.state || "rampa").toLowerCase();

  if (error) return res.status(200).send(`<h2>Erro: ${error}</h2>`);

  if (!code) return res.status(200).send(`<h2>Sem code</h2><pre>${JSON.stringify(req.query)}</pre>`);

  try {
    const { clientId, clientSecret } = getConfigEmpresa(empresa);

    const body = "grant_type=authorization_code"
      + "&client_id=" + encodeURIComponent(clientId)
      + "&client_secret=" + encodeURIComponent(clientSecret)
      + "&code=" + encodeURIComponent(code)
      + "&redirect_uri=" + encodeURIComponent(REDIRECT_URI);

    const r = await httpsPost(
      "accounts.tiny.com.br",
      "/realms/tiny/protocol/openid-connect/token",
      body,
      { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
    );

    const data = JSON.parse(r.text);

    res.status(200).send(`
      <h2>✅ Tokens obtidos para "${empresa}"!</h2>
      <p><strong>Access Token:</strong></p>
      <textarea style="width:100%;height:80px">${data.access_token || "não retornado"}</textarea>
      <p><strong>Refresh Token:</strong></p>
      <textarea style="width:100%;height:80px">${data.refresh_token || "não retornado"}</textarea>
      <p><strong>Expira em:</strong> ${data.expires_in} segundos</p>
      <p>Salve o Refresh Token na tabela <code>tokens_oauth</code> do Supabase, linha
      <code>id = olist_refresh_token_${empresa}</code>.</p>
      <pre>${JSON.stringify(data, null, 2)}</pre>
    `);
  } catch (e) {
    res.status(200).send(`<h2>Erro: ${e.message}</h2>`);
  }
};
