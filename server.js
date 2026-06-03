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

// Sempre busca token novo — a ANA expira tokens imprevisívelmente
async function getToken() {
  const fetch = (await import("node-fetch")).default;
  const res = await fetch(`${ANA_BASE}/OAUth/v1`, {
    headers: { Identificador: ANA_ID, Senha: ANA_PASS }
  });
  if (!res.ok) throw new Error(`Erro auth ANA: ${res.status}`);
  const json  = await res.json();
  const token = json?.items?.tokenautenticacao;
  if (!token) throw new Error("Token não retornado");
  console.log("✅ Token obtido:", new Date().toLocaleTimeString("pt-BR"));
  return token;
}

app.get("/api/estacoes", (_req, res) => res.json({ ok: true }));

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
    if (!r.ok) return res.status(r.status).send(txt);
    res.json(JSON.parse(txt));
  } catch (err) {
    console.error("Erro:", err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── KEEP-ALIVE: evita que o Render durma + mantém dados frescos ──
setInterval(async () => {
  try {
    const fetch = (await import("node-fetch")).default;
    await fetch(`http://localhost:${PORT}/api/dados/84095500`);
    console.log("💓 Keep-alive:", new Date().toLocaleTimeString("pt-BR"));
  } catch(e) {
    console.warn("⚠️ Keep-alive erro:", e.message);
  }
}, 14 * 60 * 1000); // a cada 14 minutos

app.listen(PORT, () => {
  console.log(`\n🌊 Widget Rio Tijucas na porta ${PORT}`);
  console.log(`   Domínio: ${DOMINIO}\n`);
});
