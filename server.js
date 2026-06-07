require('dotenv').config();
const express = require("express");
const cors    = require("cors");
const path    = require("path");

const app = express();

const ANA_ID   = process.env.ANA_ID;
const ANA_PASS = process.env.ANA_PASS;
const DOMINIO  = process.env.SITE_DOMINIO || "https://www.sjbmilgrau.com.br";
const PORT     = process.env.PORT || 3000;
const ANA_BASE = "https://www.ana.gov.br/hidrowebservice/EstacoesTelemetricas";

const DOMINIOS_PERMITIDOS = [
  DOMINIO,
  DOMINIO.replace("https://","https://www."),
  DOMINIO.replace("https://www.","https://"),
  "https://rio-tijucas.onrender.com"
];

app.use('/api', cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (DOMINIOS_PERMITIDOS.includes(origin)) return callback(null, true);
    callback(new Error("Domínio não autorizado: " + origin));
  }
}));

app.get("/widget", (req, res) => {
  const referer = req.headers.referer || "";
  const origem  = req.headers.origin  || "";
  const autorizado = DOMINIOS_PERMITIDOS.some(d =>
    referer.startsWith(d) || origem.startsWith(d)
  );
  if (!referer && !origem) return res.sendFile(path.join(__dirname, "widget.html"));
  if (!autorizado) {
    return res.status(403).send(`
      <html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#666">
        <p>Widget disponível apenas em sjbmilgrau.com.br</p>
      </body></html>
    `);
  }
  res.sendFile(path.join(__dirname, "widget.html"));
});

app.use(express.static(__dirname));

// ── Cache ──────────────────────────────────────────────
let dadosCache = { dados: null, expiraEm: 0 };

function cacheValido() {
  return dadosCache.dados !== null && Date.now() < dadosCache.expiraEm;
}

function dadosSaoValidos(json) {
  // Só aceita cache se tiver itens com Cota_Adotada numérica válida
  if (!json || !json.items || !Array.isArray(json.items) || json.items.length === 0) return false;
  const temCotaValida = json.items.some(item => {
    const cota = parseFloat(item.Cota_Adotada);
    return !isNaN(cota);
  });
  return temCotaValida;
}

// ── Token ──────────────────────────────────────────────
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
  tokenCache = { token, expiraEm: Date.now() + 20 * 60 * 1000 };
  console.log("✅ Token renovado:", new Date().toLocaleTimeString("pt-BR"));
  return token;
}

// ── Busca dados da ANA ─────────────────────────────────
async function buscarDadosANA(codigo) {
  const token = await getToken();
  const fetch = (await import("node-fetch")).default;
  const url = `${ANA_BASE}/HidroinfoanaSerieTelemetricaAdotada/v1?` +
    `C%C3%B3digo%20da%20Esta%C3%A7%C3%A3o=${codigo}` +
    `&Tipo%20Filtro%20Data=DATA_LEITURA` +
    `&Range%20Intervalo%20de%20busca=DIAS_2`;
  console.log("Chamando ANA:", new Date().toLocaleTimeString("pt-BR"));
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const txt = await r.text();
  console.log("Resposta ANA status:", r.status);
  if (!r.ok) {
    if (r.status === 401) {
      tokenCache = { token: null, expiraEm: 0 };
      console.warn("⚠️ Token expirado (401), cache limpo");
    }
    throw new Error(`ANA status ${r.status}`);
  }
  return JSON.parse(txt);
}

// ── Rota principal ─────────────────────────────────────
app.get("/api/dados/:codigo", async (req, res) => {
  const { codigo } = req.params;
  try {
    if (cacheValido()) {
      console.log("📦 Servindo do cache:", new Date().toLocaleTimeString("pt-BR"));
      return res.json(dadosCache.dados);
    }

    const json = await buscarDadosANA(codigo);

    // Só salva no cache se os dados forem válidos (com cota numérica)
    if (dadosSaoValidos(json)) {
      dadosCache = { dados: json, expiraEm: Date.now() + 15 * 60 * 1000 };
      console.log("💾 Cache atualizado com dados válidos:", new Date().toLocaleTimeString("pt-BR"));
    } else {
      console.warn("⚠️ Dados inválidos recebidos da ANA — cache NÃO atualizado");
    }

    res.json(json);
  } catch (err) {
    console.error("Erro:", err.message);
    // Se tiver cache válido com dados, serve ele em caso de erro
    if (dadosCache.dados && dadosSaoValidos(dadosCache.dados)) {
      console.warn("⚠️ Erro na ANA, servindo cache anterior válido");
      return res.json(dadosCache.dados);
    }
    res.status(500).json({ erro: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🌊 Widget Rio Tijucas na porta ${PORT}`);
  console.log(`   Domínio: ${DOMINIO}\n`);
});
