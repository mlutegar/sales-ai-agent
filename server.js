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

// Chave de deduplicação de empresa: ignora acentos, caixa e espaços,
// para que "Itaú", "Itau" e "ITAÚ " sejam tratados como a mesma empresa.
function normalizeCompanyKey(name) {
  return String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
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
    CREATE TABLE IF NOT EXISTS learned_patterns (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      channel     TEXT,
      role        TEXT,
      pattern     TEXT,
      confidence  REAL    DEFAULT 0.5,
      sample_size INTEGER DEFAULT 0,
      created_at  TEXT    DEFAULT (datetime('now'))
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
    CREATE TABLE IF NOT EXISTS company_flags (
      company_id INTEGER NOT NULL,
      flag       TEXT    NOT NULL,
      created_at TEXT    DEFAULT (datetime('now')),
      PRIMARY KEY (company_id, flag),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_email    ON contacts(email);
    CREATE INDEX IF NOT EXISTS idx_contacts_name     ON contacts(name);
    CREATE INDEX IF NOT EXISTS idx_company_flags_flag ON company_flags(flag);
  `);

  // Migração: remover NOT NULL de messages.lead_id se necessário (schema antigo tinha NOT NULL)
  try {
    const msgCols = db.prepare("PRAGMA table_info(messages)").all();
    const leadIdCol = msgCols.find(c => c.name === 'lead_id');
    if (leadIdCol && leadIdCol.notnull) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages_v2 (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          lead_id          INTEGER,
          contact_id       INTEGER REFERENCES contacts(id),
          company_id       INTEGER REFERENCES companies(id),
          channel          TEXT    NOT NULL,
          day              INTEGER NOT NULL,
          msg_type         TEXT,
          content          TEXT,
          ai_original      TEXT,
          human_correction TEXT,
          score            INTEGER,
          status           TEXT    DEFAULT 'pending',
          approved         INTEGER DEFAULT 0,
          is_template      INTEGER DEFAULT 0,
          template_name    TEXT
        );
        INSERT INTO messages_v2 (id,lead_id,contact_id,company_id,channel,day,msg_type,content,ai_original,human_correction,score,status,approved)
          SELECT id,lead_id,contact_id,company_id,channel,day,msg_type,content,ai_original,human_correction,score,status,approved FROM messages;
        DROP TABLE messages;
        ALTER TABLE messages_v2 RENAME TO messages;
      `);
      console.log('✅ Migração messages.lead_id → nullable concluída');
    }
  } catch(e) {
    console.error('⚠️  Migração messages lead_id falhou (não crítico):', e.message);
  }

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
  addColumnIfNotExists(db, 'messages', 'is_template',  "INTEGER DEFAULT 0");
  addColumnIfNotExists(db, 'messages', 'template_name',"TEXT");
  addColumnIfNotExists(db, 'messages', 'created_at',   "TEXT");
  addColumnIfNotExists(db, 'messages', 'score_comment',"TEXT");
  addColumnIfNotExists(db, 'messages', 'prompt_used',  "TEXT");
  addColumnIfNotExists(db, 'messages', 'comment_scope',"TEXT DEFAULT 'global'");

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

  // ── Notifications & auto-reply ──────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES contacts(id)  ON DELETE SET NULL,
      message_id INTEGER REFERENCES messages(id)  ON DELETE SET NULL,
      type       TEXT    DEFAULT 'message',
      title      TEXT    NOT NULL,
      body       TEXT    DEFAULT '',
      read       INTEGER DEFAULT 0,
      created_at TEXT    DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
  `);
  addColumnIfNotExists(db, 'companies', 'auto_reply_mode', "TEXT DEFAULT 'off'");

  // Colunas de enriquecimento de contatos
  addColumnIfNotExists(db, 'contacts', 'enrich_status', "TEXT DEFAULT 'pending'");
  addColumnIfNotExists(db, 'contacts', 'enrich_source', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'contacts', 'enrich_at',     "TEXT DEFAULT ''");

  // Rastreamento de origem da importação
  addColumnIfNotExists(db, 'contacts',  'import_source', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'companies', 'import_source', "TEXT DEFAULT ''");

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
  const body = req.body;

  if (!body.object) return res.sendStatus(404);

  const change = body.entry?.[0]?.changes?.[0];
  const msg    = change?.value?.messages?.[0];
  if (!msg || msg.type !== 'text') return res.sendStatus(200);

  // Responde Meta imediatamente (evita timeout/retry)
  res.sendStatus(200);

  // Processa de forma assíncrona
  (async () => {
    try {
      const phone = msg.from;
      const text  = msg.text.body;

      const db = getDb();
      const contact = db.prepare(
        'SELECT c.*, co.auto_reply_mode, co.name as company_name FROM contacts c JOIN companies co ON c.company_id=co.id WHERE c.whatsapp LIKE ? LIMIT 1'
      ).get(`%${phone}%`);

      if (!contact) {
        console.log(`[WhatsApp Webhook] Número desconhecido: ${phone}`);
        db.close();
        return;
      }

      // 1. Abre janela de 24h
      db.prepare("UPDATE contacts SET last_wa_interaction=datetime('now') WHERE id=?").run(contact.id);

      // 2. Salva mensagem recebida
      const ins = db.prepare(
        "INSERT INTO messages (contact_id,company_id,channel,day,msg_type,content,ai_original,status,approved,created_at) VALUES (?,?,'whatsapp',1,'text',?,?,'received',1,datetime('now'))"
      ).run(contact.id, contact.company_id, text, text);
      const messageId = ins.lastInsertRowid;
      db.close();

      // 3. Classificação de sentimento via IA
      const sentPrompt = `
Mensagem recebida do prospect: "${text}"
Classifique e responda APENAS em JSON válido:
{"sentiment":"interested"|"technical_question"|"negative"|"out_of_scope"|"wants_meeting",
 "reasoning":"explicação em 1 frase",
 "interest_score":1-10}
Nota: use "wants_meeting" quando o prospect pede para marcar reunião, ligar, ou agendar algo.`;

      const sentResult = await callClaude('Você é classificador de intenção em vendas B2B.', sentPrompt, 200);
      let sentiment = 'out_of_scope', reasoning = '', iscore = 5;
      try {
        const p = JSON.parse(extractJsonLoose(sentResult));
        sentiment = p.sentiment; reasoning = p.reasoning; iscore = parseInt(p.interest_score) || 5;
      } catch {}

      const db2 = getDb();
      db2.prepare('INSERT INTO sentiment_logs (contact_id,company_id,response_text,sentiment,reasoning,interest_score) VALUES (?,?,?,?,?,?)')
        .run(contact.id, contact.company_id, text, sentiment, reasoning, iscore);

      const statusMap = { interested:'hot_lead', technical_question:'needs_followup', negative:'rejected', out_of_scope:'contacted', wants_meeting:'hot_lead' };
      db2.prepare('UPDATE companies SET status=?,interest_score=? WHERE id=?').run(statusMap[sentiment]||'contacted', iscore, contact.company_id);

      // 4. Cria notificação
      const sentLabels = { interested:'🔥 Interessado', technical_question:'🤔 Dúvida técnica', negative:'👎 Negativo', out_of_scope:'↗ Fora de escopo', wants_meeting:'📅 Quer agendar reunião' };
      const notifType  = sentiment === 'wants_meeting' ? 'meeting_request' : 'message';
      const notifTitle = sentiment === 'wants_meeting'
        ? `📅 ${contact.company_name} quer marcar reunião`
        : `💬 Nova resposta de ${contact.company_name} (${sentLabels[sentiment]||sentiment})`;
      db2.prepare('INSERT INTO notifications (company_id,contact_id,message_id,type,title,body) VALUES (?,?,?,?,?,?)')
        .run(contact.company_id, contact.id, messageId, notifType, notifTitle, text);

      // 5. Auto-reply — só se não for wants_meeting e auto_reply_mode ativo
      const autoMode = contact.auto_reply_mode || 'off';
      if (sentiment !== 'wants_meeting' && autoMode !== 'off') {
        const shouldReply = autoMode === 'all' ||
          (autoMode === 'except_meeting' && sentiment !== 'wants_meeting');

        if (shouldReply && (sentiment === 'interested' || sentiment === 'technical_question')) {
          const draftPrompt = sentiment === 'technical_question'
            ? `O prospect enviou: "${text}"\nDúvida técnica. Responda de forma objetiva (máx 80 palavras) e convide para conversa de 15 minutos. Tom consultivo.`
            : `O prospect enviou: "${text}"\nDemonstrou interesse. Confirme o interesse e proponha reunião de 15 minutos (máx 60 palavras). Tom entusiasmado mas profissional.`;
          const draft = await callClaude('Você é SDR especialista em respostas rápidas.', draftPrompt, 200);

          // Salva draft e envia automaticamente
          db2.prepare(
            "INSERT INTO messages (contact_id,company_id,channel,day,msg_type,content,ai_original,status,approved,created_at) VALUES (?,?,'whatsapp',1,'text',?,?,'sent',1,datetime('now'))"
          ).run(contact.id, contact.company_id, draft, draft);

          await sendWhatsAppMessage(phone, draft);
          console.log(`[WhatsApp Webhook] Auto-reply enviado para ${phone}`);
        }
      }

      db2.close();
      console.log(`[WhatsApp Webhook] ✅ Processado: ${contact.company_name} | sentimento: ${sentiment}`);
    } catch (err) {
      console.error('[WhatsApp Webhook] Erro no processamento assíncrono:', err.message);
    }
  })();
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

// ── Flags/Etiquetas de empresa ────────────────────────────────────────────────
// Catálogo de etiquetas aplicáveis a empresas. `blocks_outreach: true` faz a
// automação (geração de sequência) ser bloqueada para a empresa.
const COMPANY_FLAGS = [
  { key: 'nao_contatar',        label: 'Não contatar',         badge: 'bg-danger',            blocks_outreach: true },
  { key: 'empresa_ja_atendida', label: 'Empresa já atendida',  badge: 'bg-warning text-dark', blocks_outreach: false },
  { key: 'cliente_ativo',       label: 'Cliente ativo',        badge: 'bg-success',           blocks_outreach: false },
];
const FLAG_KEYS = new Set(COMPANY_FLAGS.map(f => f.key));
const BLOCKING_FLAG_KEYS = new Set(COMPANY_FLAGS.filter(f => f.blocks_outreach).map(f => f.key));

function companyFlagKeys(db, id) {
  return new Set(db.prepare('SELECT flag FROM company_flags WHERE company_id=?').all(id).map(r => r.flag));
}
function companyIsBlocked(db, id) {
  for (const k of companyFlagKeys(db, id)) if (BLOCKING_FLAG_KEYS.has(k)) return true;
  return false;
}

// ── Enriquecimento de contatos ────────────────────────────────────────────────

async function enrichWithApollo(contactName, companyName) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return { error: 'APOLLO_API_KEY não configurada' };
  try {
    const res = await fetch('https://api.apollo.io/api/v1/people/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': apiKey },
      body: JSON.stringify({
        name: contactName,
        organization_name: companyName,
        reveal_personal_emails: false,
        reveal_phone_number: true,
      }),
    });
    if (res.status === 429) {
      console.warn('[Apollo] Rate limit atingido (429)');
      return { error: 'Apollo: rate limit atingido (429)' };
    }
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch {}
      console.warn(`[Apollo] Erro HTTP ${res.status}: ${body}`);
      return { error: `Apollo retornou HTTP ${res.status}: ${body}` };
    }
    const data = await res.json();
    const person = data.person;
    if (!person) {
      console.log(`[Apollo] Nenhuma pessoa encontrada para "${contactName}" na empresa "${companyName}"`);
      return { error: 'Apollo: nenhum resultado encontrado para esse contato/empresa' };
    }
    return {
      email:    person.email || '',
      phone:    (person.phone_numbers && person.phone_numbers[0]) ? person.phone_numbers[0].raw_number : '',
      linkedin: person.linkedin_url || '',
      source:   'apollo',
    };
  } catch (e) {
    console.warn('[Apollo] Erro de rede:', e.message);
    return { error: `Apollo: erro de rede — ${e.message}` };
  }
}

async function enrichWithClaudeGuess(contactName, companyName) {
  const prompt = `Nome do contato: "${contactName}"\nEmpresa: "${companyName}"\n\nCom base em padrões comuns de e-mail corporativo brasileiro, gere a sugestão mais provável de e-mail profissional para este contato.\nResponda APENAS com JSON válido, sem markdown:\n{"email": "sugestao@dominio.com.br", "confidence": "low|medium|high", "reasoning": "1 frase"}`;
  try {
    const result = await callClaude(
      'Você infere padrões de e-mail profissional para prospecção B2B. Seja conservador e preciso.',
      prompt, 150
    );
    const p = JSON.parse(extractJsonLoose(result));
    if (p.email && p.email.includes('@')) {
      return { email: p.email, phone: '', linkedin: '', source: 'claude_guess' };
    }
  } catch {}
  return null;
}

// Busca um contato para uma empresa que ainda não tem nenhum (por organização, sem nome)
async function findContactsForCompany(companyName, sector) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return { error: 'APOLLO_API_KEY não configurada' };

  try {
    const res = await fetch('https://api.apollo.io/api/v1/people/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': apiKey },
      body: JSON.stringify({
        organization_name: companyName,
        person_titles: ['CEO', 'Diretor', 'Diretor Comercial', 'Gerente', 'Sócio', 'VP', 'Head', 'Presidente'],
        page: 1,
        per_page: 3,
      }),
    });

    if (res.status === 429) {
      console.warn('[Apollo] Rate limit atingido (429)');
      return { error: 'Apollo: rate limit atingido (429)' };
    }
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch {}
      console.warn(`[Apollo] mixed_people/search HTTP ${res.status}: ${body}`);
      return { error: `Apollo retornou HTTP ${res.status}: ${body}` };
    }

    const data = await res.json();
    const people = (data.people || data.contacts || []);
    if (people.length === 0) {
      console.log(`[Apollo] Nenhum contato encontrado para a empresa "${companyName}"`);
      return { error: `Apollo: nenhum contato encontrado para "${companyName}"` };
    }

    const p = people[0];
    return {
      name:    p.name || ((p.first_name || '') + ' ' + (p.last_name || '')).trim() || '',
      role:    (p.title || p.headline || '').slice(0, 100),
      email:   p.email || '',
      phone:   (p.phone_numbers && p.phone_numbers[0]) ? p.phone_numbers[0].raw_number : '',
      linkedin: p.linkedin_url || '',
      source:  'apollo',
    };
  } catch (e) {
    console.warn('[Apollo] people/search erro de rede:', e.message);
    return { error: `Apollo: erro de rede — ${e.message}` };
  }
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

  const result = await enrichWithApollo(contact.name, companyName);

  db = getDb();
  // Se retornou erro (chave errada, rate limit, etc.) — não tenta Claude, apenas reporta
  if (!result || result.error) {
    const errorMsg = result ? result.error : 'Resposta inesperada do Apollo';
    console.warn(`[enrichContact] Falha Apollo para "${contact.name}" / "${companyName}": ${errorMsg}`);
    db.prepare("UPDATE contacts SET enrich_status='not_found', enrich_source='apollo_error', enrich_at=datetime('now') WHERE id=?").run(contactId);
    db.close();
    return { ok: false, status: 'apollo_error', error: errorMsg };
  }

  if (result.email) {
    db.prepare(`
      UPDATE contacts
      SET email    = CASE WHEN (email IS NULL OR email='')    THEN ? ELSE email    END,
          whatsapp = CASE WHEN (whatsapp IS NULL OR whatsapp='') AND ?!='' THEN ? ELSE whatsapp END,
          linkedin = CASE WHEN (linkedin IS NULL OR linkedin='') AND ?!='' THEN ? ELSE linkedin END,
          enrich_status = 'found',
          enrich_source = 'apollo',
          enrich_at = datetime('now')
      WHERE id = ?
    `).run(
      result.email,
      result.phone || '', result.phone || '',
      result.linkedin || '', result.linkedin || '',
      contactId
    );
    db.close();
    return { ok: true, status: 'found', email: result.email, phone: result.phone || '', linkedin: result.linkedin || '', source: 'apollo' };
  } else {
    db.prepare("UPDATE contacts SET enrich_status='not_found', enrich_source='apollo', enrich_at=datetime('now') WHERE id=?").run(contactId);
    db.close();
    return { ok: false, status: 'not_found', error: 'Apollo encontrou o contato mas sem e-mail disponível' };
  }
}

// Extrai JSON de uma resposta da IA que pode vir embrulhada em ```json``` ou com
// texto antes/depois (o sonnet-4-6 costuma cercar o JSON com markdown).
function extractJsonLoose(s) {
  let raw = (s || '').replace(/```json\s*|\s*```/g, '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  return m ? m[0] : raw;
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

// Variante com BUSCA WEB REAL (ferramenta nativa do Claude). Usada na pesquisa de
// prospecção para fundamentar os ganchos em informações reais e atuais da empresa.
// Em qualquer falha/indisponibilidade, faz fallback para callClaude (sem busca).
async function callClaudeWithSearch(systemPrompt, userPrompt, maxTokens = 1500) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'sk-ant-sua-chave-aqui') return callClaude(systemPrompt, userPrompt, maxTokens);
  let messages = [{ role: 'user', content: userPrompt }];
  try {
    for (let iter = 0; iter < 5; iter++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: maxTokens,
          system: systemPrompt,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
          messages,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ? data.error.message : 'Erro na requisição');
      // Loop server-side da ferramenta: se pausou, devolve o conteúdo e continua.
      if (data.stop_reason === 'pause_turn') {
        messages = [...messages, { role: 'assistant', content: data.content }];
        continue;
      }
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return text || callClaude(systemPrompt, userPrompt, maxTokens);
    }
    return callClaude(systemPrompt, userPrompt, maxTokens);
  } catch (e) {
    console.warn('[web_search] indisponível, usando pesquisa sem busca:', e.message);
    return callClaude(systemPrompt, userPrompt, maxTokens);
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
    avg_score:           db.prepare('SELECT ROUND(AVG(interest_score),1) as a FROM companies WHERE interest_score IS NOT NULL AND interest_score > 0').get().a,
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
      GROUP_CONCAT(ct.name || ' (' || ct.role || ')', '||') as contacts_summary,
      (SELECT GROUP_CONCAT(cf.flag) FROM company_flags cf WHERE cf.company_id=c.id) as flags
    FROM companies c
    LEFT JOIN contacts ct ON ct.company_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `).all();

  for (const row of rows) {
    row.contacts = db.prepare('SELECT * FROM contacts WHERE company_id=? ORDER BY is_primary DESC, created_at ASC').all(row.id);
    row.flags = row.flags ? row.flags.split(',') : [];
  }

  db.close();
  res.json(rows);
});

// ── Flags/Etiquetas ───────────────────────────────────────────────────────────
// Catálogo de etiquetas disponíveis para empresas.
app.get('/api/flags', (req, res) => {
  res.json(COMPANY_FLAGS);
});

// Aplica uma etiqueta a uma empresa.
app.post('/api/companies/:id/flags', (req, res) => {
  const flag = (req.body.flag || '').toString().trim();
  if (!FLAG_KEYS.has(flag)) return res.status(400).json({ error: 'Etiqueta inválida' });
  const db = getDb();
  const comp = db.prepare('SELECT id, name FROM companies WHERE id=?').get(req.params.id);
  if (!comp) { db.close(); return res.status(404).json({ error: 'Empresa não encontrada' }); }
  db.prepare('INSERT OR IGNORE INTO company_flags (company_id, flag) VALUES (?,?)').run(comp.id, flag);
  db.prepare('INSERT INTO consent_logs (company_id, action, details) VALUES (?,?,?)')
    .run(comp.id, 'flag_added', `Etiqueta "${flag}" aplicada`);
  const flags = [...companyFlagKeys(db, comp.id)];
  db.close();
  res.json({ ok: true, flags });
});

// Remove uma etiqueta de uma empresa.
app.delete('/api/companies/:id/flags/:flag', (req, res) => {
  const db = getDb();
  const comp = db.prepare('SELECT id FROM companies WHERE id=?').get(req.params.id);
  if (!comp) { db.close(); return res.status(404).json({ error: 'Empresa não encontrada' }); }
  db.prepare('DELETE FROM company_flags WHERE company_id=? AND flag=?').run(comp.id, req.params.flag);
  db.prepare('INSERT INTO consent_logs (company_id, action, details) VALUES (?,?,?)')
    .run(comp.id, 'flag_removed', `Etiqueta "${req.params.flag}" removida`);
  const flags = [...companyFlagKeys(db, comp.id)];
  db.close();
  res.json({ ok: true, flags });
});

app.post('/api/companies', (req, res) => {
  const { name, sector, contact_name, contact_role, contact_email, contact_linkedin, contact_whatsapp } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome da empresa é obrigatório' });
  const db = getDb();
  // Deduplicação por chave normalizada (ignora acento/caixa/espaços):
  // "Itaú" e "Itau" são tratadas como a mesma empresa.
  const nameKey = normalizeCompanyKey(name);
  const dup = db.prepare('SELECT id, name FROM companies').all().find((c) => normalizeCompanyKey(c.name) === nameKey);
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
  const importSource = (req.body.import_source || '').toString().trim(); // ex: "lista de leads com dados faltando.xlsx"
  const db = getDb();
  let companiesCreated = 0, contactsCreated = 0, skipped = 0, companiesWithoutContact = 0;
  const newCompanyIds = [];
  const errors = [];

  const insCompany    = db.prepare('INSERT INTO companies (name, sector, import_source) VALUES (?, ?, ?)');
  const logCompany    = db.prepare('INSERT INTO consent_logs (company_id, action, details) VALUES (?,?,?)');
  const findContact   = db.prepare("SELECT id FROM contacts WHERE email != '' AND email=? AND company_id=?");
  const findContactByName = db.prepare('SELECT id FROM contacts WHERE LOWER(TRIM(name))=LOWER(TRIM(?)) AND company_id=?');
  const countContacts = db.prepare('SELECT COUNT(*) as c FROM contacts WHERE company_id=?');
  const insContact    = db.prepare('INSERT INTO contacts (company_id, name, role, email, linkedin, whatsapp, is_primary, import_source) VALUES (?,?,?,?,?,?,?,?)');
  const logContact    = db.prepare('INSERT INTO consent_logs (company_id, contact_id, action, details) VALUES (?,?,?,?)');

  // Mapa de deduplicação por chave normalizada (ignora acento/caixa/espaços).
  // Evita que "Itaú" e "Itau" virem duas empresas diferentes.
  const companyKeyMap = new Map();
  for (const c of db.prepare('SELECT id, name FROM companies').all()) {
    const k = normalizeCompanyKey(c.name);
    if (!companyKeyMap.has(k)) companyKeyMap.set(k, c.id);
  }

  for (const row of rows) {
    const companyName = (row.company || '').toString().trim();
    if (!companyName) { skipped++; continue; }

    const companyKey = normalizeCompanyKey(companyName);
    let companyId = companyKeyMap.get(companyKey);
    const isNew = companyId === undefined;
    if (isNew) {
      companyId = insCompany.run(companyName, (row.sector || '').toString().trim(), importSource).lastInsertRowid;
      logCompany.run(companyId, 'company_added', `Empresa "${companyName}" importada (${importSource || 'planilha'})`);
      companiesCreated++;
      newCompanyIds.push(companyId);
      companyKeyMap.set(companyKey, companyId);
    }

    const contactName = (row.contact_name || '').toString().trim();
    if (!contactName) {
      if (isNew) companiesWithoutContact++;
      continue;
    }

    // Deduplicar por email (se tiver) ou por nome+empresa
    let email = (row.email || '').toString().trim();
    if (email && !isValidEmailServer(email)) { errors.push(`E-mail inválido ignorado: ${email}`); email = ''; }
    if (email && findContact.get(email, companyId)) { skipped++; continue; }
    if (!email && findContactByName.get(contactName, companyId)) { skipped++; continue; }

    const isPrimary = countContacts.get(companyId).c === 0 ? 1 : 0;
    const cr = insContact.run(companyId, contactName, roleFromText(row.role), email, '', normalizePhone(row.whatsapp), isPrimary, importSource);
    logContact.run(companyId, cr.lastInsertRowid, 'contact_added', `Contato "${contactName}" importado (${importSource || 'planilha'})`);
    contactsCreated++;
  }

  db.close();
  res.json({ ok: true, companies_created: companiesCreated, contacts_created: contactsCreated, skipped, companies_without_contact: companiesWithoutContact, errors: errors.slice(0, 20) });
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
  company.flags = [...companyFlagKeys(db, req.params.id)];
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
        try { const p = JSON.parse(extractJsonLoose(result)); hook = p.hook || result; ctx = JSON.stringify(p); }
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
    "INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, approved, created_at) VALUES (?,?,?,?,?,?,?,'pending',0,datetime('now'))"
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

// Encontrar e cadastrar um contato para uma empresa sem contatos
app.post('/api/companies/:id/find-contact', async (req, res) => {
  const db = getDb();
  const company = db.prepare('SELECT * FROM companies WHERE id=?').get(req.params.id);
  db.close();
  if (!company) return res.status(404).json({ error: 'Empresa não encontrada' });

  const result = await findContactsForCompany(company.name, company.sector);
  if (!result || result.error || !result.name) {
    const errorMsg = result ? result.error : 'Sem resposta do Apollo';
    console.warn(`[find-contact] Falha para empresa "${company.name}": ${errorMsg}`);
    return res.json({ ok: false, status: 'not_found', error: errorMsg });
  }

  const db2 = getDb();
  // Verifica se já existe algum contato com esse nome na empresa
  const existing = db2.prepare('SELECT id FROM contacts WHERE company_id=? AND LOWER(TRIM(name))=LOWER(TRIM(?))').get(company.id, result.name);
  if (existing) {
    db2.close();
    return res.json({ ok: false, status: 'already_exists', message: `Contato "${result.name}" já cadastrado.` });
  }

  const roleKey = roleFromText(result.role);
  const cr = db2.prepare(
    "INSERT INTO contacts (company_id, name, role, email, whatsapp, linkedin, is_primary, enrich_status, enrich_source) VALUES (?,?,?,?,?,?,1,?,?)"
  ).run(
    company.id,
    result.name,
    roleKey,
    result.email || '',
    result.phone || '',
    result.linkedin || '',
    result.source === 'apollo' ? 'found' : 'guessed',
    result.source,
  );
  db2.prepare('INSERT INTO consent_logs (company_id, contact_id, action, details) VALUES (?,?,?,?)').run(
    company.id, cr.lastInsertRowid, 'contact_added',
    `Contato "${result.name}" encontrado via enriquecimento automático (${result.source})`
  );
  db2.close();

  res.json({
    ok: true,
    source: result.source,
    contact: {
      id: cr.lastInsertRowid,
      name: result.name,
      role: roleKey,
      email: result.email || '',
      whatsapp: result.phone || '',
      linkedin: result.linkedin || '',
    },
  });
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
Pesquise na WEB informações REAIS e recentes sobre a empresa "${company.name}"${company.sector ? ' (setor: ' + company.sector + ')' : ''}${contact ? ' e, se possível, sobre o contato ' + contact.name + ' (' + contact.role + ')' : ''}. Procure por: notícias recentes, expansões, contratações, rodadas de investimento, lançamentos de produto, parcerias e desafios do setor.

Produto sendo vendido: ${productValue}
Perfil do cargo: foco em ${roleInfo.focus}, tom ${roleInfo.tone}
${goldenCtx ? 'Exemplos de sucesso:\n' + goldenCtx : ''}

Com base SOMENTE no que você encontrar na web, gere um JSON PLANO e CONCISO com exatamente estas chaves:
- "research_context": array de 2-3 strings curtas (uma frase cada), cada uma com um fato REAL encontrado
- "hook": uma única string (máx 2 linhas) conectando um gancho real ao produto
- "pain_points": array de exatamente 3 strings (dores específicas do setor/porte)
- "value_proposition": uma única string
- "sources": array de URLs usados como fonte (strings)

Não aninhe objetos. Se não encontrar nada específico na web, baseie-se em tendências reais do setor e indique isso. Responda APENAS com JSON válido, sem markdown, sem comentários.`;

  const result = await callClaudeWithSearch('Você é assistente de pesquisa de vendas B2B que usa busca na web para encontrar informações reais e atuais sobre empresas e seus executivos.', prompt, 2600);
  let hook, ctx, painPoints = [];
  let raw = (result || '').replace(/```json\s*|\s*```/g, '').trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) raw = jsonMatch[0];
  try { const p = JSON.parse(raw); hook = p.hook || result; ctx = JSON.stringify(p); painPoints = Array.isArray(p.pain_points) ? p.pain_points : []; }
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
  res.json({ hook, context: ctx, pain_points: painPoints, history: researchHist });
});

app.post('/api/companies/:id/sequence', async (req, res) => {
  const db = getDb();
  const company = db.prepare('SELECT * FROM companies WHERE id=?').get(req.params.id);
  if (!company) { db.close(); return res.status(404).json({ error: 'Empresa não encontrada' }); }
  if (company.opted_out) { db.close(); return res.status(403).json({ error: 'Empresa está na blacklist' }); }
  if (companyIsBlocked(db, req.params.id)) { db.close(); return res.status(403).json({ error: "Empresa com flag 'não contatar' — abordagem bloqueada" }); }

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

  const painPoint = req.body.pain_point || req.body.selected_pain || req.body.selected_pain_point || '';
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
    const r = db3.prepare("INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))").run(contact.id, req.params.id, tpl.channel, tpl.day, tpl.type, content, content, 'pending');
    db3.close();
    results.push({ id: r.lastInsertRowid, channel: tpl.channel, day: tpl.day, content, status: 'pending', approved: 0, contact_name: contact.name });
  }

  const db4 = getDb();
  db4.prepare("UPDATE companies SET status='sequence_created' WHERE id=?").run(req.params.id);
  db4.close();
  res.json({ sequence: results, messages: results, contact });
});

// ── Geração de sequência em lote (multi-lead, multi-produto) ─────────────────
const SEQ_SYSTEM = 'Você é copywriter B2B especialista em sequências multicanal.';
const CHANNEL_DESC = {
  linkedin: 'mensagem de conexão no LinkedIn (máx 300 chars, tom informal)',
  email:    'email de prospecção (inclua assunto na 1ª linha como "Assunto: ...", corpo máx 150 palavras)',
  whatsapp: 'mensagem WhatsApp (casual, máx 100 palavras)',
};

// Monta o bloco de "observações / estilo aprendido" (RLHF) que é injetado no prompt.
// Reúne: regras de estilo (learned_patterns), exemplos aprovados e correções/comentários humanos.
function buildLearnedContext(db, channel, role) {
  const parts = [];
  try {
    const patterns = db.prepare(
      `SELECT pattern FROM learned_patterns
       WHERE channel=? AND (role=? OR role IS NULL OR role='')
       ORDER BY confidence DESC LIMIT 5`
    ).all(channel, role);
    if (patterns.length) {
      parts.push('Regras de estilo aprendidas com o humano:\n' + patterns.map(p => `- ${p.pattern}`).join('\n'));
    }

    const examples = db.prepare(
      `SELECT content FROM messages
       WHERE channel=? AND approved=1 AND score>=4 AND content IS NOT NULL
       ORDER BY score DESC, id DESC LIMIT 2`
    ).all(channel);
    if (examples.length) {
      parts.push('Exemplos aprovados (siga este estilo):\n' + examples.map(e => `"""${(e.content || '').slice(0, 300)}"""`).join('\n'));
    }

    // Observações são globais por padrão, mas podem ser marcadas como "só deste canal".
    // Inclui as globais + as específicas do canal atual. Notas baixas vêm primeiro (feedback mais informativo).
    const notes = db.prepare(
      `SELECT channel, score, human_correction, score_comment FROM messages
       WHERE ((human_correction IS NOT NULL AND human_correction != '')
           OR (score_comment IS NOT NULL AND score_comment != ''))
         AND (comment_scope IS NULL OR comment_scope='global' OR comment_scope=?)
       ORDER BY (CASE WHEN score IS NOT NULL THEN 0 ELSE 1 END), score ASC, id DESC
       LIMIT 8`
    ).all(channel);
    const obs = [];
    for (const n of notes) {
      const ch = n.channel || 'geral';
      if (n.score_comment) {
        obs.push(n.score != null && n.score <= 2
          ? `- EVITE (nota ${n.score}, ${ch}): ${n.score_comment}`
          : `- Observação (${ch}): ${n.score_comment}`);
      }
      if (n.human_correction) obs.push(`- Preferiu reescrever assim (${ch}): "${(n.human_correction || '').slice(0, 200)}"`);
    }
    if (obs.length) parts.push('Observações do avaliador humano:\n' + obs.slice(0, 8).join('\n'));
  } catch (_) { /* tabela/coluna ausente: sem contexto */ }

  if (!parts.length) return '';
  return '--- SUAS OBSERVAÇÕES / ESTILO APRENDIDO (siga à risca) ---\n' + parts.join('\n\n') + '\n--- FIM DAS OBSERVAÇÕES ---';
}

// Monta o userPrompt de uma mensagem da sequência. Usado na geração real e no preview.
function buildSequenceUserPrompt({ companyName, sector, contactName, role, hook, productValue, day, channel, socialProof, learned }) {
  const roleInfo = ROLE_PROFILES[role] || ROLE_PROFILES.other;
  return `
Empresa: ${companyName} (setor: ${sector || 'não definido'})
Contato: ${contactName}, cargo ${role}
Gancho: ${hook}
Produto: ${productValue}
Tom: ${roleInfo.tone} | Foco: ${roleInfo.focus}
Canal / Dia ${day}: ${CHANNEL_DESC[channel]}
${socialProof ? 'Casos de sucesso:\n' + socialProof : ''}
${learned ? '\n' + learned + '\n' : ''}
Escreva APENAS o texto da mensagem, sem explicações.
CTA progressivo: convide para "conversa de 15 minutos" ou "demo rápida". NÃO tente vender diretamente.`;
}

async function generateSequenceForCompany(companyId, productValue, painPoint = '') {
  const db = getDb();
  const company = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
  if (!company) { db.close(); throw new Error('Empresa não encontrada'); }
  if (company.opted_out) { db.close(); throw new Error('Empresa na blacklist'); }
  if (companyIsBlocked(db, companyId)) { db.close(); throw new Error("Flag 'não contatar' — abordagem bloqueada"); }

  let contact = db.prepare('SELECT * FROM contacts WHERE company_id=? AND is_primary=1').get(companyId);
  if (!contact) contact = db.prepare('SELECT * FROM contacts WHERE company_id=? LIMIT 1').get(companyId);
  if (!contact) { db.close(); throw new Error('Sem contatos cadastrados'); }

  const hook = company.research_hook || `Olá ${contact.name},`;
  const golden = db.prepare('SELECT title, content FROM golden_cases WHERE score>=4 LIMIT 3').all();
  const socialProof = golden.map(g => `- ${g.title}: ${g.content.substring(0, 80)}...`).join('\n');

  const results = [];
  for (const tpl of SEQUENCE_CHANNELS) {
    const learned = buildLearnedContext(db, tpl.channel, contact.role);
    const prompt = buildSequenceUserPrompt({
      companyName: company.name, sector: company.sector, contactName: contact.name, role: contact.role,
      hook, productValue, day: tpl.day, channel: tpl.channel, socialProof, learned,
    });

    const content = await callClaude(SEQ_SYSTEM, prompt, 400);
    const promptUsed = `[SYSTEM]\n${SEQ_SYSTEM}\n\n[USER]\n${prompt}`;
    const dbW = getDb();
    const r = dbW.prepare("INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, created_at, prompt_used) VALUES (?,?,?,?,?,?,?,?,datetime('now'),?)").run(contact.id, companyId, tpl.channel, tpl.day, tpl.type, content, content, 'pending', promptUsed);
    dbW.close();
    results.push({ id: r.lastInsertRowid, channel: tpl.channel, day: tpl.day, content, status: 'pending', approved: 0, contact_name: contact.name });
  }
  db.close();

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
  const receivedIns = db.prepare(
    "INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, approved, created_at) VALUES (?, ?, 'whatsapp', 1, 'text', ?, ?, 'received', 1, datetime('now'))"
  ).run(contact_id, companyId, response_text, response_text);
  const receivedMsgId = receivedIns.lastInsertRowid;
  db.close();

  // 3. Roda a classificação de sentimento da IA e gera o rascunho de resposta automática
  //    Espelha o mesmo prompt/lógica do webhook real (server.js /api/webhook/whatsapp),
  //    inclusive o sentimento "wants_meeting".
  const prompt = `
Mensagem recebida do prospect: "${response_text}"
Classifique e responda APENAS em JSON válido:
{"sentiment": "interested"|"technical_question"|"negative"|"out_of_scope"|"wants_meeting",
 "reasoning": "explicação em 1 frase",
 "interest_score": 1-10}
Nota: use "wants_meeting" quando o prospect pede para marcar reunião, ligar, ou agendar algo.`;

  const result = await callClaude('Você é classificador de intenção em vendas B2B.', prompt, 200);
  let sentiment, reasoning, iscore;
  try { const p = JSON.parse(extractJsonLoose(result)); sentiment = p.sentiment; reasoning = p.reasoning; iscore = parseInt(p.interest_score) || 5; }
  catch { sentiment = 'out_of_scope'; reasoning = result; iscore = 5; }

  const db2 = getDb();
  db2.prepare('INSERT INTO sentiment_logs (lead_id, contact_id, company_id, response_text, sentiment, reasoning, interest_score) VALUES (?,?,?,?,?,?,?)').run(null, contact_id, companyId, response_text, sentiment, reasoning, iscore);
  const statusMap = { interested: 'hot_lead', technical_question: 'needs_followup', negative: 'rejected', out_of_scope: 'contacted', wants_meeting: 'hot_lead' };
  db2.prepare('UPDATE companies SET status=?,interest_score=? WHERE id=?').run(statusMap[sentiment] || 'contacted', iscore, companyId);

  // Cria notificação — mesmo comportamento do webhook real
  const company = db2.prepare('SELECT name, auto_reply_mode FROM companies WHERE id=?').get(companyId);
  const companyName = company?.name || 'Empresa';
  const sentLabels = { interested: '🔥 Interessado', technical_question: '🤔 Dúvida técnica', negative: '👎 Negativo', out_of_scope: '↗ Fora de escopo', wants_meeting: '📅 Quer agendar reunião' };
  const notifType  = sentiment === 'wants_meeting' ? 'meeting_request' : 'message';
  const notifTitle = sentiment === 'wants_meeting'
    ? `📅 ${companyName} quer marcar reunião`
    : `💬 Nova resposta de ${companyName} (${sentLabels[sentiment] || sentiment})`;
  db2.prepare('INSERT INTO notifications (company_id,contact_id,message_id,type,title,body) VALUES (?,?,?,?,?,?)')
    .run(companyId, contact_id, receivedMsgId, notifType, notifTitle, response_text);
  db2.close();

  // 4. Auto-reply — respeita o auto_reply_mode da empresa, igual ao webhook real.
  //    Bot ativo → grava como 'sent'. Bot off → grava rascunho 'pending' para revisão manual.
  let autoReplyStatus = null;
  if (sentiment === 'interested' || sentiment === 'technical_question') {
    const autoMode = company?.auto_reply_mode || 'off';
    const botActive = autoMode === 'all' || autoMode === 'except_meeting';
    const draftPrompt = sentiment === 'technical_question'
      ? `O prospect enviou: "${response_text}"\nEle tem uma dúvida técnica. Escreva uma resposta curta (máx 80 palavras) que responda de forma objetiva e convide para uma conversa de 15 minutos para aprofundar. Tom consultivo.`
      : `O prospect enviou: "${response_text}"\nEle demonstrou interesse. Escreva uma resposta curta (máx 60 palavras) que confirme o interesse e proponha uma reunião de 15 minutos. Tom entusiasmado mas profissional.`;
    const draft_reply = await callClaude('Você é SDR especialista em respostas rápidas para prospects interessados.', draftPrompt, 200);

    const status   = botActive ? 'sent' : 'pending';
    const approved = botActive ? 1 : 0;
    autoReplyStatus = status;
    const db3 = getDb();
    db3.prepare(
      "INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, approved, created_at) VALUES (?, ?, 'whatsapp', 1, 'text', ?, ?, ?, ?, datetime('now'))"
    ).run(contact_id, companyId, draft_reply, draft_reply, status, approved);
    db3.close();
  }

  res.json({ ok: true, sentiment, interest_score: iscore, auto_reply_status: autoReplyStatus });
});

// Simula a resposta do BOT (IA em treinamento) para a última mensagem recebida.
// ACRESCENTA ao chat — nunca apaga o histórico (diferente de "Gerar Sequência").
app.post('/api/companies/:id/simulator/bot-reply', async (req, res) => {
  const { contact_id } = req.body;
  const companyId = req.params.id;
  const db = getDb();
  const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(contact_id);
  if (!contact) { db.close(); return res.status(404).json({ error: 'Contato não encontrado' }); }
  const company = db.prepare('SELECT auto_reply_mode FROM companies WHERE id=?').get(companyId);

  // Última mensagem recebida do prospect (contexto para a resposta do bot)
  const lastReceived = db.prepare(
    "SELECT content FROM messages WHERE company_id=? AND contact_id=? AND channel='whatsapp' AND status='received' ORDER BY id DESC LIMIT 1"
  ).get(companyId, contact_id);
  db.close();

  const lastMsg = lastReceived?.content;
  if (!lastMsg) {
    return res.status(400).json({ error: 'Nenhuma mensagem recebida para responder. Simule uma resposta do prospect primeiro.' });
  }

  const draftPrompt = `O prospect enviou: "${lastMsg}"\nEscreva a resposta do vendedor (bot) via WhatsApp: curta (máx 80 palavras), objetiva, tom consultivo e profissional. Se fizer sentido, convide para uma conversa de 15 minutos. Escreva APENAS o texto da mensagem.`;
  const draft_reply = await callClaude('Você é SDR especialista em respostas rápidas para prospects.', draftPrompt, 200);

  // Bot ativo → 'sent'; bot off → 'pending' (revisão). Mesma semântica do inbound.
  const autoMode = company?.auto_reply_mode || 'off';
  const botActive = autoMode === 'all' || autoMode === 'except_meeting';
  const status   = botActive ? 'sent' : 'pending';
  const approved = botActive ? 1 : 0;

  const db2 = getDb();
  const ins = db2.prepare(
    "INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, approved, created_at) VALUES (?, ?, 'whatsapp', 1, 'text', ?, ?, ?, ?, datetime('now'))"
  ).run(contact_id, companyId, draft_reply.trim(), draft_reply.trim(), status, approved);
  db2.close();

  res.json({ ok: true, id: ins.lastInsertRowid, content: draft_reply.trim(), status });
});

// Gera uma resposta realista do prospect via IA, baseada na última mensagem WhatsApp enviada
app.post('/api/companies/:id/simulator/generate-prospect-reply', async (req, res) => {
  const { contact_id, tone } = req.body; // tone: 'interested' | 'skeptical' | 'negative' | 'random'
  const db = getDb();
  const company = db.prepare('SELECT * FROM companies WHERE id=?').get(req.params.id);
  if (!company) { db.close(); return res.status(404).json({ error: 'Empresa não encontrada' }); }

  const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(contact_id);
  if (!contact) { db.close(); return res.status(404).json({ error: 'Contato não encontrado' }); }

  // Busca a última mensagem WhatsApp enviada para este contato
  const lastSent = db.prepare(
    "SELECT content FROM messages WHERE company_id=? AND contact_id=? AND channel='whatsapp' AND status IN ('pending','approved','sent') ORDER BY id DESC LIMIT 1"
  ).get(req.params.id, contact_id);
  db.close();

  const lastMsg = lastSent?.content || '(sem mensagem prévia)';
  const toneMap = {
    interested: 'O prospect é receptivo e demonstra interesse genuíno, quer saber mais.',
    skeptical:  'O prospect é cético, tem dúvidas técnicas ou sobre ROI, pede mais detalhes antes de se comprometer.',
    negative:   'O prospect não tem interesse no momento, já tem solução ou não é o decisor.',
    random:     'Escolha aleatoriamente um perfil realista de resposta (pode ser qualquer um dos anteriores).',
  };
  const toneInstruction = toneMap[tone] || toneMap.random;

  const prompt = `
Empresa: ${company.name} (setor: ${company.sector || 'não definido'})
Contato: ${contact.name}, cargo: ${contact.role}

Mensagem de prospecção recebida pelo prospect:
"${lastMsg}"

Sua tarefa: escreva a resposta que esse prospect enviaria de volta via WhatsApp.
Perfil do prospect nessa simulação: ${toneInstruction}
Regras:
- Escreva APENAS o texto da resposta, sem aspas nem explicações
- Tom informal, como WhatsApp real (pode ter erros de digitação leves, abreviações)
- Máx 60 palavras
- NÃO invente informações da empresa`;

  const reply = await callClaude('Você é um prospect B2B respondendo uma mensagem de prospecção via WhatsApp.', prompt, 150);
  res.json({ generated_reply: reply.trim() });
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
  try { const p = JSON.parse(extractJsonLoose(result)); sentiment = p.sentiment; reasoning = p.reasoning; iscore = parseInt(p.interest_score) || 5; }
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
  const hasScore   = req.body.score !== undefined && req.body.score !== null && req.body.score !== '';
  const hasComment = req.body.comment !== undefined;
  const sets = [], vals = [];
  if (hasScore) {
    const score = parseInt(req.body.score);
    if (!score || score < 1 || score > 5) return res.status(400).json({ error: 'Score 1–5' });
    sets.push('score=?'); vals.push(score);
  }
  if (hasComment) { sets.push('score_comment=?'); vals.push(String(req.body.comment || '')); }
  if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar' });
  const db = getDb();
  // Escopo do comentário: 'global' (todos os canais) ou 'channel' (só o canal desta mensagem)
  if (hasComment && req.body.scope !== undefined) {
    let scope = 'global';
    if (req.body.scope === 'channel') {
      const m = db.prepare('SELECT channel FROM messages WHERE id=?').get(req.params.id);
      scope = (m && m.channel) ? m.channel : 'global';
    }
    sets.push('comment_scope=?'); vals.push(scope);
  }
  vals.push(req.params.id);
  db.prepare(`UPDATE messages SET ${sets.join(',')} WHERE id=?`).run(...vals);
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

app.post('/api/schedule/slots', async (req, res) => {
  const { date_time, duration_min, meeting_link, company_id, contact_id, booked } = req.body;
  const db = getDb();
  const r = db.prepare(
    'INSERT INTO schedule_slots (date_time,duration_min,meeting_link,booked,company_id,contact_id) VALUES (?,?,?,?,?,?)'
  ).run(date_time, duration_min || 15, meeting_link || '', booked ? 1 : 0, company_id || null, contact_id || null);

  if (booked && company_id) {
    db.prepare("UPDATE companies SET status='meeting_set' WHERE id=?").run(company_id);
    db.prepare('INSERT INTO consent_logs (company_id,contact_id,action,details) VALUES (?,?,?,?)')
      .run(company_id, contact_id || null, 'meeting_booked', `Reunião agendada: ${date_time}`);
  }

  // Busca telefone do contato para enviar confirmação via WhatsApp
  let contactPhone = null;
  let contactName  = null;
  if (booked && contact_id) {
    const ct = db.prepare('SELECT name, whatsapp FROM contacts WHERE id=?').get(contact_id);
    contactPhone = ct?.whatsapp || null;
    contactName  = ct?.name    || 'prezado(a)';
  }
  db.close();

  // Envia mensagem de confirmação ao cliente
  if (booked && contactPhone) {
    try {
      const dtFormatted = new Date(date_time).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
      const confirmMsg  = [
        `Olá, ${contactName}! 😊`,
        ``,
        `Nossa reunião está confirmada para *${dtFormatted}* (${duration_min || 30} min).`,
        meeting_link ? `🔗 Link: ${meeting_link}` : null,
        ``,
        `Qualquer dúvida, é só me chamar aqui. Até lá! 👋`,
      ].filter(l => l !== null).join('\n');

      await sendWhatsAppMessage(contactPhone, confirmMsg);

      // Salva a mensagem enviada no histórico da conversa
      const db2 = getDb();
      db2.prepare(
        "INSERT INTO messages (contact_id,company_id,channel,day,msg_type,content,ai_original,status,approved,created_at) VALUES (?,?,'whatsapp',1,'meeting_confirm',?,?,'sent',1,datetime('now'))"
      ).run(contact_id, company_id, confirmMsg, confirmMsg);
      db2.close();
    } catch (e) {
      console.error('[Agenda] Erro ao enviar confirmação WhatsApp:', e.message);
    }
  }

  res.json({ id: r.lastInsertRowid, date_time });
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

// ── WhatsApp Inbox ────────────────────────────────────────────────────────────
// Retorna todas as empresas que têm mensagens WhatsApp, com última mensagem e contagem de não lidas
app.get('/api/whatsapp/inbox', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      co.id            AS company_id,
      co.name          AS company_name,
      co.status        AS company_status,
      co.auto_reply_mode,
      ct.id            AS contact_id,
      ct.name          AS contact_name,
      ct.whatsapp      AS contact_phone,
      m.content        AS last_message,
      m.status         AS last_status,
      m.id             AS last_msg_id,
      m.created_at     AS last_at,
      (SELECT COUNT(*) FROM messages
         WHERE company_id=co.id AND channel='whatsapp' AND status='received'
           AND id > COALESCE((SELECT MAX(id) FROM messages WHERE company_id=co.id AND channel='whatsapp' AND status!='received'),0)
      ) AS unread
    FROM companies co
    JOIN (
      SELECT company_id, MAX(id) AS max_id
      FROM messages
      WHERE channel='whatsapp'
      GROUP BY company_id
    ) latest ON latest.company_id = co.id
    JOIN messages m ON m.id = latest.max_id
    LEFT JOIN contacts ct ON ct.company_id = co.id AND ct.is_primary = 1
    ORDER BY m.id DESC
  `).all();
  db.close();
  res.json(rows);
});

// Retorna todas as mensagens WhatsApp de uma empresa
app.get('/api/whatsapp/:companyId/messages', (req, res) => {
  const db = getDb();
  const msgs = db.prepare(`
    SELECT m.*, ct.name as contact_name
    FROM messages m
    LEFT JOIN contacts ct ON m.contact_id = ct.id
    WHERE m.company_id=? AND m.channel='whatsapp'
    ORDER BY m.id ASC
  `).all(req.params.companyId);
  const company  = db.prepare('SELECT * FROM companies WHERE id=?').get(req.params.companyId);
  const contacts = db.prepare('SELECT * FROM contacts WHERE company_id=?').all(req.params.companyId);
  db.close();
  res.json({ messages: msgs, company, contacts });
});

// ── Notifications ─────────────────────────────────────────────────────────────

app.get('/api/notifications', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT n.*, co.name as company_name, ct.name as contact_name, ct.whatsapp as contact_phone
    FROM notifications n
    LEFT JOIN companies co ON n.company_id = co.id
    LEFT JOIN contacts  ct ON n.contact_id  = ct.id
    ORDER BY n.created_at DESC
    LIMIT 100
  `).all();
  const unread = db.prepare('SELECT COUNT(*) as c FROM notifications WHERE read=0').get().c;
  db.close();
  res.json({ notifications: rows, unread });
});

app.post('/api/notifications/:id/read', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET read=1 WHERE id=?').run(req.params.id);
  db.close();
  res.json({ ok: true });
});

app.post('/api/notifications/read-all', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET read=1 WHERE read=0').run();
  db.close();
  res.json({ ok: true });
});

// Confirma reunião a partir de uma notificação de wants_meeting
app.post('/api/notifications/:id/confirm-meeting', async (req, res) => {
  const { slot_id } = req.body;
  if (!slot_id) return res.status(400).json({ error: 'slot_id obrigatório' });

  const db = getDb();
  const notif = db.prepare('SELECT * FROM notifications WHERE id=?').get(req.params.id);
  if (!notif) { db.close(); return res.status(404).json({ error: 'Notificação não encontrada' }); }

  const slot = db.prepare('SELECT * FROM schedule_slots WHERE id=?').get(slot_id);
  if (!slot) { db.close(); return res.status(404).json({ error: 'Horário não encontrado' }); }
  if (slot.booked) { db.close(); return res.status(409).json({ error: 'Horário já reservado' }); }

  const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(notif.contact_id);

  // Reserva o slot
  db.prepare('UPDATE schedule_slots SET booked=1,company_id=?,contact_id=? WHERE id=?')
    .run(notif.company_id, notif.contact_id, slot_id);
  db.prepare("UPDATE companies SET status='meeting_set' WHERE id=?").run(notif.company_id);
  db.prepare('INSERT INTO consent_logs (company_id,contact_id,action,details) VALUES (?,?,?,?)')
    .run(notif.company_id, notif.contact_id, 'meeting_booked', `Reunião agendada: ${slot.date_time}`);

  // Marca notificação como lida
  db.prepare('UPDATE notifications SET read=1 WHERE id=?').run(req.params.id);
  db.close();

  // Envia confirmação via WhatsApp
  if (contact?.whatsapp) {
    const dtFormatted = new Date(slot.date_time).toLocaleString('pt-BR', { dateStyle:'short', timeStyle:'short' });
    const confirmMsg = `Olá ${contact.name}! ✅ Reunião confirmada para ${dtFormatted}${slot.meeting_link ? `\nLink: ${slot.meeting_link}` : ''}. Até lá!`;
    await sendWhatsAppMessage(contact.whatsapp, confirmMsg);

    // Salva confirmação como mensagem enviada
    const db2 = getDb();
    db2.prepare(
      "INSERT INTO messages (contact_id,company_id,channel,day,msg_type,content,ai_original,status,approved,created_at) VALUES (?,?,'whatsapp',1,'text',?,?,'sent',1,datetime('now'))"
    ).run(contact.id, notif.company_id, confirmMsg, confirmMsg);
    db2.close();
  }

  res.json({ ok: true, date_time: slot.date_time, meeting_link: slot.meeting_link });
});

// ── Auto-reply mode per company ───────────────────────────────────────────────

app.get('/api/companies/:id/auto-reply', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT auto_reply_mode FROM companies WHERE id=?').get(req.params.id);
  db.close();
  if (!row) return res.status(404).json({ error: 'Empresa não encontrada' });
  res.json({ auto_reply_mode: row.auto_reply_mode || 'off' });
});

app.patch('/api/companies/:id/auto-reply', (req, res) => {
  const { auto_reply_mode } = req.body;
  const valid = ['off', 'all', 'except_meeting'];
  if (!valid.includes(auto_reply_mode)) return res.status(400).json({ error: 'Modo inválido' });
  const db = getDb();
  db.prepare('UPDATE companies SET auto_reply_mode=? WHERE id=?').run(auto_reply_mode, req.params.id);
  db.close();
  res.json({ ok: true, auto_reply_mode });
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

// Prompt exato usado numa mensagem (com fallback: remonta se a mensagem for antiga)
app.get('/api/messages/:id/prompt', (req, res) => {
  const db = getDb();
  try {
    const m = db.prepare(
      `SELECT m.*, co.name as company_name, co.sector as company_sector, co.research_hook as hook,
              ct.name as contact_name, ct.role as contact_role
       FROM messages m
       LEFT JOIN companies co ON m.company_id = co.id
       LEFT JOIN contacts ct ON m.contact_id = ct.id
       WHERE m.id=?`
    ).get(req.params.id);
    if (!m) { db.close(); return res.status(404).json({ error: 'Mensagem não encontrada' }); }

    if (m.prompt_used) {
      db.close();
      return res.json({ prompt_used: m.prompt_used, system: SEQ_SYSTEM, reconstructed: false });
    }

    // Fallback para mensagens geradas antes desta feature
    const golden = db.prepare('SELECT title, content FROM golden_cases WHERE score>=4 LIMIT 3').all();
    const socialProof = golden.map(g => `- ${g.title}: ${(g.content || '').substring(0, 80)}...`).join('\n');
    const learned = buildLearnedContext(db, m.channel, m.contact_role);
    const userPrompt = buildSequenceUserPrompt({
      companyName: m.company_name || '—', sector: m.company_sector, contactName: m.contact_name || '—',
      role: m.contact_role || 'other', hook: m.hook || `Olá ${m.contact_name || ''},`,
      productValue: '(produto informado na geração)', day: m.day, channel: m.channel, socialProof, learned,
    });
    db.close();
    res.json({ prompt_used: `[SYSTEM]\n${SEQ_SYSTEM}\n\n[USER]\n${userPrompt}`, system: SEQ_SYSTEM, reconstructed: true });
  } catch (e) {
    db.close();
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Preview ao vivo do prompt (sem chamar a LLM), já com as observações injetadas
app.get('/api/learn/prompt-preview', (req, res) => {
  const channel = req.query.channel || 'email';
  const role = req.query.role || 'c_level';
  const db = getDb();
  try {
    const golden = db.prepare('SELECT title, content FROM golden_cases WHERE score>=4 LIMIT 3').all();
    const socialProof = golden.map(g => `- ${g.title}: ${(g.content || '').substring(0, 80)}...`).join('\n');
    const learned = buildLearnedContext(db, channel, role);
    const userPromptTemplate = buildSequenceUserPrompt({
      companyName: '{empresa}', sector: '{setor}', contactName: '{contato}', role,
      hook: '{gancho de pesquisa}', productValue: '{produto}',
      day: (SEQUENCE_CHANNELS.find(c => c.channel === channel) || {}).day || 1,
      channel, socialProof, learned,
    });
    db.close();
    res.json({ systemPrompt: SEQ_SYSTEM, userPromptTemplate, hasLearned: !!learned, channel, role });
  } catch (e) {
    db.close();
    res.status(500).json({ error: String(e.message || e) });
  }
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
  db.prepare("INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, approved, created_at) VALUES (?,?,?,?,?,?,?,'pending',0,datetime('now'))")
    .run(contact.id, contact.company_id, channel, 5, 'follow_up', content, content);
  db.close();
  res.json({ ok: true });
});

// ─── RLHF / Aprendizado ────────────────────────────────────────────────────

// Estatísticas do aprendizado acumulado (consumido por RLHF.jsx)
app.get('/api/learn/stats', (req, res) => {
  const db = getDb();
  try {
    const approved_examples = db.prepare(
      `SELECT m.channel, ct.role AS role, COUNT(*) AS total
       FROM messages m LEFT JOIN contacts ct ON ct.id = m.contact_id
       WHERE m.approved=1 AND m.score >= 4
       GROUP BY m.channel, ct.role`
    ).all();

    const corrections_pending = db.prepare(
      `SELECT COUNT(*) AS cnt FROM messages
       WHERE human_correction IS NOT NULL AND human_correction != ''
         AND ai_original IS NOT NULL
         AND ABS(LENGTH(human_correction) - LENGTH(ai_original)) > 10`
    ).get().cnt;

    const learned_patterns = db.prepare(
      'SELECT channel, role, pattern, confidence, sample_size FROM learned_patterns ORDER BY confidence DESC'
    ).all();

    const avg_score = db.prepare(
      'SELECT ROUND(AVG(score),2) AS v FROM messages WHERE score IS NOT NULL'
    ).get().v;

    res.json({
      avg_score,
      corrections_pending_analysis: corrections_pending,
      approved_examples,
      learned_patterns,
      ready_to_analyze: corrections_pending >= 2,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    db.close();
  }
});

// Séries temporais do progresso do RLHF (evolução ao longo do tempo)
app.get('/api/learn/progress', (req, res) => {
  const db = getDb();
  try {
    const kv = (rows) => ({ labels: rows.map(r => r.d), values: rows.map(r => r.v) });

    const score_series = db.prepare(
      `SELECT strftime('%Y-%m-%d', created_at) AS d, ROUND(AVG(score),2) AS v
       FROM messages WHERE score IS NOT NULL AND created_at IS NOT NULL
       GROUP BY d ORDER BY d`
    ).all();

    const approvals = db.prepare(
      `SELECT strftime('%Y-%m-%d', created_at) AS d, COUNT(*) AS v
       FROM messages WHERE approved=1 AND created_at IS NOT NULL
       GROUP BY d ORDER BY d`
    ).all();

    const corrections = db.prepare(
      `SELECT strftime('%Y-%m-%d', created_at) AS d, COUNT(*) AS v
       FROM messages
       WHERE human_correction IS NOT NULL AND human_correction != '' AND created_at IS NOT NULL
       GROUP BY d ORDER BY d`
    ).all();

    const patterns = db.prepare(
      `SELECT strftime('%Y-%m-%d', created_at) AS d, COUNT(*) AS v
       FROM learned_patterns WHERE created_at IS NOT NULL
       GROUP BY d ORDER BY d`
    ).all();

    const approval_rate = db.prepare(
      `SELECT strftime('%Y-%m-%d', created_at) AS d,
              ROUND(100.0 * SUM(CASE WHEN score >= 4 THEN 1 ELSE 0 END) / COUNT(*), 1) AS v
       FROM messages WHERE score IS NOT NULL AND created_at IS NOT NULL
       GROUP BY d ORDER BY d`
    ).all();

    const avg_last7 = db.prepare(
      `SELECT ROUND(AVG(score),2) AS v FROM messages
       WHERE score IS NOT NULL AND created_at >= datetime('now','-7 days')`
    ).get().v;
    const avg_prev7 = db.prepare(
      `SELECT ROUND(AVG(score),2) AS v FROM messages
       WHERE score IS NOT NULL
         AND created_at >= datetime('now','-14 days')
         AND created_at <  datetime('now','-7 days')`
    ).get().v;
    const total_feedback = db.prepare(
      `SELECT COUNT(*) AS v FROM messages
       WHERE score IS NOT NULL OR approved=1
          OR (human_correction IS NOT NULL AND human_correction != '')`
    ).get().v;
    const total_patterns = db.prepare('SELECT COUNT(*) AS v FROM learned_patterns').get().v;

    res.json({
      score_series: kv(score_series),
      approvals: kv(approvals),
      corrections: kv(corrections),
      patterns: kv(patterns),
      approval_rate: kv(approval_rate),
      summary: {
        avg_last7,
        avg_prev7,
        trend: (avg_last7 == null || avg_prev7 == null)
          ? 0
          : Math.round((avg_last7 - avg_prev7) * 100) / 100,
        total_feedback,
        total_patterns,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    db.close();
  }
});

// Analisa correções humanas e extrai regras de estilo (padrões aprendidos)
app.post('/api/learn/analyze', async (req, res) => {
  const db = getDb();
  let corrections;
  try {
    corrections = db.prepare(
      `SELECT m.channel AS channel, ct.role AS role, m.ai_original AS ai_original, m.human_correction AS human_correction
       FROM messages m LEFT JOIN contacts ct ON ct.id = m.contact_id
       WHERE m.human_correction IS NOT NULL AND m.human_correction != ''
         AND m.ai_original IS NOT NULL
         AND ABS(LENGTH(m.human_correction) - LENGTH(m.ai_original)) > 10`
    ).all();
  } catch (e) {
    db.close();
    return res.status(500).json({ error: String(e.message || e) });
  }

  if (!corrections || corrections.length < 2) {
    db.close();
    return res.json({ ok: false, message: 'Sem correções suficientes ainda. Continue avaliando!' });
  }

  // Agrupa por canal+cargo
  const groups = {};
  for (const c of corrections) {
    const key = `${c.channel || 'geral'}|${c.role || 'other'}`;
    (groups[key] = groups[key] || []).push(c);
  }

  const analyzed = [];
  try {
    for (const [key, items] of Object.entries(groups)) {
      const [channel, role] = key.split('|');
      const examples = items.slice(0, 8).map((c, i) =>
        `Exemplo ${i + 1}:\nORIGINAL (IA): ${c.ai_original}\nCORRIGIDO (humano): ${c.human_correction}`
      ).join('\n\n');

      const prompt =
        `Analise as correções humanas abaixo (canal: ${channel}, cargo: ${role}) e extraia de 2 a 4 REGRAS DE ESTILO objetivas ` +
        `que expliquem como o humano prefere as mensagens. Responda APENAS com um array JSON de strings curtas, ` +
        `ex: ["Evite abrir com o nome do lead", "Use perguntas em vez de afirmações"].\n\n${examples}`;

      let rules = [];
      try {
        const raw = await callClaude('Você é analista de estilo de escrita comercial. Responda só com JSON.', prompt, 400);
        const match = String(raw).match(/\[[\s\S]*\]/);
        rules = match ? JSON.parse(match[0]) : [];
      } catch (_) {
        rules = [];
      }
      rules = (rules || []).filter(r => typeof r === 'string' && r.trim()).slice(0, 4);

      const confidence = Math.min(0.95, 0.5 + items.length * 0.1);
      const ins = db.prepare(
        'INSERT INTO learned_patterns (channel, role, pattern, confidence, sample_size) VALUES (?,?,?,?,?)'
      );
      for (const r of rules) ins.run(channel, role, r, confidence, items.length);

      analyzed.push({ channel, role, rules_extracted: rules.length });
    }
    res.json({ ok: true, analyzed });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    db.close();
  }
});

// Catch-all route to serve React frontend for non-API requests
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Sales AI Agent rodando em http://localhost:${PORT}`);
  console.log(`Login: admin / admin123`);
});
