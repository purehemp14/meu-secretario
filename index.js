const express = require("express");
const https = require("https");
const http = require("http");
const app = express();
app.use(express.json());

// =============================================
// ⚙️ CONFIGURE AQUI SUAS CHAVES
// =============================================
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || "";
const OPENAI_KEY    = process.env.OPENAI_KEY    || "";
const EVOLUTION_URL = process.env.EVOLUTION_URL  || "";
const EVOLUTION_KEY = process.env.EVOLUTION_KEY  || "";
const INSTANCE      = process.env.INSTANCE_NAME  || "meu-secretario";
// =============================================

const userState = {};

const SYSTEM_PROMPT = `Você é o "Meu Secretário", assistente pessoal inteligente e amigável em português brasileiro informal.

Você gerencia:
📅 COMPROMISSOS — detecte e registre compromissos, reuniões, consultas
💰 FINANÇAS — registre gastos, receitas, organize por categorias do usuário
📂 CATEGORIAS — o usuário cria as próprias categorias de gastos

ESTADO ATUAL DO USUÁRIO:
{STATE}

Seja breve, use emojis moderadamente e sempre confirme o que foi registrado.`;

function getState(phone) {
  if (!userState[phone]) {
    userState[phone] = {
      expenses: [], incomes: [], appointments: [],
      categories: ["Alimentação","Transporte","Saúde","Lazer","Moradia"],
      debts: [], history: []
    };
  }
  return userState[phone];
}

function buildStateStr(state) {
  const totalExp = state.expenses.reduce((a, e) => a + (e.amount || 0), 0);
  const totalInc = state.incomes.reduce((a, e) => a + (e.amount || 0), 0);
  return JSON.stringify({
    categories: state.categories,
    totalExpenses: totalExp,
    totalIncome: totalInc,
    balance: totalInc - totalExp,
    appointments: state.appointments.slice(-5),
    recentExpenses: state.expenses.slice(-5),
  });
}

// Função HTTP simples sem dependências externas
function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const lib = urlObj.protocol === "https:" ? https : http;
    const req = lib.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || "GET",
      headers: options.headers || {},
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function sendWhatsApp(phone, text) {
  try {
    const url = `${EVOLUTION_URL}/message/sendText/${INSTANCE}`;
    await request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": EVOLUTION_KEY }
    }, { number: phone, text });
    console.log("✅ Mensagem enviada para:", phone);
  } catch (e) {
    console.error("❌ Erro ao enviar mensagem:", e.message);
  }
}

async function askClaude(phone, userMessage) {
  const state = getState(phone);
  const systemPrompt = SYSTEM_PROMPT.replace("{STATE}", buildStateStr(state));
  state.history.push({ role: "user", content: userMessage });
  if (state.history.length > 20) state.history = state.history.slice(-20);

  const data = await request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    }
  }, {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    system: systemPrompt,
    messages: state.history
  });

  const reply = data.content?.[0]?.text || "Desculpe, não consegui processar.";
  state.history.push({ role: "assistant", content: reply });
  return reply;
}

// =============================================
// WEBHOOK
// =============================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  console.log("📨 Webhook recebido:", JSON.stringify(req.body).slice(0, 300));
  try {
    const body = req.body;
    const msg = body?.data?.message;
    const phone = body?.data?.key?.remoteJid?.replace("@s.whatsapp.net", "");
    const fromMe = body?.data?.key?.fromMe;

    console.log("📱 Phone:", phone, "| FromMe:", fromMe, "| Msg:", !!msg);

    if (!msg || !phone || fromMe) {
      console.log("⚠️ Ignorado");
      return;
    }

    const userText = msg.conversation || msg.extendedTextMessage?.text;
    if (!userText) {
      console.log("⚠️ Sem texto na mensagem");
      return;
    }

    console.log("💬 Mensagem:", userText);
    const reply = await askClaude(phone, userText);
    console.log("🤖 Resposta:", reply.slice(0, 100));
    await sendWhatsApp(phone, reply);

  } catch (err) {
    console.error("❌ Erro no webhook:", err.message);
  }
});

// Notificações proativas
const NOTIFICATIONS = [
  { hour: 11, min: 0,  msg: "Bom dia! 😊 Há algum compromisso ou gasto para anotar esta manhã?" },
  { hour: 16, min: 0,  msg: "Boa tarde! 📋 Aconteceu algo hoje que devo registrar para você?" },
  { hour: 20, min: 30, msg: "Boa noite! 🌙 Vamos fechar o dia? Tem algum gasto ou compromisso de amanhã para anotar?" },
];

setInterval(async () => {
  const now = new Date();
  for (const n of NOTIFICATIONS) {
    if (now.getHours() === n.hour && now.getMinutes() === n.min) {
      for (const phone of Object.keys(userState)) {
        try { await sendWhatsApp(phone, n.msg); } catch {}
      }
    }
  }
}, 60000);

app.get("/", (_, res) => res.send("🤖 Meu Secretário online!"));
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ Servidor rodando na porta ${PORT}!`));
