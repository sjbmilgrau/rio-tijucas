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
const ESTACAO  = "84095500";

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
let dadosCache = { dados: null, ultimaMedicao: null };

function filtrarItensValidos(items) {
  // Remove registros com Cota_Adotada null ou inválida
  return items.filter(item =>
    item.Cota_Adotada !== null &&
    item.Cota_Adotada !== undefined &&
    !isNaN(parseFloat(item.Cota_Adotada))
  );
}

function dadosSaoValidos(json) {
  if (!json || !json.items || !Array.isArray(json.items)) return false;
  const validos = filtrarItensValidos(json.items);
  return validos.length > 0;
}

function ultimaMedicaoCache(json) {
  const validos = filtrarItensValidos(json.items);
  const sorted = [...validos].sort((a,b) =>
    new Date(b.Data_Hora_Medicao) - new Date(a.Data_Hora_Medicao)
  );
  return sorted[0].Data_Hora_Medicao;
}

function temDadosNovos(json) {
  if (!dadosCache.ultimaMedicao) return true;
  return ultimaMedicaoCache(json) !== dadosCache.ultimaMedicao;
}

// Retorna JSON filtrado — apenas itens com Cota válida
function jsonFiltrado(json) {
  return {
    ...json,
    items: filtrarItensValidos(json.items)
  };
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
async function buscarDadosANA() {
  const token = await getToken();
  const fetch = (await import("node-fetch")).default;
  const url = `${ANA_BASE}/HidroinfoanaSerieTelemetricaAdotada/v1?` +
    `C%C3%B3digo%20da%20Esta%C3%A7%C3%A3o=${ESTACAO}` +
    `&Tipo%20Filtro%20Data=DATA_LEITURA` +
    `&Range%20Intervalo%20de%20busca=DIAS_2`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const txt = await r.text();
  if (!r.ok) {
    if (r.status === 401) { tokenCache = { token: null, expiraEm: 0 }; }
    throw new Error(`ANA status ${r.status}`);
  }
  return JSON.parse(txt);
}

// ── Agendador ──────────────────────────────────────────
const ALVOS = [7, 14, 21, 28, 35, 42, 49, 56];
let retryInterval = null;
let buscandoNovos = false;

async function tentarAtualizar(motivo) {
  console.log(`🔄 Buscando [${motivo}]:`, new Date().toLocaleTimeString("pt-BR"));
  try {
    const json = await buscarDadosANA();
    if (!dadosSaoValidos(json)) {
      console.warn("⚠️ Sem itens válidos (Cota null?), mantendo cache");
      return false;
    }
    if (!temDadosNovos(json)) {
      console.log("📭 Sem dados novos ainda...");
      return false;
    }
    // Salva apenas itens com Cota válida
    dadosCache = { dados: jsonFiltrado(json), ultimaMedicao: ultimaMedicaoCache(json) };
    console.log("💾 Cache atualizado! Última medição:", dadosCache.ultimaMedicao);
    return true;
  } catch (err) {
    console.error("❌ Erro:", err.message);
    return false;
  }
}

function pararRetry() {
  if (retryInterval) {
    clearInterval(retryInterval);
    retryInterval = null;
    buscandoNovos = false;
    console.log("✅ Retry encerrado — dados encontrados");
  }
}

function iniciarJanela(minAlvo) {
  if (buscandoNovos) pararRetry();
  buscandoNovos = true;
  const proxAlvo = ALVOS[(ALVOS.indexOf(minAlvo) + 1) % ALVOS.length];
  console.log(`⏰ Janela :${String(minAlvo).padStart(2,'0')} aberta — retry até :${String(proxAlvo).padStart(2,'0')}`);

  tentarAtualizar(`janela :${String(minAlvo).padStart(2,'0')}`).then(sucesso => {
    if (sucesso) { buscandoNovos = false; return; }
    retryInterval = setInterval(async () => {
      const ok = await tentarAtualizar("retry 1min");
      if (ok) pararRetry();
    }, 60 * 1000);
  });
}

function agendarLoop() {
  setInterval(() => {
    const min = new Date().getMinutes();
    const seg = new Date().getSeconds();
    if (ALVOS.includes(min) && seg < 30 && !buscandoNovos) {
      iniciarJanela(min);
    }
  }, 30 * 1000);
}

// ── Rota principal ─────────────────────────────────────
app.get("/api/dados/:codigo", async (req, res) => {
  if (dadosCache.dados) {
    console.log("📦 Cache:", new Date().toLocaleTimeString("pt-BR"));
    return res.json(dadosCache.dados);
  }
  try {
    console.log("🆕 Sem cache — buscando pela primeira vez");
    const json = await buscarDadosANA();
    if (dadosSaoValidos(json)) {
      dadosCache = { dados: jsonFiltrado(json), ultimaMedicao: ultimaMedicaoCache(json) };
      console.log("💾 Cache inicial:", dadosCache.ultimaMedicao);
    }
    return res.json(dadosCache.dados || json);
  } catch (err) {
    console.error("Erro:", err.message);
    return res.status(500).json({ erro: err.message });
  }
});

// ── Iniciar ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🌊 Widget Rio Tijucas na porta ${PORT}`);
  console.log(`   Domínio: ${DOMINIO}\n`);

  tentarAtualizar("inicialização").then(() => {
    agendarLoop();
    console.log("⏰ Agendador: :07, :14, :21, :28, :35, :42, :49, :56");
    console.log("   Filtrando itens com Cota_Adotada null automaticamente\n");
  });
});
