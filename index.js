// MEU SECRETÁRIO — Servidor de integração WhatsApp + Claude AI
// Hospede este arquivo no Railway gratuitamente

const express = require("express");
const app = express();
app.use(express.json());

// =============================================
// ⚙️ CONFIGURE AQUI SUAS CHAVES
// =============================================
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || "SUA_CHAVE_ANTHROPIC";
const OPENAI_KEY    = process.env.OPENAI_KEY    || "SUA_CHAVE_OPENAI";
const EVOLUTION_URL = process.env.EVOLUTION_URL  || "https://SUA-EVOLUTION.up.railway.app";
const EVOLUTION_KEY = process.env.EVOLUTION_KEY  || "SUA_CHAVE_EVOLUTION";
const INSTANCE      = process.env.INSTANCE_NAME  || "meu-secretario";
// =============================================

// Memória simples por usuário (reinicia se o servidor reiniciar)
const userState = {};

const SYSTEM_PROMPT = `Você é o "Meu Secretário", assistente pessoal inteligente e amigável em português brasileiro informal.

Você gerencia:
📅 COMPROMISSOS — detecte e registre compromissos, reuniões, consultas
💰 FINANÇAS — registre gastos, receitas, organize por categorias do usuário
📂 CATEGORIAS — o usuário cria as próprias categorias de gastos

ESTADO ATUAL DO USUÁRIO:
{STATE}

Seja breve, use emojis moderadamente e sempre confirme o que foi registrado.
Quando registrar algo, inclua ao final:
<action>{"type":"add_expense","amount":50,"category":"mercado","description":"compras"}</action>
<action>{"type":"add_income","amount":3000,"description":"salário"}</action>
<action>{"type":"add_appointment","description":"dentista","date":"sexta","time":"10:00"}</action>
<action>{"type":"add_category","name":"alimentação"}</action>`;

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

function parseActions(text) {
  const actions = [];
  const regex = /<action>(.*?)<\/action>/gs;
  let m;
  while ((m = regex.exec(text)) !== null) {
    try { actions.push(JSON.parse(m[1])); } catch {}
  }
  return actions;
}

function cleanText(text) {
  return text.replace(/<action>.*?<\/action>/gs, "").trim();
}

function applyActions(state, actions) {
  actions.forEach(a => {
    if (a.type === "add_expense")     state.expenses.push({ ...a, id: Date.now() });
    if (a.type === "add_income")      state.incomes.push({ ...a, id: Date.now() });
    if (a.type === "add_appointment") state.appointments.push({ ...a, id: Date.now() });
    if (a.type === "add_category" && !state.categories.includes(a.name)) state.categories.push(a.name);
    if (a.type === "add_debt")        state.debts.push({ ...a, id: Date.now() });
  });
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
    debts: state.debts.slice(-5),
    recentExpenses: state.expenses.slice(-5),
  });
}

async function sendWhatsApp(phone, text) {
  await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": EVOLUTION_KEY },
    body: JSON.stringify({ number: phone, text })
  });
}

async function transcribeAudio(audioUrl) {
  // Baixa o áudio da Evolution API
  const audioRes = await fetch(audioUrl);
  const audioBlob = await audioRes.blob();
  const FormData = require("form-data");
  const fd = new FormData();
  fd.append("file", audioBlob, { filename: "audio.ogg", contentType: "audio/ogg" });
  fd.append("model", "whisper-1");
  fd.append("language", "pt");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, ...fd.getHeaders() },
    body: fd
  });
  const data = await res.json();
  return data.text || null;
}

async function askClaude(phone, userMessage) {
  const state = getState(phone);
  const systemPrompt = SYSTEM_PROMPT.replace("{STATE}", buildStateStr(state));
  state.history.push({ role: "user", content: userMessage });
  if (state.history.length > 20) state.history = state.history.slice(-20);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: systemPrompt,
      messages: state.history
    })
  });

  const data = await res.json();
  const raw = data.content?.[0]?.text || "Desculpe, não consegui processar.";
  const actions = parseActions(raw);
  const clean = cleanText(raw);
  applyActions(state, actions);
  state.history.push({ role: "assistant", content: clean });
  return clean;
}

// =============================================
// WEBHOOK — recebe mensagens do WhatsApp
// =============================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    const msg = body?.data?.message;
    const phone = body?.data?.key?.remoteJid?.replace("@s.whatsapp.net", "");
    const fromMe = body?.data?.key?.fromMe;
    if (!msg || !phone || fromMe) return;

    let userText = null;

    // Mensagem de texto
    if (msg.conversation || msg.extendedTextMessage?.text) {
      userText = msg.conversation || msg.extendedTextMessage.text;
    }

    // Mensagem de áudio
    if (msg.audioMessage && OPENAI_KEY !== "SUA_CHAVE_OPENAI") {
      const mediaUrl = body?.data?.message?.audioMessage?.url;
      if (mediaUrl) {
        await sendWhatsApp(phone, "🎙️ Transcrevendo seu áudio...");
        userText = await transcribeAudio(mediaUrl);
        if (!userText) {
          await sendWhatsApp(phone, "❌ Não consegui entender o áudio. Pode repetir?");
          return;
        }
        await sendWhatsApp(phone, `📝 _Entendi: "${userText}"_`);
      }
    }

    if (!userText) return;

    const reply = await askClaude(phone, userText);
    await sendWhatsApp(phone, reply);

  } catch (err) {
    console.error("Erro no webhook:", err);
  }
});

// Notificações proativas (11h, 16h, 20h30)
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
app.listen(process.env.PORT || 3000, () => console.log("✅ Servidor rodando!"));
