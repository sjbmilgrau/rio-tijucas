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

function dadosSaoValidos(json) {
  if (!json || !json.items || !Array.isArray(json.items) || json.items.length === 0) return false;
  return json.items.some(item => !isNaN(parseFloat(item.Cota_Adotada)));
}

function ultimaMedicaoCache(json) {
  // Pega o Data_Hora_Medicao do último item
  const sorted = [...json.items].sort((a,b) =>
    new Date(b.Data_Hora_Medicao) - new Date(a.Data_Hora_Medicao)
  );
  return sorted[0].Data_Hora_Medicao;
}

function temDadosNovos(json) {
  if (!dadosCache.ultimaMedicao) return true; // sem cache anterior = sempre novo
  const novaMedicao = ultimaMedicaoCache(json);
  return novaMedicao !== dadosCache.ultimaMedicao;
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

// ── Agendador principal ────────────────────────────────
// Lógica:
// 1. Nos minutos :07, :22, :37, :52 → dispara busca
// 2. Se não houver dados novos → tenta novamente no próximo minuto
// 3. Quando encontrar dados novos → atualiza cache e para de tentar
// 4. No próximo :07 (ou :22, :37, :52) → reinicia o processo

let buscandoNovos = false;
let retryInterval = null;

async function tentarAtualizar(motivo) {
  console.log(`🔄 Buscando dados [${motivo}]:`, new Date().toLocaleTimeString("pt-BR"));
  try {
    const json = await buscarDadosANA();
    if (!dadosSaoValidos(json)) {
      console.warn("⚠️ Dados inválidos da ANA, mantendo cache anterior");
      return false;
    }
    if (!temDadosNovos(json)) {
      console.log("📭 Sem dados novos ainda, tentará no próximo minuto");
      return false;
    }
    // Dados novos encontrados!
    dadosCache = { dados: json, ultimaMedicao: ultimaMedicaoCache(json) };
    console.log("💾 Cache atualizado! Última medição:", dadosCache.ultimaMedicao);
    return true;
  } catch (err) {
    console.error("❌ Erro ao buscar:", err.message);
    return false;
  }
}

function pararRetry() {
  if (retryInterval) {
    clearInterval(retryInterval);
    retryInterval = null;
    buscandoNovos = false;
    console.log("✅ Dados novos encontrados — retry encerrado");
  }
}

function iniciarBuscaComRetry() {
  if (buscandoNovos) return; // já está em retry
  buscandoNovos = true;

  // Tenta imediatamente
  tentarAtualizar("agendado").then(sucesso => {
    if (sucesso) { buscandoNovos = false; return; }
    // Se não achou, tenta a cada 1 minuto
    console.log("🔁 Iniciando retry a cada 1 minuto...");
    retryInterval = setInterval(async () => {
      const sucesso = await tentarAtualizar("retry 1min");
      if (sucesso) pararRetry();
    }, 60 * 1000);
  });
}

function agendarLoop() {
  // Verifica a cada 30 segundos se chegou no horário :07, :22, :37, :52
  setInterval(() => {
    const min = new Date().getMinutes();
    const seg = new Date().getSeconds();
    // Dispara nos horários alvo com tolerância de 30 segundos
    if ([7, 22, 37, 52].includes(min) && seg < 30 && !buscandoNovos) {
      console.log(`⏰ Horário alvo atingido (:${String(min).padStart(2,'0')}) — iniciando busca`);
      iniciarBuscaComRetry();
    }
  }, 30 * 1000); // verifica a cada 30 segundos
}

// ── Rota principal ─────────────────────────────────────
app.get("/api/dados/:codigo", async (req, res) => {
  // Se tiver cache, serve imediatamente
  if (dadosCache.dados) {
    console.log("📦 Servindo do cache:", new Date().toLocaleTimeString("pt-BR"));
    return res.json(dadosCache.dados);
  }
  // Sem cache nenhum — busca agora (primeira vez)
  try {
    console.log("🆕 Sem cache — buscando pela primeira vez");
    const json = await buscarDadosANA();
    if (dadosSaoValidos(json)) {
      dadosCache = { dados: json, ultimaMedicao: ultimaMedicaoCache(json) };
      console.log("💾 Cache inicial criado:", dadosCache.ultimaMedicao);
    }
    return res.json(json);
  } catch (err) {
    console.error("Erro:", err.message);
    return res.status(500).json({ erro: err.message });
  }
});

// ── Iniciar ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🌊 Widget Rio Tijucas na porta ${PORT}`);
  console.log(`   Domínio: ${DOMINIO}\n`);

  // Busca inicial ao iniciar servidor
  tentarAtualizar("inicialização").then(() => {
    // Inicia o loop de agendamento
    agendarLoop();
    console.log("⏰ Agendador iniciado — buscará nos minutos :07, :22, :37, :52");
  });
});
