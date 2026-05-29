require('dotenv').config();
const express = require("express");
const cors    = require("cors");

const app = express();

const ANA_ID   = process.env.ANA_ID;
const ANA_PASS = process.env.ANA_PASS;
const DOMINIO  = process.env.SITE_DOMINIO || "https://www.sjbmilgrau.com.br";
const PORT     = process.env.PORT || 3000;
const ANA_BASE = "https://www.ana.gov.br/hidrowebservice/EstacoesTelemetricas";

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const allowed = [
      DOMINIO,
      DOMINIO.replace("https://","https://www."),
      DOMINIO.replace("https://www.","https://")
    ];
    if (allowed.includes(origin)) return callback(null, true);
    callback(new Error("Domínio não autorizado: " + origin));
  }
}));

app.use(express.static(__dirname));

let tokenCache = { token: null, expiraEm: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiraEm) return tokenCache.token;
  const fetch = (await import("node-fetch")).default;
  const res = await fetch(`${ANA_BASE}/OAUth/v1`, {
    headers: { Identificador: ANA_ID, Senha: ANA_PASS }
  });
  if (!res.ok) throw new Error(`Erro auth ANA: ${res.status}`);
  const json  = await res.json();
  const token = json?.items?.tokenautenticacao;
  if (!token) throw new Error("Token não retornado");
  tokenCache = { token, expiraEm: Date.now() + 55 * 60 * 1000 };
  console.log("✅ Token renovado:", new Date().toLocaleTimeString("pt-BR"));
  return token;
}

// Rota de diagnóstico — busca estações do Rio Tijucas para achar o código certo
app.get("/api/diagnostico", async (req, res) => {
  try {
    const token = await getToken();
    const fetch = (await import("node-fetch")).default;

    // Busca inventário de estações pelo nome do rio
    const url = `${ANA_BASE}/HidroInventarioEstacoes/v1?NomeRio=Tijucas&UF=SC`;
    console.log("Buscando estações:", url);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const txt = await r.text();
    console.log("Status:", r.status, txt.slice(0,500));
    res.send(`<pre>Status: ${r.status}\n\n${txt}</pre>`);
  } catch (err) {
    res.status(500).send("Erro: " + err.message);
  }
});

app.get("/api/dados/:codigo", async (req, res) => {
  const { codigo } = req.params;
  try {
    const token = await getToken();
    const fetch = (await import("node-fetch")).default;

    // Testa diferentes formatos de intervalo
    const intervalo = req.query.intervalo || "DIAS_2";
    const url =
      `${ANA_BASE}/HidroinfoanaSerieTelemetricaAdotada/v1` +
      `?CodigoDaEstacao=${codigo}` +
      `&TipoFiltroData=DATA_LEITURA` +
      `&RangeIntervaloDeBusca=${intervalo}`;

    console.log("Chamando ANA:", url);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const txt = await r.text();
    console.log("Resposta ANA status:", r.status, txt.slice(0,300));
    if (!r.ok) return res.status(r.status).send(txt);
    res.json(JSON.parse(txt));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🌊 Widget Rio Tijucas na porta ${PORT}`);
  console.log(`   Domínio: ${DOMINIO}\n`);
});
