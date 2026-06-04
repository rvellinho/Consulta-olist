module.exports = async (req, res) => {
  const code = req.query.code;
  const error = req.query.error;
  
  if (error) {
    return res.status(200).send(`<h2>Erro: ${error}</h2>`);
  }
  
  if (!code) {
    return res.status(200).send(`<h2>Nenhum code recebido</h2><pre>${JSON.stringify(req.query)}</pre>`);
  }
  
  res.status(200).send(`
    <h2>✅ Code recebido!</h2>
    <p>Copie o code abaixo e envie para o Claude:</p>
    <textarea style="width:100%;height:100px">${code}</textarea>
  `);
};
