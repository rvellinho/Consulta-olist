const https = require("https");

function httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "POST", headers }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, text: d }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  const code = req.query.code;
  const error = req.query.error;

  if (error) return res.status(200).send(`<h2>Erro: ${error}</h2>`);

  if (!code) return res.status(200).send(`<h2>Sem code</h2><pre>${JSON.stringify(req.query)}</pre>`);

  try {
    const body = "grant_type=authorization_code"
      + "&client_id=tiny-api-4dc8416507068cfd300c4da5b397ed108341e41c-1780520369"
      + "&client_secret=HuuZ5cNak5fDkodDSNrRXe52jAPtraC1"
      + "&code=" + encodeURIComponent(code)
      + "&redirect_uri=https%3A%2F%2Fconsulta-olist.vercel.app%2Fapi%2Fcallback";

    const r = await httpsPost(
      "accounts.tiny.com.br",
      "/realms/tiny/protocol/openid-connect/token",
      body,
      { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
    );

    const data = JSON.parse(r.text);

    res.status(200).send(`
      <h2>✅ Tokens obtidos!</h2>
      <p><strong>Access Token:</strong></p>
      <textarea style="width:100%;height:80px">${data.access_token || "não retornado"}</textarea>
      <p><strong>Refresh Token:</strong></p>
      <textarea style="width:100%;height:80px">${data.refresh_token || "não retornado"}</textarea>
      <p><strong>Expira em:</strong> ${data.expires_in} segundos</p>
      <pre>${JSON.stringify(data, null, 2)}</pre>
    `);
  } catch (e) {
    res.status(200).send(`<h2>Erro: ${e.message}</h2>`);
  }
};
