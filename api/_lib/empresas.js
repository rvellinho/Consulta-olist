// Credenciais Olist por empresa. Rampa usa as env vars originais (sem sufixo,
// pra não quebrar produção); TF usa as mesmas env vars com sufixo _TF.
const EMPRESAS = {
  rampa: {
    tokenV2: process.env.OLIST_TOKEN,
    clientId: process.env.OLIST_CLIENT_ID,
    clientSecret: process.env.OLIST_CLIENT_SECRET,
    tokenOauthId: "olist_refresh_token_rampa",
  },
  tf: {
    tokenV2: process.env.OLIST_TOKEN_TF,
    clientId: process.env.OLIST_CLIENT_ID_TF,
    clientSecret: process.env.OLIST_CLIENT_SECRET_TF,
    tokenOauthId: "olist_refresh_token_tf",
  },
};

function getConfigEmpresa(empresa) {
  const chave = String(empresa || "rampa").toLowerCase();
  const config = EMPRESAS[chave];
  if (!config) throw new Error(`Empresa "${chave}" não existe`);
  if (!config.tokenV2 || !config.clientId || !config.clientSecret) {
    throw new Error(`Empresa "${chave}" ainda não está configurada (faltam variáveis de ambiente da Olist)`);
  }
  return config;
}

module.exports = { EMPRESAS, getConfigEmpresa };
