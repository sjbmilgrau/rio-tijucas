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

// Domínios permitidos (com e sem www)
const DOMINIOS_PERMITIDOS = [
  DOMINIO,
  DOMINIO.replace("https://","https://www."),
  DOMINIO.replace("https://www.","https://"),
  "https://rio-tijucas.onrender.com"
];

// CORS para a API
app.use('/api', cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (DOMINIOS_PERMITIDOS.includes(origin)) return callback(null, true);
    callback(new Error("Domínio não autorizado: " + origin));
  }
}));

// Proteção do widget.html — só carrega dentro do seu site
app.get("/widget", (req, res) => {
  const referer = req.headers.referer || "";
  const origem  = req.headers.origin  || "";
  const autorizado = DOMINIOS_PERMITIDOS.some(d =>
    referer.startsWith(d) || origem.startsWith(d)
  );
  if (!referer && !origem) {
    return res.sendFile(path.join(__dirname, "widget.html"));
  }
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
  // Cache de 20 minutos — mais seguro para evitar 401
  tokenCache = { token, expiraEm: Date.now() + 20 * 60 * 1000 };
  console.log("✅ Token renovado:", new Date().toLocaleTimeString("pt-BR"));
  return token;
}

app.get("/api/dados/:codigo", async (req, res) => {
  const { codigo } = req.params;
  try {
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
      // Se 401, limpa cache imediatamente para renovar token na próxima chamada
      if (r.status === 401) {
        tokenCache = { token: null, expiraEm: 0 };
        console.warn("⚠️ Token expirado (401), cache limpo — renovando na próxima chamada");
      }
      return res.status(r.status).send(txt);
    }
    res.json(JSON.parse(txt));
  } catch (err) {
    console.error("Erro:", err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🌊 Widget Rio Tijucas na porta ${PORT}`);
  console.log(`   Domínio: ${DOMINIO}\n`);
});
