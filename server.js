/**
 * ============================================================
 *  BACKEND — Nível do Rio Tijucas (ANA HidroWebService)
 *  sjbmilgrau.com.br
 *
 *  Instalar: npm install express node-fetch cors
 *  Rodar:    node server.js
 * ============================================================
 */

require('dotenv').config();
const express = require("express");
const cors    = require("cors");

const app = express();

const ANA_ID     = process.env.ANA_ID;
const ANA_PASS   = process.env.ANA_PASS;
const DOMINIO    = process.env.SITE_DOMINIO || "https://www.sjbmilgrau.com.br";
const PORT       = process.env.PORT || 3000;
const ANA_BASE   = "https://www.ana.gov.br/hidrowebservice/EstacoesTelemetricas";

const ESTACOES = [
  { codigo: "83827000", nome: "Tijucas (Cidade)",  municipio: "Tijucas/SC"       },
  { codigo: "83813000", nome: "Nova Trento",        municipio: "Nova Trento/SC"   },
  { codigo: "83838000", nome: "Major Gercino",      municipio: "Major Gercino/SC" },
  { codigo: "83822000", nome: "Canelinha",           municipio: "Canelinha/SC"    },
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const allowed = [DOMINIO, DOMINIO.replace("https://","https://www."), DOMINIO.replace("https://www.","https://")];
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
  if (!res.ok) throw new Error(`Erro ao autenticar na ANA: ${res.status}`);
  const json  = await res.json();
  const token = json?.items?.tokenautenticacao;
  if (!token) throw new Error("Token não retornado pela ANA");
  tokenCache = { token, expiraEm: Date.now() + 55 * 60 * 1000 };
  console.log("✅ Token ANA renovado às", new Date().toLocaleTimeString("pt-BR"));
  return token;
}

app.get("/api/estacoes", (_req, res) => res.json(ESTACOES));

app.get("/api/dados/:codigo", async (req, res) => {
  const { codigo } = req.params;
  const dias = Math.min(parseInt(req.query.dias || "2"), 30);
  try {
    const token = await getToken();
    const fetch = (await import("node-fetch")).default;
    const url =
      `${ANA_BASE}/HidroinfoanaSerieTelemetricaAdotada/v1` +
      `?CodigoDaEstacao=${codigo}` +
      `&TipoFiltroData=DATA_LEITURA` +
      `&RangeIntervaloDeBusca=DIAS_${dias}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return res.status(r.status).json({ erro: await r.text() });
    res.json(await r.json());
  } catch (err) {
    console.error("Erro /api/dados:", err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🌊 Widget Rio Tijucas rodando na porta ${PORT}`);
  console.log(`   Domínio permitido: ${DOMINIO}\n`);
});
