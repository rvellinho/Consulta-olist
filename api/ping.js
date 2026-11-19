const { getAccessToken } = require("./_lib/olist-auth");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const empresa = String(req.query.empresa || "rampa").toLowerCase();

  try {
    await getAccessToken(empresa);
    return res.status(200).json({ ok: true, empresa, renovado: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ erro: e.message, empresa });
  }
};
