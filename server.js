require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'prototype.db');

// ── DB helper ─────────────────────────────────────────────────────────────────
function getDb() {
  return new DatabaseSync(DB_PATH);
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new FileStore({
    path: path.join(__dirname, '.sessions'),
    ttl: 28800, // 8 horas em segundos
    retries: 1,
  }),
  secret: process.env.SECRET_KEY || 'sales-ai-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));

// ── WhatsApp Webhook & API ────────────────────────────────────────────────────
const WA_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'sales-ai-webhook-token';
const WA_API_VERSION = 'v19.0'; // ou v25.0 dependendo da config

async function sendWhatsAppMessage(contactPhone, content, dbRef = null) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  
  if (!phoneId || !token) {
    console.warn("WhatsApp API não configurada. Simulando envio para", contactPhone);
    return true; // Simulação para quando não há chave (ex: devs locais)
  }

  // Verifica se há janela aberta no BD para este contato (24h rule)
  let windowOpen = false;
  if (dbRef && dbRef.type === 'contact') {
    const db = getDb();
    const c = db.prepare('SELECT last_wa_interaction FROM contacts WHERE id = ?').get(dbRef.id);
    if (c && c.last_wa_interaction) {
      const lastInt = new Date(c.last_wa_interaction);
      const diffHrs = (new Date() - lastInt) / (1000 * 60 * 60);
      if (diffHrs < 24) windowOpen = true;
    }
  }

  // Se a janela estiver FECHADA, nós NÃO enviamos automaticamente! 
  // Na nossa arquitetura, envios fora da janela caem na "Aprovação Humana" no painel.
  if (!windowOpen && dbRef && !dbRef.forceTemplate) {
    console.log(`Janela de 24h fechada para ${contactPhone}. Mensagem retida para aprovação humana (Template necessário).`);
    return false; // Retorna falso para a rota chamadora mudar o status para 'pending'
  }

  // Se a janela está aberta, manda mensagem de texto livre:
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: contactPhone,
    type: 'text',
    text: { preview_url: false, body: content }
  };

  // Se 'forceTemplate' estiver ativado (pelo Humano aprovando no painel), montamos o envio de Template.
  if (dbRef && dbRef.forceTemplate) {
    payload.type = 'template';
    delete payload.text;
    const isHelloWorld = (dbRef.templateName || 'hello_world') === 'hello_world';
    payload.template = {
      name: dbRef.templateName || 'hello_world',
      language: { code: isHelloWorld ? 'en_US' : 'pt_BR' }
    };
    if (!isHelloWorld) {
      payload.template.components = [
        {
          type: "body",
          parameters: [
            { type: "text", text: content } // Passando a msg gerada pela IA como variável do template
          ]
        }
      ];
    }
  }

  try {
    const url = `https://graph.facebook.com/${WA_API_VERSION}/${phoneId}/messages`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const result = await resp.json();
    if (!resp.ok) console.error("Erro no envio WhatsApp:", result);
    return resp.ok;
  } catch (e) {
    console.error("Exceção enviando WhatsApp:", e);
    return false;
  }
}

// ── Helpers de validação e formatação ────────────────────────────────────────
function isValidEmailServer(email) {
  if (!email || email.trim() === '') return true; // campo opcional
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email.trim());
}

function normalizePhone(phone) {
  if (!phone || !phone.trim()) return '';
  const digits = phone.replace(/\D/g, '');
  if (!digits || digits.length < 8) return phone.trim();
  if (digits.length === 11 && !digits.startsWith('55')) return `+55${digits}`;
  if (digits.length === 13 && digits.startsWith('55'))  return `+${digits}`;
  if (digits.length === 12 && digits.startsWith('55'))  return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15)        return `+${digits}`;
  return phone.trim();
}

// ── Helper: adiciona coluna apenas se não existir ─────────────────────────────
function addColumnIfNotExists(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// ── Init DB ───────────────────────────────────────────────────────────────────
function initDb() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL UNIQUE,
      password   TEXT NOT NULL,
      name       TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS leads (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT    NOT NULL,
      company          TEXT    NOT NULL,
      role             TEXT    NOT NULL DEFAULT 'other',
      email            TEXT    DEFAULT '',
      linkedin         TEXT    DEFAULT '',
      whatsapp         TEXT    DEFAULT '',
      sector           TEXT    DEFAULT '',
      status           TEXT    DEFAULT 'new',
      interest_score   INTEGER DEFAULT 0,
      research_hook    TEXT,
      research_context TEXT,
      opted_out        INTEGER DEFAULT 0,
      created_at       TEXT    DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS companies (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT    NOT NULL UNIQUE,
      sector           TEXT    DEFAULT '',
      status           TEXT    DEFAULT 'new',
      interest_score   INTEGER DEFAULT 0,
      research_hook    TEXT,
      research_context TEXT,
      opted_out        INTEGER DEFAULT 0,
      created_at       TEXT    DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id   INTEGER NOT NULL,
      name         TEXT    NOT NULL,
      role         TEXT    DEFAULT 'other',
      email        TEXT    DEFAULT '',
      linkedin     TEXT    DEFAULT '',
      whatsapp         TEXT    DEFAULT '',
      is_primary   INTEGER DEFAULT 0,
      opted_out    INTEGER DEFAULT 0,
      created_at   TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS opportunities (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      name       TEXT NOT NULL,
      stage      TEXT DEFAULT 'prospecting',
      value      REAL DEFAULT 0,
      notes      TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id          INTEGER,
      channel          TEXT    NOT NULL,
      day              INTEGER NOT NULL,
      msg_type         TEXT,
      content          TEXT,
      ai_original      TEXT,
      human_correction TEXT,
      score            INTEGER,
      status           TEXT    DEFAULT 'pending',
      approved         INTEGER DEFAULT 0,
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );
    CREATE TABLE IF NOT EXISTS documents (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS golden_cases (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL,
      context    TEXT DEFAULT '',
      content    TEXT NOT NULL,
      score      INTEGER DEFAULT 5,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sentiment_logs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id        INTEGER,
      response_text  TEXT,
      sentiment      TEXT,
      reasoning      TEXT,
      interest_score INTEGER,
      created_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS consent_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id    INTEGER,
      action     TEXT,
      details    TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS schedule_slots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      date_time    TEXT NOT NULL,
      duration_min INTEGER DEFAULT 15,
      booked       INTEGER DEFAULT 0,
      lead_id      INTEGER,
      meeting_link TEXT DEFAULT '',
      created_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_email    ON contacts(email);
    CREATE INDEX IF NOT EXISTS idx_contacts_name     ON contacts(name);
  `);

  // Adicionar colunas company/contact nas tabelas existentes (antes de criar índices dependentes)
  addColumnIfNotExists(db, 'messages', 'contact_id', 'INTEGER REFERENCES contacts(id)');
  addColumnIfNotExists(db, 'messages', 'company_id', 'INTEGER REFERENCES companies(id)');
  addColumnIfNotExists(db, 'sentiment_logs', 'contact_id', 'INTEGER REFERENCES contacts(id)');
  addColumnIfNotExists(db, 'sentiment_logs', 'company_id', 'INTEGER REFERENCES companies(id)');
  addColumnIfNotExists(db, 'consent_logs', 'company_id', 'INTEGER REFERENCES companies(id)');
  addColumnIfNotExists(db, 'consent_logs', 'contact_id', 'INTEGER REFERENCES contacts(id)');
  addColumnIfNotExists(db, 'schedule_slots', 'company_id', 'INTEGER REFERENCES companies(id)');
  addColumnIfNotExists(db, 'schedule_slots', 'contact_id', 'INTEGER REFERENCES contacts(id)');

  // Colunas faltantes na tabela companies (migração de schema antigo)
  addColumnIfNotExists(db, 'companies', 'status',          "TEXT DEFAULT 'new'");
  addColumnIfNotExists(db, 'companies', 'interest_score',  "INTEGER DEFAULT 0");
  addColumnIfNotExists(db, 'companies', 'research_hook',   "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'companies', 'research_context',"TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'companies', 'opted_out',       "INTEGER DEFAULT 0");

  // WhatsApp API / Janela de 24h
  addColumnIfNotExists(db, 'leads', 'last_wa_interaction', "TEXT");
  addColumnIfNotExists(db, 'leads', 'wa_opt_out', "INTEGER DEFAULT 0");
  addColumnIfNotExists(db, 'contacts', 'last_wa_interaction', "TEXT");
  addColumnIfNotExists(db, 'contacts', 'wa_opt_out', "INTEGER DEFAULT 0");
  addColumnIfNotExists(db, 'messages', 'is_template', "INTEGER DEFAULT 0");
  addColumnIfNotExists(db, 'messages', 'template_name', "TEXT");

  // Criar índices que dependem de colunas adicionadas por migração
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_contacts_company  ON contacts(company_id);
    CREATE INDEX IF NOT EXISTS idx_messages_company  ON messages(company_id);
    CREATE INDEX IF NOT EXISTS idx_messages_contact  ON messages(contact_id);
    CREATE INDEX IF NOT EXISTS idx_sentiment_company ON sentiment_logs(company_id);
    CREATE INDEX IF NOT EXISTS idx_consent_company   ON consent_logs(company_id);
    CREATE INDEX IF NOT EXISTS idx_opps_company      ON opportunities(company_id);
    CREATE INDEX IF NOT EXISTS idx_companies_status  ON companies(status);
  `);
  addColumnIfNotExists(db, 'companies', 'research_history', "TEXT DEFAULT '[]'");
  addColumnIfNotExists(db, 'companies', 'sequence_history', "TEXT DEFAULT '[]'");

  // Colunas de motivo de perda em oportunidades
  addColumnIfNotExists(db, 'opportunities', 'lost_reason',     "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'opportunities', 'lost_competitor', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'opportunities', 'lost_notes',      "TEXT DEFAULT ''");

  // Colunas de enriquecimento de contatos
  addColumnIfNotExists(db, 'contacts', 'enrich_status', "TEXT DEFAULT 'pending'");
  addColumnIfNotExists(db, 'contacts', 'enrich_source', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'contacts', 'enrich_at',     "TEXT DEFAULT ''");

  // Seed usuário admin padrão
  const adminUser = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminUser) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare("INSERT INTO users (username, password, name) VALUES (?, ?, ?)").run('admin', hash, 'Administrador');
    console.log('Usuário admin criado — login: admin | senha: admin123');
  }

  db.close();

  // Migração de leads -> companies/contacts
  migrateLeadsToCompanies();
}

// ── Migração de dados ─────────────────────────────────────────────────────────
function migrateLeadsToCompanies() {
  const db = getDb();

  const compCount = db.prepare('SELECT COUNT(*) as c FROM companies').get().c;
  if (compCount > 0) { db.close(); return; }

  const leadCount = db.prepare('SELECT COUNT(*) as c FROM leads').get().c;
  if (leadCount === 0) { db.close(); return; }

  const companies = db.prepare(`
    SELECT company as name, sector,
           MAX(status) as status,
           MAX(interest_score) as interest_score,
           MAX(research_hook) as research_hook,
           MAX(research_context) as research_context,
           MAX(opted_out) as opted_out
    FROM leads GROUP BY LOWER(TRIM(company))
  `).all();

  const insertCompany = db.prepare(`
    INSERT INTO companies (name, sector, status, interest_score, research_hook, research_context, opted_out)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertContact = db.prepare(`
    INSERT INTO contacts (company_id, name, role, email, linkedin, whatsapp, is_primary, opted_out)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const leadToContact = {};

  db.exec('BEGIN TRANSACTION');
  try {
    for (const comp of companies) {
      const result = insertCompany.run(comp.name, comp.sector, comp.status, comp.interest_score, comp.research_hook, comp.research_context, comp.opted_out);
      const companyId = result.lastInsertRowid;

      const leads = db.prepare(`SELECT * FROM leads WHERE LOWER(TRIM(company)) = LOWER(TRIM(?))`).all(comp.name);

      leads.forEach((lead, idx) => {
        const contactResult = insertContact.run(
          companyId, lead.name, lead.role, lead.email, lead.linkedin, lead.whatsapp,
          idx === 0 ? 1 : 0,
          lead.opted_out
        );
        leadToContact[lead.id] = { contactId: contactResult.lastInsertRowid, companyId };
      });
    }

    const updateMsg = db.prepare('UPDATE messages SET contact_id=?, company_id=? WHERE lead_id=?');
    for (const [leadId, ids] of Object.entries(leadToContact)) {
      updateMsg.run(ids.contactId, ids.companyId, leadId);
    }

    const updateSent = db.prepare('UPDATE sentiment_logs SET contact_id=?, company_id=? WHERE lead_id=?');
    for (const [leadId, ids] of Object.entries(leadToContact)) {
      updateSent.run(ids.contactId, ids.companyId, leadId);
    }

    const updateConsent = db.prepare('UPDATE consent_logs SET company_id=?, contact_id=? WHERE lead_id=?');
    for (const [leadId, ids] of Object.entries(leadToContact)) {
      updateConsent.run(ids.companyId, ids.contactId, leadId);
    }

    const updateSlot = db.prepare('UPDATE schedule_slots SET company_id=?, contact_id=? WHERE lead_id=?');
    for (const [leadId, ids] of Object.entries(leadToContact)) {
      updateSlot.run(ids.companyId, ids.contactId, leadId);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.close();
  console.log(`Migracao concluida: ${companies.length} empresas, ${Object.keys(leadToContact).length} contatos`);
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado' });
  return res.redirect('/login');
}

// ── WhatsApp Webhook Routes ──────────────────────────────────────────────────
app.get('/api/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) {
      console.log('Webhook do WhatsApp verificado!');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

app.post('/api/webhook/whatsapp', (req, res) => {
  console.log('\n--- RECEBIDO POST NO WEBHOOK ---');
  console.dir(req.body, { depth: null });
  const body = req.body;

  if (body.object) {
    if (
      body.entry &&
      body.entry[0].changes &&
      body.entry[0].changes[0] &&
      body.entry[0].changes[0].value.messages &&
      body.entry[0].changes[0].value.messages[0]
    ) {
      const msg = body.entry[0].changes[0].value.messages[0];
      let phone = msg.from; // Número de quem enviou (ex: 5511999999999)
      if (phone.length === 12 && phone.startsWith('55')) phone = phone.replace(/^55/, '55'); // Tratamento simples
      
      const db = getDb();
      // Procura o contato correspondente (assumindo que o whatsapp salvo bata com o from da API)
      const contact = db.prepare('SELECT id, company_id FROM contacts WHERE whatsapp LIKE ? LIMIT 1').get(`%${phone}%`);
      
      if (contact) {
        // Mágica da Janela de 24h: Atualiza o horário de interação!
        db.exec(`UPDATE contacts SET last_wa_interaction = datetime('now') WHERE id = ${contact.id}`);
        console.log(`[WhatsApp] Janela de 24h RENOVADA para o contato ID ${contact.id} (${phone}).`);
        
        // Salva a mensagem recebida no banco para aparecer na timeline!
        db.prepare(
          "INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, approved) VALUES (?, ?, 'whatsapp', 1, 'text', ?, ?, 'received', 1)"
        ).run(contact.id, contact.company_id, msg.text.body, msg.text.body);
      } else {
        console.log(`[WhatsApp] Mensagem recebida de número desconhecido: ${phone}`);
      }
      db.close();
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// ── Claude helper ─────────────────────────────────────────────────────────────
const ROLE_PROFILES = {
  c_level:  { focus: 'ROI, estratégia e impacto no negócio',             tone: 'executivo e direto' },
  manager:  { focus: 'performance, eficiência operacional e resultados',  tone: 'consultivo e orientado a dados' },
  engineer: { focus: 'especificações técnicas, integração e performance', tone: 'técnico e detalhado' },
  other:    { focus: 'benefícios gerais e facilidade de uso',             tone: 'amigável e claro' },
};

const SEQUENCE_CHANNELS = [
  { day: 1, channel: 'linkedin', type: 'connection_request' },
  { day: 3, channel: 'email',    type: 'first_outreach' },
  { day: 5, channel: 'whatsapp', type: 'follow_up' },
];

// ── Enriquecimento de contatos ────────────────────────────────────────────────

async function enrichWithApollo(contactName, companyName) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch('https://api.apollo.io/api/v1/people/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify({
        api_key: apiKey,
        name: contactName,
        organization_name: companyName,
        reveal_personal_emails: false,
        reveal_phone_number: true,
      }),
    });
    if (res.status === 429) { console.warn('Apollo: rate limit atingido'); return null; }
    if (!res.ok) return null;
    const data = await res.json();
    const person = data.person;
    if (!person) return null;
    return {
      email:    person.email || '',
      phone:    (person.phone_numbers && person.phone_numbers[0]) ? person.phone_numbers[0].raw_number : '',
      linkedin: person.linkedin_url || '',
      source:   'apollo',
    };
  } catch (e) {
    console.warn('Apollo erro:', e.message);
    return null;
  }
}

async function enrichWithClaudeGuess(contactName, companyName) {
  const prompt = `Nome do contato: "${contactName}"\nEmpresa: "${companyName}"\n\nCom base em padrões comuns de e-mail corporativo brasileiro, gere a sugestão mais provável de e-mail profissional para este contato.\nResponda APENAS com JSON válido, sem markdown:\n{"email": "sugestao@dominio.com.br", "confidence": "low|medium|high", "reasoning": "1 frase"}`;
  try {
    const result = await callClaude(
      'Você infere padrões de e-mail profissional para prospecção B2B. Seja conservador e preciso.',
      prompt, 150
    );
    const p = JSON.parse(result);
    if (p.email && p.email.includes('@')) {
      return { email: p.email, phone: '', linkedin: '', source: 'claude_guess' };
    }
  } catch {}
  return null;
}

async function enrichContact(contactId, companyName) {
  let db = getDb();
  const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(contactId);
  db.close();
  if (!contact) return { ok: false, error: 'Contato não encontrado' };

  // Marcar como em andamento
  db = getDb();
  db.prepare("UPDATE contacts SET enrich_status='pending', enrich_at=datetime('now') WHERE id=?").run(contactId);
  db.close();

  let result = await enrichWithApollo(contact.name, companyName);
  if (!result) result = await enrichWithClaudeGuess(contact.name, companyName);

  db = getDb();
  if (result && result.email) {
    db.prepare(`
      UPDATE contacts
      SET email    = CASE WHEN (email IS NULL OR email='')    THEN ? ELSE email    END,
          whatsapp = CASE WHEN (whatsapp IS NULL OR whatsapp='') AND ?!='' THEN ? ELSE whatsapp END,
          linkedin = CASE WHEN (linkedin IS NULL OR linkedin='') AND ?!='' THEN ? ELSE linkedin END,
          enrich_status = ?,
          enrich_source = ?,
          enrich_at = datetime('now')
      WHERE id = ?
    `).run(
      result.email,
      result.phone || '', result.phone || '',
      result.linkedin || '', result.linkedin || '',
      result.source === 'apollo' ? 'found' : 'guessed',
      result.source,
      contactId
    );
    db.close();
    return { ok: true, status: result.source === 'apollo' ? 'found' : 'guessed', email: result.email, phone: result.phone || '', linkedin: result.linkedin || '', source: result.source };
  } else {
    db.prepare("UPDATE contacts SET enrich_status='not_found', enrich_source='', enrich_at=datetime('now') WHERE id=?").run(contactId);
    db.close();
    return { ok: false, status: 'not_found' };
  }
}

async function callClaude(systemPrompt, userPrompt, maxTokens = 800) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  // MOCK MODE (Modo de Demonstração Offline)
  // Caso a chave seja a padrão ("sk-ant-sua-chave-aqui") ou esteja vazia, simula as respostas do Claude com textos de alta qualidade
  if (!apiKey || apiKey === 'sk-ant-sua-chave-aqui') {
    console.log(`[Offline Demo] Utilizando simulação de IA local para o prompt.`);
    
    // Caso 1: Classificador de Sentimento
    if (systemPrompt.includes('classificador de intenção')) {
      const txt = userPrompt.toLowerCase();
      let sentiment = 'interested';
      let reasoning = 'O prospect demonstrou interesse claro em agendar uma conversa.';
      let score = 9;
      
      if (txt.includes('dúvida') || txt.includes('como funciona') || txt.includes('?') || txt.includes('preco') || txt.includes('preço')) {
        sentiment = 'technical_question';
        reasoning = 'O prospect tem uma dúvida sobre o produto ou preço.';
        score = 8;
      } else if (txt.includes('não') || txt.includes('recuso') || txt.includes('obrigado') || txt.includes('sair')) {
        sentiment = 'negative';
        reasoning = 'O prospect recusou a abordagem.';
        score = 2;
      }
      return JSON.stringify({ sentiment, reasoning, interest_score: score });
    }
    
    // Caso 2: SDR Resposta Rápida (Rascunho)
    if (systemPrompt.includes('SDR especialista em respostas rápidas')) {
      if (userPrompt.includes('dúvida técnica')) {
        return `Olá! Claro, nossa solução se integra facilmente com CRMs legados via API e no WhatsApp usamos a API Cloud oficial da Meta para total estabilidade. O que acha de fazermos uma conversa rápida de 15 minutos para eu te mostrar como funciona?`;
      } else {
        return `Excelente! Fico muito feliz com o interesse. O que acha de fazermos uma chamada rápida de 15 minutos amanhã às 14h ou na quinta às 10h para alinharmos os detalhes?`;
      }
    }

    // Caso 3: Copywriter Sequência Multicanal
    let channel = 'whatsapp';
    if (userPrompt.includes('connection no LinkedIn') || userPrompt.includes('LinkedIn')) channel = 'linkedin';
    if (userPrompt.includes('email de prospecção') || userPrompt.includes('email') || userPrompt.includes('Assunto:')) channel = 'email';
    
    const nameMatch = userPrompt.match(/Contato:\s*([^\n,]+)/);
    const contactName = nameMatch ? nameMatch[1].trim() : 'Marina';
    
    const companyMatch = userPrompt.match(/Empresa:\s*([^\n]+)/);
    const companyName = companyMatch ? companyMatch[1].trim() : 'Empresa de Teste';

    const productMatch = userPrompt.match(/Produto:\s*([^\n]+)/);
    const product = productMatch ? productMatch[1].trim() : 'solução de automação de vendas';

    if (channel === 'linkedin') {
      return `Olá ${contactName}, vi que você atua na ${companyName} e achei interessante o seu perfil. Nós ajudamos empresas de tecnologia a otimizarem seus fluxos comerciais com IA. Gostaria de conectar por aqui para trocar ideias sobre o mercado comercial B2B.`;
    } else if (channel === 'email') {
      return `Assunto: Otimização de processos comerciais na ${companyName}\n\nOlá ${contactName},\n\nTudo bem?\n\nVi que você é responsável pela área comercial na ${companyName} e decidi entrar em contato. Muitas empresas do setor de tecnologia sofrem com a perda de leads qualificados devido a follow-ups lentos.\n\nDesenvolvemos uma ${product} que ajuda a automatizar a triagem e o primeiro contato via WhatsApp, aumentando as taxas de conversão de leads.\n\nVocê teria 15 minutos nesta semana para uma demonstração rápida de como isso pode ajudar o seu time?\n\nAbraços,\nSDR Sales AI`;
    } else {
      return `Olá ${contactName}! Tudo bem?\n\nVi que você é o contato principal da ${companyName}.\n\nEstamos ajudando empresas do setor de tecnologia a automatizarem a triagem de leads com o nosso ${product}, melhorando a produtividade do time comercial.\n\nVocê teria 15 minutos para batermos um papo rápido e eu te mostrar como funciona na prática?`;
    }
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error ? data.error.message : 'Erro na requisição');
    }
    return data.content[0].text;
  } catch (e) {
    return `[ERRO API: ${e.message}]`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ROTAS DE AUTENTICAÇÃO
// ════════════════════════════════════════════════════════════════════════════

app.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'templates', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.redirect('/login?error=Preencha+usuário+e+senha');

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  db.close();

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.redirect('/login?error=Usuário+ou+senha+inválidos');
  }

  req.session.userId   = user.id;
  req.session.username = user.username;
  req.session.name     = user.name;
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Rota principal (protegida) ────────────────────────────────────────────────
app.get('/', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});

// ════════════════════════════════════════════════════════════════════════════
// API — todas protegidas
// ════════════════════════════════════════════════════════════════════════════
app.use('/api', requireLogin);

// Me
app.get('/api/me', (req, res) => {
  res.json({ username: req.session.username, name: req.session.name });
});

// Stats — inclui total_opportunities e pipeline_value (Melhoria 1)
app.get('/api/stats', (req, res) => {
  const db = getDb();
  res.json({
    total_companies:     db.prepare('SELECT COUNT(*) as c FROM companies').get().c,
    total_contacts:      db.prepare('SELECT COUNT(*) as c FROM contacts').get().c,
    opted_out:           db.prepare("SELECT COUNT(*) as c FROM companies WHERE opted_out=1").get().c,
    hot_leads:           db.prepare("SELECT COUNT(*) as c FROM companies WHERE status='hot_lead'").get().c,
    meetings:            db.prepare("SELECT COUNT(*) as c FROM companies WHERE status='meeting_set'").get().c,
    pending_review:      db.prepare("SELECT COUNT(*) as c FROM messages WHERE approved=0 AND status='pending'").get().c,
    docs_count:          db.prepare('SELECT COUNT(*) as c FROM documents').get().c,
    golden_cases:        db.prepare('SELECT COUNT(*) as c FROM golden_cases').get().c,
    avg_score:           db.prepare('SELECT ROUND(AVG(score),1) as a FROM messages WHERE score IS NOT NULL').get().a,
    total_opportunities: db.prepare('SELECT COUNT(*) as c FROM opportunities').get().c,
    pipeline_value:      db.prepare("SELECT COALESCE(SUM(value),0) as v FROM opportunities WHERE stage NOT IN ('lost')").get().v,
    enriched_contacts:   db.prepare("SELECT COUNT(*) as c FROM contacts WHERE email IS NOT NULL AND email!=''").get().c,
  });
  db.close();
});

// ── Companies ─────────────────────────────────────────────────────────────────
app.get('/api/companies', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT c.*,
      COUNT(ct.id) as contact_count,
      GROUP_CONCAT(ct.name || ' (' || ct.role || ')', '||') as contacts_summary
    FROM companies c
    LEFT JOIN contacts ct ON ct.company_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `).all();
  
  for (const row of rows) {
    row.contacts = db.prepare('SELECT * FROM contacts WHERE company_id=? ORDER BY is_primary DESC, created_at ASC').all(row.id);
  }

  db.close();
  res.json(rows);
});

app.post('/api/companies', (req, res) => {
  const { name, sector, contact_name, contact_role, contact_email, contact_linkedin, contact_whatsapp } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome da empresa é obrigatório' });
  const db = getDb();
  const dup = db.prepare('SELECT id FROM companies WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))').get(name);
  if (dup) { db.close(); return res.status(409).json({ error: 'Empresa já cadastrada', existing_id: dup.id }); }
  // Valida e-mail do primeiro contato antes de criar a empresa (evita órfã).
  if (contact_name && contact_name.trim() && contact_email && !isValidEmailServer(contact_email)) {
    db.close();
    return res.status(400).json({ error: 'E-mail do contato inválido' });
  }
  const r = db.prepare('INSERT INTO companies (name, sector) VALUES (?, ?)').run(name, sector || '');
  const companyId = r.lastInsertRowid;
  db.prepare('INSERT INTO consent_logs (company_id, action, details) VALUES (?, ?, ?)').run(companyId, 'company_added', `Empresa "${name}" adicionada ao sistema`);
  // Cria o primeiro contato (enviado pelo formulário "Nova Empresa") se informado.
  let contactId = null;
  if (contact_name && contact_name.trim()) {
    const cr = db.prepare('INSERT INTO contacts (company_id, name, role, email, linkedin, whatsapp, is_primary) VALUES (?,?,?,?,?,?,1)')
      .run(companyId, contact_name.trim(), contact_role || 'other', contact_email || '', contact_linkedin || '', normalizePhone(contact_whatsapp));
    contactId = cr.lastInsertRowid;
    db.prepare('INSERT INTO consent_logs (company_id, contact_id, action, details) VALUES (?,?,?,?)').run(companyId, contactId, 'contact_added', `Contato "${contact_name.trim()}" adicionado`);
  }
  db.close();
  res.json({ id: companyId, contact_id: contactId });
});

// Mapeia cargo em texto livre (ex.: "Diretor Comercial") para a categoria do sistema.
function roleFromText(text) {
  const t = (text || '').toString().toLowerCase();
  // siglas só como palavra inteira (evita "Coordenador" casar com "coo")
  if (/\b(ceo|cfo|cto|cio|ciso|cdo|cmo|coo|vp)\b/.test(t) || /(diretor|diretora|presidente|vice|head|chief|founder|fundador|s[oó]cio|owner|propriet|superintendente)/.test(t)) return 'c_level';
  if (/(gerente|gestor|gestora|coordenad|supervisor|manager|l[ií]der|\blead\b)/.test(t)) return 'manager';
  if (/(engenhei|desenvolvedor|developer|\bdev\b|t[eé]cnico|anal[ií]sta de ti|\bti\b|software|infra)/.test(t)) return 'engineer';
  return 'other';
}

// Importação em massa (planilha Excel/CSV): agrupa contatos pela mesma empresa,
// cria a empresa uma vez e anexa os demais contatos a ela. Não chama IA.
app.post('/api/companies/import-bulk', (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'Nenhuma linha para importar' });
  const db = getDb();
  let companiesCreated = 0, contactsCreated = 0, skipped = 0;
  const errors = [];

  const findCompany   = db.prepare('SELECT id FROM companies WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))');
  const insCompany    = db.prepare('INSERT INTO companies (name, sector) VALUES (?, ?)');
  const logCompany    = db.prepare('INSERT INTO consent_logs (company_id, action, details) VALUES (?,?,?)');
  const findContact   = db.prepare("SELECT id FROM contacts WHERE email != '' AND email=? AND company_id=?");
  const countContacts = db.prepare('SELECT COUNT(*) as c FROM contacts WHERE company_id=?');
  const insContact    = db.prepare('INSERT INTO contacts (company_id, name, role, email, linkedin, whatsapp, is_primary) VALUES (?,?,?,?,?,?,?)');
  const logContact    = db.prepare('INSERT INTO consent_logs (company_id, contact_id, action, details) VALUES (?,?,?,?)');

  for (const row of rows) {
    const companyName = (row.company || '').toString().trim();
    if (!companyName) { skipped++; continue; }

    let comp = findCompany.get(companyName);
    let companyId;
    if (comp) {
      companyId = comp.id;
    } else {
      companyId = insCompany.run(companyName, (row.sector || '').toString().trim()).lastInsertRowid;
      logCompany.run(companyId, 'company_added', `Empresa "${companyName}" importada (planilha)`);
      companiesCreated++;
    }

    const contactName = (row.contact_name || '').toString().trim();
    if (!contactName) continue; // linha só de empresa, sem contato

    let email = (row.email || '').toString().trim();
    if (email && !isValidEmailServer(email)) { errors.push(`E-mail inválido ignorado: ${email}`); email = ''; }
    if (email && findContact.get(email, companyId)) { skipped++; continue; } // contato duplicado nessa empresa

    const isPrimary = countContacts.get(companyId).c === 0 ? 1 : 0;
    const cr = insContact.run(companyId, contactName, roleFromText(row.role), email, '', normalizePhone(row.whatsapp), isPrimary);
    logContact.run(companyId, cr.lastInsertRowid, 'contact_added', `Contato "${contactName}" importado (planilha)`);
    contactsCreated++;
  }

  db.close();
  res.json({ ok: true, companies_created: companiesCreated, contacts_created: contactsCreated, skipped, errors: errors.slice(0, 20) });
});

app.get('/api/companies/:id', (req, res) => {
  const db = getDb();
  const company = db.prepare('SELECT * FROM companies WHERE id=?').get(req.params.id);
  if (!company) { db.close(); return res.status(404).json({ error: 'Empresa não encontrada' }); }
  const contacts = db.prepare('SELECT * FROM contacts WHERE company_id=? ORDER BY is_primary DESC, created_at ASC').all(req.params.id);
  const messages = db.prepare('SELECT m.*, ct.name as contact_name FROM messages m LEFT JOIN contacts ct ON m.contact_id=ct.id WHERE m.company_id=? ORDER BY m.day').all(req.params.id);
  const sentiments = db.prepare('SELECT s.*, ct.name as contact_name FROM sentiment_logs s LEFT JOIN contacts ct ON s.contact_id=ct.id WHERE s.company_id=? ORDER BY s.created_at DESC LIMIT 10').all(req.params.id);
  const consent_logs = db.prepare('SELECT cl.*, ct.name as contact_name FROM consent_logs cl LEFT JOIN contacts ct ON cl.contact_id=ct.id WHERE cl.company_id=? ORDER BY cl.created_at DESC').all(req.params.id);
  const slots = db.prepare('SELECT * FROM schedule_slots WHERE company_id=?').all(req.params.id);
  let research_history = [], sequence_history = [];
  try { research_history = JSON.parse(company.research_history || '[]'); } catch {}
  try { sequence_history = JSON.parse(company.sequence_history || '[]'); } catch {}
  db.close();
  res.json({ company, contacts, messages, sentiments, consent_logs, slots, research_history, sequence_history });
});

app.delete('/api/companies/:id', (req, res) => {
  const db = getDb();
  const company = db.prepare('SELECT id FROM companies WHERE id=?').get(req.params.id);
  if (!company) { db.close(); return res.status(404).json({ error: 'Empresa não encontrada' }); }
  db.prepare('DELETE FROM messages WHERE company_id=?').run(req.params.id);
  db.prepare('DELETE FROM sentiment_logs WHERE company_id=?').run(req.params.id);
  db.prepare('DELETE FROM consent_logs WHERE company_id=?').run(req.params.id);
  db.prepare('DELETE FROM schedule_slots WHERE company_id=?').run(req.params.id);
  db.prepare('DELETE FROM opportunities WHERE company_id=?').run(req.params.id);
  db.prepare('DELETE FROM contacts WHERE company_id=?').run(req.params.id);
  db.prepare('DELETE FROM companies WHERE id=?').run(req.params.id);
  db.close();
  res.json({ ok: true });
});

// PATCH /api/companies/:id — editar nome e setor (Melhoria 14)
app.patch('/api/companies/:id', (req, res) => {
  const { name, sector } = req.body;
  const db = getDb();
  const company = db.prepare('SELECT * FROM companies WHERE id=?').get(req.params.id);
  if (!company) { db.close(); return res.status(404).json({ error: 'Empresa não encontrada' }); }

  if (name && name !== company.name) {
    const dup = db.prepare('SELECT id FROM companies WHERE LOWER(TRIM(name))=LOWER(TRIM(?)) AND id!=?').get(name, req.params.id);
    if (dup) { db.close(); return res.status(409).json({ error: 'Já existe uma empresa com este nome' }); }
  }

  db.prepare('UPDATE companies SET name=?, sector=? WHERE id=?').run(
    name || company.name,
    sector !== undefined ? sector : company.sector,
    req.params.id
  );
  db.close();
  res.json({ ok: true });
});

app.post('/api/companies/:id/contacts', (req, res) => {
  const { name, role, email, linkedin, whatsapp } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome do contato é obrigatório' });
  const db = getDb();
  const company = db.prepare('SELECT id FROM companies WHERE id=?').get(req.params.id);
  if (!company) { db.close(); return res.status(404).json({ error: 'Empresa não encontrada' }); }

  if (email && !isValidEmailServer(email)) {
    db.close();
    return res.status(400).json({ error: 'E-mail inválido' });
  }
  if (email) {
    const dup = db.prepare("SELECT id FROM contacts WHERE email != '' AND email=? AND company_id=?").get(email, req.params.id);
    if (dup) { db.close(); return res.status(409).json({ error: 'Contato com este e-mail já cadastrado nesta empresa' }); }
  }

  const isPrimary = db.prepare('SELECT COUNT(*) as c FROM contacts WHERE company_id=?').get(req.params.id).c === 0 ? 1 : 0;
  const normalizedWa = normalizePhone(whatsapp);
  const r = db.prepare('INSERT INTO contacts (company_id, name, role, email, linkedin, whatsapp, is_primary) VALUES (?,?,?,?,?,?,?)').run(req.params.id, name, role || 'other', email || '', linkedin || '', normalizedWa, isPrimary);
  db.prepare('INSERT INTO consent_logs (company_id, contact_id, action, details) VALUES (?,?,?,?)').run(req.params.id, r.lastInsertRowid, 'contact_added', `Contato "${name}" adicionado`);
  db.close();
  res.json({ id: r.lastInsertRowid });
});

app.patch('/api/companies/:companyId/contacts/:contactId', (req, res) => {
  const { name, role, email, linkedin, whatsapp } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome do contato é obrigatório' });
  const db = getDb();
  const contact = db.prepare('SELECT id FROM contacts WHERE id=? AND company_id=?').get(req.params.contactId, req.params.companyId);
  if (!contact) { db.close(); return res.status(404).json({ error: 'Contato não encontrado' }); }
  if (email && !isValidEmailServer(email)) {
    db.close();
    return res.status(400).json({ error: 'E-mail inválido' });
  }
  if (email) {
    const dup = db.prepare("SELECT id FROM contacts WHERE email != '' AND email=? AND company_id=? AND id!=?").get(email, req.params.companyId, req.params.contactId);
    if (dup) { db.close(); return res.status(409).json({ error: 'Contato com este e-mail já cadastrado nesta empresa' }); }
  }
  const normalizedWa = normalizePhone(whatsapp);
  db.prepare('UPDATE contacts SET name=?, role=?, email=?, linkedin=?, whatsapp=? WHERE id=? AND company_id=?')
    .run(name, role || 'other', email || '', linkedin || '', normalizedWa, req.params.contactId, req.params.companyId);
  db.close();
  res.json({ ok: true });
});

app.patch('/api/companies/:companyId/contacts/:contactId/set-primary', (req, res) => {
  const db = getDb();
  const contact = db.prepare('SELECT id FROM contacts WHERE id=? AND company_id=?').get(req.params.contactId, req.params.companyId);
  if (!contact) { db.close(); return res.status(404).json({ error: 'Contato não encontrado' }); }
  db.prepare('UPDATE contacts SET is_primary=0 WHERE company_id=?').run(req.params.companyId);
  db.prepare('UPDATE contacts SET is_primary=1 WHERE id=?').run(req.params.contactId);
  db.close();
  res.json({ ok: true });
});

app.delete('/api/companies/:companyId/contacts/:contactId', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM messages WHERE contact_id=? AND company_id=?').run(req.params.contactId, req.params.companyId);
  db.prepare('DELETE FROM sentiment_logs WHERE contact_id=? AND company_id=?').run(req.params.contactId, req.params.companyId);
  db.prepare('DELETE FROM contacts WHERE id=? AND company_id=?').run(req.params.contactId, req.params.companyId);
  db.close();
  res.json({ ok: true });
});

// ── Ações em lote (bulk actions) ─────────────────────────────────────────────

// Atualizar status de várias empresas
app.post('/api/companies/bulk-status', (req, res) => {
  const { company_ids, status } = req.body;
  const VALID_STATUSES = ['new','researched','sequence_created','contacted','hot_lead','meeting_set','rejected','opted_out'];
  if (!Array.isArray(company_ids) || !company_ids.length || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'company_ids e status válido são obrigatórios' });
  }
  const db = getDb();
  const placeholders = company_ids.map(() => '?').join(',');
  db.prepare(`UPDATE companies SET status=? WHERE id IN (${placeholders})`).run(status, ...company_ids);
  db.close();
  res.json({ ok: true, updated: company_ids.length });
});

// Gerar pesquisa IA em lote (background)
app.post('/api/companies/bulk-research', async (req, res) => {
  const { company_ids, product_value } = req.body;
  if (!Array.isArray(company_ids) || !company_ids.length) {
    return res.status(400).json({ error: 'company_ids é obrigatório' });
  }
  res.json({ ok: true, queued: company_ids.length, message: `Pesquisa iniciada para ${company_ids.length} empresa(s) em background.` });

  (async () => {
    for (const companyId of company_ids) {
      try {
        const db = getDb();
        const company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
        let contact = db.prepare('SELECT * FROM contacts WHERE company_id=? AND is_primary=1').get(companyId);
        if (!contact) contact = db.prepare('SELECT * FROM contacts WHERE company_id=? LIMIT 1').get(companyId);
        const golden = db.prepare('SELECT content FROM golden_cases ORDER BY score DESC LIMIT 2').all();
        db.close();
        if (!company) continue;

        const roleInfo = ROLE_PROFILES[contact?.role] || ROLE_PROFILES.other;
        const goldenCtx = golden.map(g => g.content).join('\n');
        const prompt = `Empresa-alvo: ${company.name} (setor: ${company.sector || 'não informado'})\nContato: ${contact ? contact.name + ' (' + contact.role + ')' : 'não definido'}\nProduto: ${product_value || 'solução de automação de vendas com IA'}\nPerfil: foco em ${roleInfo.focus}, tom ${roleInfo.tone}\n${goldenCtx ? 'Exemplos:\n' + goldenCtx : ''}\n\nGere JSON com "research_context", "hook", "pain_points", "value_proposition". Responda APENAS com JSON válido, sem markdown.`;

        const result = await callClaude('Você é assistente de pesquisa de vendas B2B especializado em prospecção personalizada.', prompt, 900);
        let hook, ctx;
        try { const p = JSON.parse(result); hook = p.hook || result; ctx = JSON.stringify(p); }
        catch { hook = result; ctx = result; }

        const db2 = getDb();
        db2.prepare("UPDATE companies SET research_hook=?,research_context=?,status='researched' WHERE id=?").run(hook, ctx, companyId);
        db2.close();
        await new Promise(r => setTimeout(r, 600));
      } catch (e) {
        console.error(`Bulk research erro empresa ${companyId}:`, e.message);
      }
    }
  })();
});

// Salvar rascunho de resposta como mensagem pendente na fila
app.post('/api/companies/:id/queue-draft', (req, res) => {
  const { content, contact_id } = req.body;
  if (!content) return res.status(400).json({ error: 'content obrigatório' });
  const db = getDb();
  const company = db.prepare('SELECT id FROM companies WHERE id=?').get(req.params.id);
  if (!company) { db.close(); return res.status(404).json({ error: 'Empresa não encontrada' }); }
  const r = db.prepare(
    "INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, approved) VALUES (?,?,?,?,?,?,?,'pending',0)"
  ).run(contact_id || null, req.params.id, 'email', 0, 'draft_reply', content, content);
  db.close();
  res.json({ id: r.lastInsertRowid });
});

// ── Enriquecimento de contatos ────────────────────────────────────────────────

// Enriquecer um único contato
app.post('/api/contacts/enrich', async (req, res) => {
  const { contact_id, company_name } = req.body;
  if (!contact_id) return res.status(400).json({ error: 'contact_id é obrigatório' });

  let companyName = company_name;
  if (!companyName) {
    const db = getDb();
    const row = db.prepare('SELECT c.name FROM contacts ct JOIN companies c ON c.id=ct.company_id WHERE ct.id=?').get(contact_id);
    db.close();
    companyName = row ? row.name : '';
  }

  const result = await enrichContact(contact_id, companyName);
  res.json(result);
});

// Enriquecer em lote contatos sem e-mail (máx 50)
app.post('/api/contacts/bulk-enrich', async (req, res) => {
  const { contact_ids } = req.body;
  const db = getDb();

  let contacts;
  if (contact_ids && contact_ids.length) {
    const placeholders = contact_ids.map(() => '?').join(',');
    contacts = db.prepare(
      `SELECT ct.id, ct.name, c.name as company_name
       FROM contacts ct JOIN companies c ON c.id=ct.company_id
       WHERE ct.id IN (${placeholders}) AND ct.opted_out=0`
    ).all(...contact_ids);
  } else {
    contacts = db.prepare(
      `SELECT ct.id, ct.name, c.name as company_name
       FROM contacts ct JOIN companies c ON c.id=ct.company_id
       WHERE (ct.email IS NULL OR ct.email='') AND ct.opted_out=0
       LIMIT 50`
    ).all();
  }
  db.close();

  if (!contacts.length) return res.json({ total: 0, found: 0, guessed: 0, not_found: 0, results: [] });

  const painLine = painPoint ? ('Dor principal do lead: ' + painPoint) : '';
  const painCTA  = painPoint ? 'IMPORTANTE: a mensagem deve abordar diretamente a dor mencionada acima como ponto de entrada.' : '';

  const results = [];
  for (const ct of contacts) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const result = await enrichContact(ct.id, ct.company_name);
      results.push({ contact_id: ct.id, name: ct.name, company: ct.company_name, ...result });
    } catch (e) {
      results.push({ contact_id: ct.id, name: ct.name, ok: false, status: 'error' });
    }
  }

  res.json({
    total:     contacts.length,
    found:     results.filter(r => r.status === 'found').length,
    guessed:   results.filter(r => r.status === 'guessed').length,
    not_found: results.filter(r => r.status === 'not_found' || r.status === 'error').length,
    results,
  });
});

// Importar segunda lista (nome + empresa) e opcionalmente enriquecer em background
app.post('/api/contacts/import-and-enrich', async (req, res) => {
  const { contacts: inputList, auto_enrich } = req.body;
  if (!Array.isArray(inputList) || !inputList.length) {
    return res.status(400).json({ error: 'Lista de contatos é obrigatória' });
  }

  const db = getDb();
  const imported = [];

  for (const item of inputList) {
    const { name, company_name } = item;
    if (!name || !company_name) continue;

    // Buscar ou criar empresa
    let company = db.prepare('SELECT id FROM companies WHERE LOWER(TRIM(name))=LOWER(TRIM(?))').get(company_name);
    if (!company) {
      const r = db.prepare('INSERT INTO companies (name) VALUES (?)').run(company_name);
      db.prepare('INSERT INTO consent_logs (company_id, action, details) VALUES (?,?,?)').run(r.lastInsertRowid, 'company_added', `Empresa "${company_name}" adicionada via importação de lista`);
      company = { id: r.lastInsertRowid };
    }

    // Verificar se contato já existe nessa empresa
    const existing = db.prepare(
      'SELECT id FROM contacts WHERE company_id=? AND LOWER(TRIM(name))=LOWER(TRIM(?))'
    ).get(company.id, name);

    let contactId;
    if (existing) {
      contactId = existing.id;
    } else {
      const isPrimary = db.prepare('SELECT COUNT(*) as c FROM contacts WHERE company_id=?').get(company.id).c === 0 ? 1 : 0;
      const r = db.prepare(
        "INSERT INTO contacts (company_id, name, is_primary, enrich_status) VALUES (?,?,?,'pending')"
      ).run(company.id, name, isPrimary);
      contactId = r.lastInsertRowid;
      db.prepare('INSERT INTO consent_logs (company_id, contact_id, action, details) VALUES (?,?,?,?)').run(company.id, contactId, 'contact_added', `Contato "${name}" adicionado via importação de lista`);
    }
    imported.push({ contact_id: contactId, name, company_name, company_id: company.id });
  }
  db.close();

  // Responder imediatamente e enriquecer em background se solicitado
  res.json({
    imported: imported.length,
    message: auto_enrich
      ? `${imported.length} contato(s) importado(s). Enriquecimento iniciado em background.`
      : `${imported.length} contato(s) importado(s). Use o botão "Enriquecer sem e-mail" para buscar dados.`,
    contacts: imported,
  });

  if (auto_enrich) {
    (async () => {
      for (const item of imported) {
        await new Promise(r => setTimeout(r, 350));
        try { await enrichContact(item.contact_id, item.company_name); } catch {}
      }
    })();
  }
});

// Busca global de contatos
app.get('/api/contacts', (req, res) => {
  const q = (req.query.q || '').trim();
  const db = getDb();
  const rows = q
    ? db.prepare(`SELECT ct.*, c.name as company_name, c.id as company_id FROM contacts ct LEFT JOIN companies c ON ct.company_id=c.id WHERE ct.name LIKE ? OR ct.email LIKE ? ORDER BY ct.name LIMIT 50`).all(`%${q}%`, `%${q}%`)
    : db.prepare(`SELECT ct.*, c.name as company_name FROM contacts ct LEFT JOIN companies c ON ct.company_id=c.id ORDER BY ct.created_at DESC LIMIT 50`).all();
  db.close();
  res.json(rows);
});

app.get('/api/companies/:id/timeline', (req, res) => {
  const db = getDb();

  const logs = db.prepare("SELECT *, 'consent' as type FROM consent_logs WHERE company_id=? ORDER BY created_at DESC").all(req.params.id);

  // NOTA: Para mensagens, usamos o ID decrescente para ordenar, já que created_at não existe na tabela messages
  const msgs = db.prepare(`SELECT m.*, ct.name as contact_name, 'message' as type
    FROM messages m LEFT JOIN contacts ct ON m.contact_id=ct.id
    WHERE m.company_id=? ORDER BY m.id DESC`).all(req.params.id);

  const sents = db.prepare(`SELECT s.*, ct.name as contact_name, 'sentiment' as type
    FROM sentiment_logs s LEFT JOIN contacts ct ON s.contact_id=ct.id
    WHERE s.company_id=? ORDER BY s.created_at DESC`).all(req.params.id);

  const slots = db.prepare("SELECT *, 'slot' as type FROM schedule_slots WHERE company_id=? ORDER BY created_at DESC").all(req.params.id);

  const mappedLogs = logs.map(l => ({
    type: 'consent',
    icon: 'shield-check',
    title: l.action === 'company_added' ? 'Empresa cadastrada' : 'Consentimento atualizado',
    description: l.details,
    created_at: l.created_at
  }));

  const mappedMsgs = msgs.map(m => {
    const statusLabel = m.status === 'pending' ? 'Pendente' : m.status === 'approved' ? 'Aprovada' : m.status === 'received' ? 'Recebida' : 'Enviada';
    const icon = m.channel === 'whatsapp' ? 'whatsapp' : m.channel === 'email' ? 'envelope' : 'linkedin';
    const direction = m.status === 'received' ? 'Recebido de' : 'Enviado para';
    return {
      type: 'message',
      icon: icon,
      title: `${m.channel.charAt(0).toUpperCase() + m.channel.slice(1)} (${statusLabel})`,
      description: `${direction} ${m.contact_name || 'contato'}: "${m.content.substring(0, 100)}${m.content.length > 100 ? '...' : ''}"`,
      // Como a tabela de mensagens não tem created_at, usamos a data atual simulada ou aproximada para ordenação
      created_at: new Date().toISOString()
    };
  });

  const mappedSents = sents.map(s => ({
    type: 'sentiment',
    icon: 'emoji-smile',
    title: `Análise de Sentimento: ${s.sentiment.toUpperCase()}`,
    description: `Mensagem de ${s.contact_name || 'contato'}: "${s.response_text}" | Score de Interesse: ${s.interest_score}/10`,
    created_at: s.created_at
  }));

  const mappedSlots = slots.map(sl => ({
    type: 'slot',
    icon: 'calendar-event',
    title: `Reunião agendada`,
    description: `Horário: ${sl.time_slot} com o time comercial`,
    created_at: sl.created_at
  }));

  const all = [...mappedLogs, ...mappedMsgs, ...mappedSents, ...mappedSlots]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  db.close();
  res.json(all);
});

app.post('/api/companies/:id/research', async (req, res) => {
  const db = getDb();
  const company = db.prepare('SELECT * FROM companies WHERE id=?').get(req.params.id);
  if (!company) { db.close(); return res.status(404).json({ error: 'Empresa não encontrada' }); }

  let contact;
  if (req.body.contact_id) {
    contact = db.prepare('SELECT * FROM contacts WHERE id=? AND company_id=?').get(req.body.contact_id, req.params.id);
  }
  if (!contact) {
    contact = db.prepare('SELECT * FROM contacts WHERE company_id=? AND is_primary=1').get(req.params.id);
  }
  if (!contact) {
    contact = db.prepare('SELECT * FROM contacts WHERE company_id=? LIMIT 1').get(req.params.id);
  }

  const roleInfo = ROLE_PROFILES[contact?.role] || ROLE_PROFILES.other;
  const productValue = req.body.product_value || 'solução de automação de vendas com IA';
  const golden = db.prepare('SELECT content FROM golden_cases ORDER BY score DESC LIMIT 2').all();
  const goldenCtx = golden.map(g => g.content).join('\n');
  db.close();

  const prompt = `
Empresa-alvo: ${company.name} (setor: ${company.sector || 'não informado'})
Contato principal: ${contact ? contact.name + ' (' + contact.role + ')' : 'não definido'}
Produto sendo vendido: ${productValue}
Perfil do cargo: foco em ${roleInfo.focus}, tom ${roleInfo.tone}
${goldenCtx ? 'Exemplos de sucesso:\n' + goldenCtx : ''}

Gere um JSON com:
- "research_context": 2-3 ganchos plausíveis sobre a empresa (expansões, desafios do setor, tendências)
- "hook": frase de abertura hiperpersonalizada (máx 2 linhas), conectando um gancho ao produto
- "pain_points": lista de 3 dores específicas do setor/porte da empresa
- "value_proposition": proposta de valor adaptada ao perfil

Responda APENAS com JSON válido, sem markdown.`;

  const result = await callClaude('Você é assistente de pesquisa de vendas B2B especializado em prospecção personalizada.', prompt, 900);
  let hook, ctx;
  try { const p = JSON.parse(result); hook = p.hook || result; ctx = JSON.stringify(p); }
  catch { hook = result; ctx = result; }

  const db2 = getDb();
  const prevHistRaw = db2.prepare('SELECT research_history FROM companies WHERE id=?').get(req.params.id);
  let researchHist = [];
  try { researchHist = JSON.parse(prevHistRaw?.research_history || '[]'); } catch {}
  const prevHook = db2.prepare('SELECT research_hook, research_context FROM companies WHERE id=?').get(req.params.id);
  if (prevHook?.research_hook) {
    researchHist.unshift({ hook: prevHook.research_hook, context: prevHook.research_context, created_at: new Date().toISOString() });
    if (researchHist.length > 5) researchHist = researchHist.slice(0, 5);
  }
  db2.prepare('UPDATE companies SET research_hook=?,research_context=?,research_history=?,status=? WHERE id=?').run(hook, ctx, JSON.stringify(researchHist), 'researched', req.params.id);
  db2.close();
  res.json({ hook, context: ctx, history: researchHist });
});

app.post('/api/companies/:id/sequence', async (req, res) => {
  const db = getDb();
  const company = db.prepare('SELECT * FROM companies WHERE id=?').get(req.params.id);
  if (!company) { db.close(); return res.status(404).json({ error: 'Empresa não encontrada' }); }
  if (company.opted_out) { db.close(); return res.status(403).json({ error: 'Empresa está na blacklist' }); }

  let contact;
  if (req.body.contact_id) {
    contact = db.prepare('SELECT * FROM contacts WHERE id=? AND company_id=?').get(req.body.contact_id, req.params.id);
  }
  if (!contact) {
    contact = db.prepare('SELECT * FROM contacts WHERE company_id=? AND is_primary=1').get(req.params.id);
  }
  if (!contact) {
    contact = db.prepare('SELECT * FROM contacts WHERE company_id=? LIMIT 1').get(req.params.id);
  }
  if (!contact) { db.close(); return res.status(400).json({ error: 'Adicione ao menos um contato antes de gerar a sequência' }); }

  // Salvar histórico da sequência anterior
  const prevMsgs = db.prepare('SELECT * FROM messages WHERE company_id=? AND contact_id=?').all(req.params.id, contact.id);
  if (prevMsgs.length > 0) {
    const prevSeqHistRaw = db.prepare('SELECT sequence_history FROM companies WHERE id=?').get(req.params.id);
    let seqHist = [];
    try { seqHist = JSON.parse(prevSeqHistRaw?.sequence_history || '[]'); } catch {}
    seqHist.unshift({ contact_name: contact.name, messages: prevMsgs, created_at: new Date().toISOString() });
    if (seqHist.length > 3) seqHist = seqHist.slice(0, 3);
    db.prepare('UPDATE companies SET sequence_history=? WHERE id=?').run(JSON.stringify(seqHist), req.params.id);
  }
  db.prepare('DELETE FROM messages WHERE company_id=? AND contact_id=?').run(req.params.id, contact.id);

  const roleInfo = ROLE_PROFILES[contact.role] || ROLE_PROFILES.other;
  const hook = company.research_hook || `Olá ${contact.name},`;
  const productValue = req.body.product_value || 'solução de automação de vendas com IA';
  const golden = db.prepare('SELECT title, content FROM golden_cases WHERE score>=4 LIMIT 3').all();
  const socialProof = golden.map(g => `- ${g.title}: ${g.content.substring(0, 80)}...`).join('\n');
  db.close();

  const painPoint = req.body.pain_point || '';
  const painLine = painPoint ? ('Dor principal do lead: ' + painPoint) : '';
  const painCTA  = painPoint ? 'IMPORTANTE: a mensagem deve abordar diretamente a dor mencionada acima como ponto de entrada.' : '';

  const results = [];
  for (const tpl of SEQUENCE_CHANNELS) {
    const channelDesc = {
      linkedin: 'mensagem de conexão no LinkedIn (máx 300 chars, tom informal)',
      email:    'email de prospecção (inclua assunto na 1ª linha como "Assunto: ...", corpo máx 150 palavras)',
      whatsapp: 'mensagem WhatsApp (casual, máx 100 palavras)',
    }[tpl.channel];

    const prompt = `
Empresa: ${company.name} (setor: ${company.sector || 'não definido'})
Contato: ${contact.name}, cargo ${contact.role}
Gancho: ${hook}
Produto: ${productValue}
${painLine}
Tom: ${roleInfo.tone} | Foco: ${roleInfo.focus}
Canal / Dia ${tpl.day}: ${channelDesc}
${socialProof ? 'Casos de sucesso:\n' + socialProof : ''}

Escreva APENAS o texto da mensagem, sem explicações.
${painCTA}
CTA progressivo: convide para "conversa de 15 minutos" ou "demo rápida". NÃO tente vender diretamente.`;

    const content = await callClaude('Você é copywriter B2B especialista em sequências multicanal.', prompt, 400);
    const db3 = getDb();
    const r = db3.prepare('INSERT INTO messages (lead_id, contact_id, company_id, channel, day, msg_type, content, ai_original, status) VALUES (?,?,?,?,?,?,?,?,?)').run(null, contact.id, req.params.id, tpl.channel, tpl.day, tpl.type, content, content, 'pending');
    db3.close();
    results.push({ id: r.lastInsertRowid, channel: tpl.channel, day: tpl.day, content, status: 'pending', approved: 0, contact_name: contact.name });
  }

  const db4 = getDb();
  db4.prepare("UPDATE companies SET status='sequence_created' WHERE id=?").run(req.params.id);
  db4.close();
  res.json({ sequence: results, messages: results, contact });
});

// ── Geração de sequência em lote (multi-lead, multi-produto) ─────────────────
async function generateSequenceForCompany(companyId, productValue, painPoint = '') {
  const db = getDb();
  const company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
  if (!company) { db.close(); throw new Error('Empresa não encontrada'); }
  if (company.opted_out) { db.close(); throw new Error('Empresa na blacklist'); }

  let contact = db.prepare('SELECT * FROM contacts WHERE company_id=? AND is_primary=1').get(companyId);
  if (!contact) contact = db.prepare('SELECT * FROM contacts WHERE company_id=? LIMIT 1').get(companyId);
  if (!contact) { db.close(); throw new Error('Sem contatos cadastrados'); }

  const roleInfo = ROLE_PROFILES[contact.role] || ROLE_PROFILES.other;
  const hook = company.research_hook || `Olá ${contact.name},`;
  const golden = db.prepare('SELECT title, content FROM golden_cases WHERE score>=4 LIMIT 3').all();
  const socialProof = golden.map(g => `- ${g.title}: ${g.content.substring(0, 80)}...`).join('\n');
  db.close();

  const results = [];
  for (const tpl of SEQUENCE_CHANNELS) {
    const channelDesc = {
      linkedin: 'mensagem de conexão no LinkedIn (máx 300 chars, tom informal)',
      email:    'email de prospecção (inclua assunto na 1ª linha como "Assunto: ...", corpo máx 150 palavras)',
      whatsapp: 'mensagem WhatsApp (casual, máx 100 palavras)',
    }[tpl.channel];

    const prompt = `
Empresa: ${company.name} (setor: ${company.sector || 'não definido'})
Contato: ${contact.name}, cargo ${contact.role}
Gancho: ${hook}
Produto: ${productValue}
Tom: ${roleInfo.tone} | Foco: ${roleInfo.focus}
Canal / Dia ${tpl.day}: ${channelDesc}
${socialProof ? 'Casos de sucesso:\n' + socialProof : ''}

Escreva APENAS o texto da mensagem, sem explicações.
CTA progressivo: convide para "conversa de 15 minutos" ou "demo rápida". NÃO tente vender diretamente.`;

    const content = await callClaude('Você é copywriter B2B especialista em sequências multicanal.', prompt, 400);
    const dbW = getDb();
    const r = dbW.prepare('INSERT INTO messages (lead_id, contact_id, company_id, channel, day, msg_type, content, ai_original, status) VALUES (?,?,?,?,?,?,?,?,?)').run(null, contact.id, companyId, tpl.channel, tpl.day, tpl.type, content, content, 'pending');
    dbW.close();
    results.push({ id: r.lastInsertRowid, channel: tpl.channel, day: tpl.day, content, status: 'pending', approved: 0, contact_name: contact.name });
  }

  const dbU = getDb();
  dbU.prepare("UPDATE companies SET status='sequence_created' WHERE id=?").run(companyId);
  dbU.close();

  return { company_name: company.name, contact_name: contact.name, sequence: results };
}

app.post('/api/companies/bulk-sequence', async (req, res) => {
  const { targets, product_value: globalProduct } = req.body;
  if (!Array.isArray(targets) || !targets.length) {
    return res.status(400).json({ error: 'Nenhum lead selecionado' });
  }

  const results = [];
  const errors = [];

  for (const t of targets) {
    const product = (t.product_value || globalProduct || 'solução de automação de vendas com IA').trim();
    const pain = (t.pain_point || t.selected_pain_point || '').trim();
    try {
      const r = await generateSequenceForCompany(t.company_id, product, pain);
      results.push({ ...r, company_id: t.company_id, product_value: product, selected_pain_point: pain });
    } catch (e) {
      errors.push({ company_id: t.company_id, error: e.message });
    }
  }

  res.json({ results, errors });
});



// ── Bulk sequence com SSE (progresso por lead em tempo real) ─────────────────
app.post('/api/companies/bulk-sequence-stream', async (req, res) => {
  const { targets, product_value: globalProduct } = req.body;
  if (!Array.isArray(targets) || !targets.length) {
    return res.status(400).json({ error: 'Nenhum lead selecionado' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

  const results = [];
  const errors  = [];
  const total   = targets.length;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const product = ((t.product_value || globalProduct || 'solucao de automacao de vendas com IA')).trim();
    const pain    = ((t.pain_point || t.selected_pain_point || '')).trim();

    // Buscar nome da empresa para mostrar no progresso
    const dbP = getDb();
    const companyName = dbP.prepare('SELECT name FROM companies WHERE id=?').get(t.company_id)?.name || ('Empresa #' + t.company_id);
    dbP.close();

    send({ type: 'progress', done: i, total, company_name: companyName });

    try {
      const r = await generateSequenceForCompany(t.company_id, product, pain);
      results.push({ ...r, company_id: t.company_id, product_value: product, selected_pain_point: pain });
    } catch (e) {
      errors.push({ company_id: t.company_id, company_name: companyName, error: e.message });
    }
  }

  send({ type: 'done', results, errors });
  res.end();
});

// ── Propensity scoring ────────────────────────────────────────────────────────
app.post('/api/companies/propensity', async (req, res) => {
  const { company_ids, product } = req.body;
  if (!Array.isArray(company_ids) || !company_ids.length) {
    return res.status(400).json({ error: 'Nenhuma empresa selecionada' });
  }
  const db = getDb();
  const companies = company_ids.map(id => {
    const comp = db.prepare('SELECT * FROM companies WHERE id=?').get(id);
    if (!comp) return null;
    const contact = db.prepare('SELECT * FROM contacts WHERE company_id=? ORDER BY is_primary DESC LIMIT 1').get(id);
    return { id, name: comp.name, sector: comp.sector || 'nao informado',
             notes: comp.notes || '', contact_role: contact ? contact.role : 'nao informado',
             contact_name: contact ? contact.name : '' };
  }).filter(Boolean);
  db.close();
  if (!companies.length) return res.status(404).json({ error: 'Empresas nao encontradas' });

  const block = companies.map(c =>
    'ID ' + c.id + ': ' + c.name + ' | Setor: ' + c.sector + ' | Cargo: ' + c.contact_role + ' | Notas: ' + c.notes.substring(0, 100)
  ).join('\n');

  const prompt = 'Produto sendo vendido: ' + product + '\n\nAvalie as seguintes empresas pela propensao de compra desse produto.\n\nEmpresas:\n' + block + '\n\nResposta APENAS em JSON valido:\n{"rankings":[{"company_id":N,"propensity_score":N,"reason":"frase curta","pain_points":["dor 1","dor 2","dor 3"]}]}\n\nOrdene do maior para o menor score. Inclua TODAS as ' + companies.length + ' empresas.';

  const raw = await callClaude('Voce e especialista em qualificacao de leads B2B com foco em propensao de compra.', prompt, 1500);
  let parsed;
  try {
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    parsed = JSON.parse(clean);
  } catch(e) {
    return res.status(500).json({ error: 'Erro ao processar resposta do LLM', raw });
  }
  const idMap = {};
  companies.forEach(c => { idMap[c.id] = c; });
  (parsed.rankings || []).forEach(r => {
    const info = idMap[r.company_id];
    if (info) { r.company_name = info.name; r.contact_name = info.contact_name; r.sector = info.sector; }
  });
  res.json({ product, rankings: parsed.rankings || [] });
});

app.post('/api/companies/:id/simulator/inbound', async (req, res) => {
  const { response_text, contact_id } = req.body;
  const companyId = req.params.id;
  const db = getDb();
  const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(contact_id);
  if (!contact) { db.close(); return res.status(404).json({ error: 'Contato não encontrado' }); }

  // 1. Abre a janela de 24h
  db.prepare("UPDATE contacts SET last_wa_interaction = datetime('now') WHERE id=?").run(contact_id);

  // 2. Insere a mensagem recebida no banco como recebida
  db.prepare(
    "INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, approved) VALUES (?, ?, 'whatsapp', 1, 'text', ?, ?, 'received', 1)"
  ).run(contact_id, companyId, response_text, response_text);
  db.close();

  // 3. Roda a classificação de sentimento da IA e gera o rascunho de resposta automática
  const prompt = `
Mensagem recebida do prospect: "${response_text}"
Classifique e responda APENAS em JSON válido:
{"sentiment": "interested"|"technical_question"|"negative"|"out_of_scope",
 "reasoning": "explicação em 1 frase",
 "interest_score": 1-10}`;

  const result = await callClaude('Você é classificador de intenção em vendas B2B.', prompt, 200);
  let sentiment, reasoning, iscore;
  try { const p = JSON.parse(result); sentiment = p.sentiment; reasoning = p.reasoning; iscore = parseInt(p.interest_score) || 5; }
  catch { sentiment = 'out_of_scope'; reasoning = result; iscore = 5; }

  const db2 = getDb();
  db2.prepare('INSERT INTO sentiment_logs (lead_id, contact_id, company_id, response_text, sentiment, reasoning, interest_score) VALUES (?,?,?,?,?,?,?)').run(null, contact_id, companyId, response_text, sentiment, reasoning, iscore);
  const statusMap = { interested: 'hot_lead', technical_question: 'needs_followup', negative: 'rejected', out_of_scope: 'contacted' };
  db2.prepare('UPDATE companies SET status=?,interest_score=? WHERE id=?').run(statusMap[sentiment] || 'contacted', iscore, companyId);
  db2.close();

  // 4. Se for sentimento positivo, gera um rascunho de resposta e insere na fila de messages pendentes do CRM!
  if (sentiment === 'interested' || sentiment === 'technical_question') {
    const draftPrompt = sentiment === 'technical_question'
      ? `O prospect enviou: "${response_text}"\nEle tem uma dúvida técnica. Escreva uma resposta curta (máx 80 palavras) que responda de forma objetiva e convide para uma conversa de 15 minutos para aprofundar. Tom consultivo.`
      : `O prospect enviou: "${response_text}"\nEle demonstrou interesse. Escreva uma resposta curta (máx 60 palavras) que confirme o interesse e proponha uma reunião de 15 minutos. Tom entusiasmado mas profissional.`;
    const draft_reply = await callClaude('Você é SDR especialista em respostas rápidas para prospects interessados.', draftPrompt, 200);

    const db3 = getDb();
    db3.prepare(
      "INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, approved) VALUES (?, ?, 'whatsapp', 1, 'text', ?, ?, 'pending', 0)"
    ).run(contact_id, companyId, draft_reply, draft_reply);
    db3.close();
  }

  res.json({ ok: true, sentiment, interest_score: iscore });
});

app.post('/api/companies/:id/response', async (req, res) => {
  const { response_text, contact_id } = req.body;
  const db = getDb();
  db.prepare("UPDATE messages SET status='paused' WHERE company_id=? AND status='pending'").run(req.params.id);
  db.close();

  const prompt = `
Mensagem recebida do prospect: "${response_text}"
Classifique e responda APENAS em JSON válido:
{"sentiment": "interested"|"technical_question"|"negative"|"out_of_scope",
 "reasoning": "explicação em 1 frase",
 "interest_score": 1-10}`;

  const result = await callClaude('Você é classificador de intenção em vendas B2B.', prompt, 200);
  let sentiment, reasoning, iscore;
  try { const p = JSON.parse(result); sentiment = p.sentiment; reasoning = p.reasoning; iscore = parseInt(p.interest_score) || 5; }
  catch { sentiment = 'out_of_scope'; reasoning = result; iscore = 5; }

  const db2 = getDb();
  db2.prepare('INSERT INTO sentiment_logs (lead_id, contact_id, company_id, response_text, sentiment, reasoning, interest_score) VALUES (?,?,?,?,?,?,?)').run(contact_id || null, contact_id || null, req.params.id, response_text, sentiment, reasoning, iscore);
  const statusMap = { interested: 'hot_lead', technical_question: 'needs_followup', negative: 'rejected', out_of_scope: 'contacted' };
  db2.prepare('UPDATE companies SET status=?,interest_score=? WHERE id=?').run(statusMap[sentiment] || 'contacted', iscore, req.params.id);
  db2.close();

  // Gerar rascunho de resposta para sentimentos positivos
  let draft_reply = null;
  if (sentiment === 'interested' || sentiment === 'technical_question') {
    const draftPrompt = sentiment === 'technical_question'
      ? `O prospect enviou: "${response_text}"\nEle tem uma dúvida técnica. Escreva uma resposta curta (máx 80 palavras) que responda de forma objetiva e convide para uma conversa de 15 minutos para aprofundar. Tom consultivo.`
      : `O prospect enviou: "${response_text}"\nEle demonstrou interesse. Escreva uma resposta curta (máx 60 palavras) que confirme o interesse e proponha uma reunião de 15 minutos. Tom entusiasmado mas profissional.`;
    draft_reply = await callClaude('Você é SDR especialista em respostas rápidas para prospects interessados.', draftPrompt, 200);
  }

  res.json({ sentiment, reasoning, interest_score: iscore, handon_required: sentiment === 'interested' && iscore >= 7, sequence_paused: true, draft_reply });
});

app.post('/api/companies/:id/optout', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE companies SET opted_out=1,status='opted_out' WHERE id=?").run(req.params.id);
  db.prepare('UPDATE contacts SET opted_out=1 WHERE company_id=?').run(req.params.id);
  db.prepare("UPDATE messages SET status='cancelled' WHERE company_id=? AND status IN ('pending','approved')").run(req.params.id);
  db.prepare('INSERT INTO consent_logs (company_id, action, details) VALUES (?,?,?)').run(req.params.id, 'opted_out', 'Opt-out solicitado — empresa e todos os contatos removidos de todas as cadências (LGPD)');
  db.close();
  res.json({ ok: true });
});

// ── Opportunities (Melhoria 1) ────────────────────────────────────────────────
const VALID_STAGES = ['prospecting', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];

app.get('/api/opportunities', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT o.*, c.name as company_name, c.sector as company_sector
    FROM opportunities o
    LEFT JOIN companies c ON o.company_id = c.id
    ORDER BY o.created_at DESC
  `).all();
  db.close();
  res.json(rows);
});

app.post('/api/opportunities', (req, res) => {
  const { company_id, name, stage, value, notes } = req.body;
  if (!company_id || !name) return res.status(400).json({ error: 'company_id e name são obrigatórios' });
  const stageVal = VALID_STAGES.includes(stage) ? stage : 'prospecting';
  const db = getDb();
  const company = db.prepare('SELECT id FROM companies WHERE id=?').get(company_id);
  if (!company) { db.close(); return res.status(404).json({ error: 'Empresa não encontrada' }); }
  const r = db.prepare('INSERT INTO opportunities (company_id, name, stage, value, notes) VALUES (?,?,?,?,?)').run(company_id, name, stageVal, value || 0, notes || '');
  db.close();
  res.json({ id: r.lastInsertRowid });
});

app.get('/api/opportunities/:id', (req, res) => {
  const db = getDb();
  const opp = db.prepare(`
    SELECT o.*, c.name as company_name
    FROM opportunities o LEFT JOIN companies c ON o.company_id=c.id
    WHERE o.id=?
  `).get(req.params.id);
  db.close();
  if (!opp) return res.status(404).json({ error: 'Oportunidade não encontrada' });
  res.json(opp);
});

app.patch('/api/opportunities/:id', (req, res) => {
  const { name, stage, value, notes, lost_reason, lost_competitor, lost_notes } = req.body;
  const db = getDb();
  const opp = db.prepare('SELECT * FROM opportunities WHERE id=?').get(req.params.id);
  if (!opp) { db.close(); return res.status(404).json({ error: 'Oportunidade não encontrada' }); }
  const stageVal = stage && VALID_STAGES.includes(stage) ? stage : opp.stage;
  db.prepare('UPDATE opportunities SET name=?, stage=?, value=?, notes=?, lost_reason=?, lost_competitor=?, lost_notes=? WHERE id=?').run(
    name || opp.name,
    stageVal,
    value !== undefined ? value : opp.value,
    notes !== undefined ? notes : opp.notes,
    lost_reason !== undefined ? lost_reason : (opp.lost_reason || ''),
    lost_competitor !== undefined ? lost_competitor : (opp.lost_competitor || ''),
    lost_notes !== undefined ? lost_notes : (opp.lost_notes || ''),
    req.params.id
  );
  db.close();
  res.json({ ok: true });
});

app.delete('/api/opportunities/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM opportunities WHERE id=?').run(req.params.id);
  db.close();
  res.json({ ok: true });
});

app.get('/api/companies/:id/opportunities', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM opportunities WHERE company_id=? ORDER BY created_at DESC').all(req.params.id);
  db.close();
  res.json(rows);
});

// Messages
app.post('/api/messages/:id/approve', async (req, res) => {
  const db = getDb();
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);
  if (!msg) {
    db.close();
    return res.status(404).json({ error: 'Mensagem não encontrada' });
  }

  if (msg.channel === 'whatsapp') {
    let whatsappNum = null;
    let contactId = null;
    let contactType = null;

    if (msg.contact_id) {
      const contact = db.prepare('SELECT id, whatsapp FROM contacts WHERE id=?').get(msg.contact_id);
      if (contact) {
        whatsappNum = contact.whatsapp;
        contactId = contact.id;
        contactType = 'contact';
      }
    } else if (msg.lead_id) {
      const lead = db.prepare('SELECT id, whatsapp FROM leads WHERE id=?').get(msg.lead_id);
      if (lead) {
        whatsappNum = lead.whatsapp;
        contactId = lead.id;
        contactType = 'lead';
      }
    }

    if (whatsappNum) {
      const dbRef = {
        type: contactType,
        id: contactId,
        forceTemplate: false
      };

      // Verifica se a janela de 24h está aberta
      const table = contactType === 'contact' ? 'contacts' : 'leads';
      const c = db.prepare(`SELECT last_wa_interaction FROM ${table} WHERE id = ?`).get(contactId);
      let windowOpen = false;
      if (c && c.last_wa_interaction) {
        const lastInt = new Date(c.last_wa_interaction);
        const diffHrs = (new Date() - lastInt) / (1000 * 60 * 60);
        if (diffHrs < 24) windowOpen = true;
      }

      if (!windowOpen) {
        // Se a janela estiver fechada, forçamos o hello_world (sandbox da Meta)
        dbRef.forceTemplate = true;
        dbRef.templateName = 'hello_world';
      }

      const success = await sendWhatsAppMessage(whatsappNum, msg.content, dbRef);
      if (!success) {
        db.close();
        return res.status(500).json({ error: 'Erro ao enviar WhatsApp. O número do destinatário está verificado na Meta e o token está válido?' });
      }
    }
  }

  db.prepare("UPDATE messages SET approved=1,status='approved' WHERE id=?").run(req.params.id);
  db.close();
  res.json({ ok: true });
});

app.post('/api/messages/:id/score', (req, res) => {
  const score = parseInt(req.body.score);
  if (!score || score < 1 || score > 5) return res.status(400).json({ error: 'Score 1–5' });
  const db = getDb();
  db.prepare('UPDATE messages SET score=? WHERE id=?').run(score, req.params.id);
  db.close();
  res.json({ ok: true });
});

app.post('/api/messages/:id/correct', (req, res) => {
  const correction = req.body.correction || '';
  const db = getDb();
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);
  if (!msg) { db.close(); return res.status(404).json({ error: 'Não encontrada' }); }
  db.prepare('UPDATE messages SET human_correction=?,content=? WHERE id=?').run(correction, correction, req.params.id);
  db.close();
  res.json({ ok: true, original: msg.ai_original, correction });
});

app.post('/api/messages/:id/send', (req, res) => {
  const db = getDb();
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);
  if (!msg) { db.close(); return res.status(404).json({ error: 'Não encontrada' }); }
  db.prepare("UPDATE messages SET status='sent' WHERE id=?").run(req.params.id);
  if (msg.company_id) {
    db.prepare("UPDATE companies SET status='contacted' WHERE id=? AND status NOT IN ('hot_lead','meeting_set')").run(msg.company_id);
  }
  db.close();
  const delays = { linkedin: '2–4 min', email: '0–30 seg', whatsapp: '1–3 min' };
  res.json({ ok: true, simulated_delay: delays[msg.channel] || '1–2 min', note: 'Delay simulado' });
});

// Documents
app.get('/api/documents', (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT id,name,created_at,length(content) as size FROM documents ORDER BY created_at DESC').all());
  db.close();
});

app.post('/api/documents', (req, res) => {
  const db = getDb();
  const r = db.prepare('INSERT INTO documents (name,content) VALUES (?,?)').run(req.body.name, req.body.content);
  db.close();
  res.json({ id: r.lastInsertRowid });
});

app.delete('/api/documents/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM documents WHERE id=?').run(req.params.id);
  db.close();
  res.json({ ok: true });
});

// RAG
app.post('/api/rag/query', async (req, res) => {
  const { query, storytelling } = req.body;
  const db = getDb();
  const docs = db.prepare('SELECT name,content FROM documents').all();
  db.close();
  if (!docs.length) return res.json({ answer: 'Nenhum documento carregado.' });

  const docsText = docs.map(d => `[${d.name}]\n${d.content.substring(0, 2000)}`).join('\n\n---\n\n');
  const system = storytelling
    ? 'Você converte dados técnicos em benefícios de negócio (ROI, economia). Use números concretos.'
    : 'Você é especialista técnico. Responda baseando-se APENAS nos documentos fornecidos.';
  const prompt = storytelling
    ? `Documentos:\n${docsText}\n\nTema: ${query}\n\nConverta em benefícios de negócio.`
    : `Documentos:\n${docsText}\n\nPergunta: ${query}`;

  const answer = await callClaude(system, prompt, 600);
  res.json({ answer, docs_used: docs.map(d => d.name) });
});

// Golden Cases
app.get('/api/golden-cases', (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM golden_cases ORDER BY score DESC, created_at DESC').all());
  db.close();
});

app.post('/api/golden-cases', (req, res) => {
  const db = getDb();
  const r = db.prepare('INSERT INTO golden_cases (title,context,content,score) VALUES (?,?,?,?)').run(req.body.title, req.body.context || '', req.body.content, req.body.score || 5);
  db.close();
  res.json({ id: r.lastInsertRowid });
});

app.delete('/api/golden-cases/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM golden_cases WHERE id=?').run(req.params.id);
  db.close();
  res.json({ ok: true });
});

// Schedule
app.get('/api/schedule/slots', (req, res) => {
  const db = getDb();
  res.json(db.prepare(`
    SELECT s.*, co.name as company_name, co.sector as company_sector, ct.name as contact_name
    FROM schedule_slots s
    LEFT JOIN companies co ON s.company_id = co.id
    LEFT JOIN contacts ct ON s.contact_id = ct.id
    ORDER BY s.date_time
  `).all());
  db.close();
});

app.post('/api/schedule/slots', (req, res) => {
  const db = getDb();
  const r = db.prepare('INSERT INTO schedule_slots (date_time,duration_min,meeting_link) VALUES (?,?,?)').run(req.body.date_time, req.body.duration_min || 15, req.body.meeting_link || '');
  db.close();
  res.json({ id: r.lastInsertRowid });
});

app.post('/api/schedule/slots/:id/book', (req, res) => {
  const db = getDb();
  const slot = db.prepare('SELECT * FROM schedule_slots WHERE id=?').get(req.params.id);
  if (!slot) { db.close(); return res.status(404).json({ error: 'Slot não encontrado' }); }
  if (slot.booked) { db.close(); return res.status(409).json({ error: 'Slot já reservado' }); }
  const { company_id, contact_id } = req.body;
  db.prepare('UPDATE schedule_slots SET booked=1,company_id=?,contact_id=? WHERE id=?').run(company_id || null, contact_id || null, req.params.id);
  if (company_id) {
    db.prepare("UPDATE companies SET status='meeting_set' WHERE id=?").run(company_id);
    db.prepare('INSERT INTO consent_logs (company_id, contact_id, action, details) VALUES (?,?,?,?)').run(company_id, contact_id || null, 'meeting_booked', `Reunião agendada: ${slot.date_time}`);
  }
  db.close();
  res.json({ ok: true, date_time: slot.date_time, meeting_link: slot.meeting_link });
});

app.delete('/api/schedule/slots/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM schedule_slots WHERE id=?').run(req.params.id);
  db.close();
  res.json({ ok: true });
});

// LGPD consent logs
app.get('/api/consent-logs', (req, res) => {
  const db = getDb();
  res.json(db.prepare(`
    SELECT cl.*, co.name as company_name, co.sector, ct.name as contact_name
    FROM consent_logs cl
    LEFT JOIN companies co ON cl.company_id = co.id
    LEFT JOIN contacts ct ON cl.contact_id = ct.id
    ORDER BY cl.created_at DESC LIMIT 200
  `).all());
  db.close();
});

// RLHF
app.get('/api/rlhf/queue', (req, res) => {
  const db = getDb();
  res.json(db.prepare(`
    SELECT m.*, co.name as company_name, co.sector as company_sector, ct.name as contact_name, ct.role as contact_role
    FROM messages m
    LEFT JOIN companies co ON m.company_id = co.id
    LEFT JOIN contacts ct ON m.contact_id = ct.id
    WHERE m.approved=0 AND m.status='pending'
    ORDER BY m.id DESC
  `).all());
  db.close();
});

// Gerenciamento de usuários
app.get('/api/users', (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT id, username, name, created_at FROM users ORDER BY created_at DESC').all());
  db.close();
});

app.post('/api/users', (req, res) => {
  const { username, password, name } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  const db = getDb();
  const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (exists) { db.close(); return res.status(409).json({ error: 'Usuário já existe' }); }
  const hash = bcrypt.hashSync(password, 10);
  const r = db.prepare('INSERT INTO users (username, password, name) VALUES (?,?,?)').run(username, hash, name || '');
  db.close();
  res.json({ id: r.lastInsertRowid });
});

app.delete('/api/users/:id', (req, res) => {
  if (parseInt(req.params.id) === req.session.userId) return res.status(400).json({ error: 'Não é possível remover o próprio usuário' });
  const db = getDb();
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  db.close();
  res.json({ ok: true });
});

// ── Verificação de APIs no startup ───────────────────────────────────────────
function checkApis() {
  const anthropic = process.env.ANTHROPIC_API_KEY;
  const apollo    = process.env.APOLLO_API_KEY;

  if (!anthropic || anthropic.trim() === '') {
    console.warn('\x1b[33m⚠️  ANTHROPIC_API_KEY não configurada — pesquisa e sequências de IA desativadas\x1b[0m');
  } else {
    console.log('\x1b[32m✅ ANTHROPIC_API_KEY configurada\x1b[0m');
  }

  if (!apollo || apollo.trim() === '') {
    console.log('\x1b[36mℹ️  APOLLO_API_KEY não configurada — enriquecimento usará apenas estimativa por IA (Claude)\x1b[0m');
  } else {
    console.log('\x1b[32m✅ APOLLO_API_KEY configurada\x1b[0m');
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
initDb();
checkApis();

// ── Métricas (Feature 7) ───────────────────────────────────────────────────────
app.get('/api/metrics/overview', (req, res) => {
  const db = getDb();
  const by_channel = db.prepare("SELECT channel, COUNT(*) as total, SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) as sent, ROUND(AVG(CASE WHEN score IS NOT NULL THEN score * 20 ELSE 0 END), 0) as response_rate FROM messages GROUP BY channel").all();
  const by_role = db.prepare("SELECT role, COUNT(*) as total FROM contacts GROUP BY role").all();
  const funnel = db.prepare("SELECT status, COUNT(*) as total FROM companies GROUP BY status").all();
  db.close();
  res.json({ by_channel, by_role, funnel, ab_stats: { decided: 0, b_won: 0 } });
});

app.get('/api/metrics/timing', (req, res) => {
  res.json([]);
});

// ── Follow-up (Feature 6) ─────────────────────────────────────────────────────
app.get('/api/followup/pending', (req, res) => {
  const days = parseInt(req.query.days || 5);
  const db = getDb();
  const rows = db.prepare(`
    SELECT ct.id, ct.name, ct.role, c.name as company, c.sector, 
      CAST(julianday('now') - julianday(c.created_at) AS INTEGER) as days_since
    FROM contacts ct
    JOIN companies c ON c.id = ct.company_id
    WHERE c.status NOT IN ('hot_lead', 'meeting_set', 'opted_out', 'rejected')
      AND CAST(julianday('now') - julianday(c.created_at) AS INTEGER) >= ?
    ORDER BY days_since DESC LIMIT 50
  `).all(days);
  db.close();
  res.json(rows);
});

app.post('/api/followup/:id/generate', (req, res) => {
  const channel = req.body.channel || 'email';
  const db = getDb();
  const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(req.params.id);
  if(!contact) { db.close(); return res.status(404).json({error: 'Not found'}); }
  const content = `Follow up automático via ${channel} para ${contact.name}...`;
  db.prepare("INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, approved) VALUES (?,?,?,?,?,?,?,'pending',0)")
    .run(contact.id, contact.company_id, channel, 5, 'follow_up', content, content);
  db.close();
  res.json({ ok: true });
});

// Catch-all route to serve React frontend for non-API requests
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Sales AI Agent rodando em http://localhost:${PORT}`);
  console.log(`Login: admin / admin123`);
});
