require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const rel = require('./lib/relationships');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'prototype.db');

// ── DB helper ─────────────────────────────────────────────────────────────────
function getDb() {
  const db = new DatabaseSync(DB_PATH);
  // (#8) Concorrência: WAL permite leituras simultâneas a uma escrita; busy_timeout evita
  // "database is locked" sob carga esperando o lock por até 5s. Pragmas são idempotentes.
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('PRAGMA foreign_keys=ON');
  } catch (_) { /* pragmas indisponíveis: segue com defaults */ }
  return db;
}

// ── Upload de PDF → Markdown ────────────────────────────────────────────────────
// multer em memória (não grava arquivo em disco); limite de 25MB.
const uploadPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// pdfjs-dist v6 é ESM-only; carregamos via import() dinâmico e cacheamos a promise.
let _pdfjsPromise = null;
function getPdfjs() {
  if (!_pdfjsPromise) _pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return _pdfjsPromise;
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// (#5) Reconstrói as linhas de UMA página do PDF, com detecção de colunas e de
// títulos (por altura de fonte). Recebe os itens de text content da pdfjs.
function pageItemsToLines(items) {
  const norm = items
    .filter(it => it.str && it.str.trim())
    .map(it => ({ x: it.transform[4], y: it.transform[5], h: Math.abs(it.transform[3]) || 10, str: it.str }));
  if (!norm.length) return [];

  // Detecta 2 colunas: procura a maior faixa vertical vazia no terço central da página.
  const xs = norm.map(i => i.x).sort((a, b) => a - b);
  const minX = xs[0], maxX = xs[xs.length - 1], span = maxX - minX;
  let split = null;
  if (span > 200) {
    const lo = minX + span * 0.33, hi = minX + span * 0.67;
    let bestGap = 0, bestMid = null, prev = null;
    for (const x of xs) {
      if (prev !== null && prev >= lo && x <= hi && (x - prev) > bestGap) {
        bestGap = x - prev; bestMid = (prev + x) / 2;
      }
      prev = x;
    }
    if (bestGap > span * 0.12) split = bestMid; // gap relevante => há colunas
  }

  const heights = norm.map(i => i.h).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 10;

  const buildColumn = (colItems) => {
    const rows = new Map(); // yBucket -> items
    for (const it of colItems) {
      const key = Math.round(it.y / 3) * 3; // tolerância de 3px na mesma linha
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(it);
    }
    return [...rows.keys()].sort((a, b) => b - a).map(k => {
      const line = rows.get(k).sort((a, b) => a.x - b.x);
      const text = line.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
      const maxH = Math.max(...line.map(i => i.h));
      // Título: linha curta e com fonte bem maior que a mediana.
      const isHeading = maxH > medianH * 1.4 && text.length <= 80;
      return isHeading ? `### ${text}` : text;
    }).filter(l => l.replace(/^#+\s*/, '').length);
  };

  if (split !== null) {
    const left = buildColumn(norm.filter(i => i.x < split));
    const right = buildColumn(norm.filter(i => i.x >= split));
    return [...left, ...right];
  }
  return buildColumn(norm);
}

// Extrai o texto de um PDF (tolera restrição de permissão sem senha) e reconstrói
// Markdown leve. Não lança em PDF só-imagem — retorna { markdown, hasText:false }.
async function pdfBufferToMarkdown(buffer, filename) {
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
  const title = String(filename || 'Documento').replace(/\.[a-z0-9]+$/i, '').trim() || 'Documento';
  const out = [`# ${title}`, ''];
  let textChars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const lines = pageItemsToLines(content.items);
    if (lines.length) {
      textChars += lines.join('').length;
      out.push(`## Página ${p}`, '', ...lines, '');
    }
  }
  const markdown = out.join('\n').trim();
  const hasText = markdown.replace(/^#+.*$/gm, '').trim().length > 0;
  return { title, markdown, hasText, numPages: doc.numPages };
}

// (#4) OCR de PDF só-imagem: renderiza cada página com @napi-rs/canvas e passa
// pela tesseract.js (por+eng). Deps carregadas sob demanda; se faltarem, lança.
let _tesseractWorker = null;
async function getOcrWorker() {
  if (_tesseractWorker) return _tesseractWorker;
  const { createWorker } = require('tesseract.js');
  _tesseractWorker = await createWorker(['por', 'eng']);
  return _tesseractWorker;
}
async function ocrPdfToMarkdown(buffer, filename, maxPages = 15) {
  const pdfjs = await getPdfjs();
  const { createCanvas } = require('@napi-rs/canvas');
  const worker = await getOcrWorker();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
  const title = String(filename || 'Documento').replace(/\.[a-z0-9]+$/i, '').trim() || 'Documento';
  const out = [`# ${title}`, ''];
  const pages = Math.min(doc.numPages, maxPages);
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const png = canvas.toBuffer('image/png');
    const { data } = await worker.recognize(png);
    const txt = (data.text || '').replace(/\n{3,}/g, '\n\n').trim();
    if (txt) out.push(`## Página ${p}`, '', txt, '');
  }
  const markdown = out.join('\n').trim();
  if (!markdown.replace(/^#+.*$/gm, '').trim()) throw new Error('no_text');
  return { title, markdown, numPages: doc.numPages };
}

// (#9) Dispatch por formato: PDF (com fallback OCR), DOCX (mammoth), TXT/MD.
// Valida magic number quando aplicável (#11). Retorna { title, markdown, source_type }.
async function extractFileToMarkdown(buffer, filename) {
  const ext = (String(filename).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const head = buffer.slice(0, 4).toString('latin1');

  if (ext === 'pdf' || head === '%PDF') {
    if (head !== '%PDF') throw Object.assign(new Error('bad_magic'), { code: 'bad_magic' });
    const r = await pdfBufferToMarkdown(buffer, filename);
    if (r.hasText) return { title: r.title, markdown: r.markdown, source_type: 'pdf' };
    // PDF sem texto => tenta OCR
    try {
      const o = await ocrPdfToMarkdown(buffer, filename);
      return { title: o.title, markdown: o.markdown, source_type: 'pdf-ocr' };
    } catch (e) {
      throw Object.assign(new Error('no_text'), { code: 'no_text' });
    }
  }

  if (ext === 'docx') {
    // DOCX é um zip: magic "PK"
    if (buffer.slice(0, 2).toString('latin1') !== 'PK') throw Object.assign(new Error('bad_magic'), { code: 'bad_magic' });
    const mammoth = require('mammoth');
    const { value } = await mammoth.convertToMarkdown({ buffer });
    const title = String(filename).replace(/\.[a-z0-9]+$/i, '').trim() || 'Documento';
    const markdown = `# ${title}\n\n${(value || '').trim()}`;
    if (!markdown.replace(/^#+.*$/gm, '').trim()) throw Object.assign(new Error('no_text'), { code: 'no_text' });
    return { title, markdown, source_type: 'docx' };
  }

  if (ext === 'txt' || ext === 'md' || ext === 'markdown') {
    const title = String(filename).replace(/\.[a-z0-9]+$/i, '').trim() || 'Documento';
    const body = buffer.toString('utf8').trim();
    if (!body) throw Object.assign(new Error('no_text'), { code: 'no_text' });
    const markdown = ext === 'txt' ? `# ${title}\n\n${body}` : body;
    return { title, markdown, source_type: ext === 'txt' ? 'txt' : 'md' };
  }

  throw Object.assign(new Error('unsupported'), { code: 'unsupported' });
}

function extractErrorMessage(code) {
  switch (code) {
    case 'no_text':     return 'Não foi possível extrair texto (nem via OCR). O arquivo pode estar vazio ou ilegível.';
    case 'bad_magic':   return 'Arquivo inválido: o conteúdo não corresponde à extensão informada.';
    case 'unsupported': return 'Formato não suportado. Use PDF, DOCX, TXT ou MD.';
    default:            return 'Falha ao ler o arquivo (corrompido ou protegido por senha de leitura).';
  }
}

// (#2) Seleciona os trechos mais relevantes de um documento para um conjunto de
// termos de busca, respeitando um orçamento de caracteres. Sem termos, pega o topo.
function extractRelevantChunk(content, terms, maxChars) {
  const text = String(content || '');
  if (text.length <= maxChars) return text;
  const cleanTerms = (terms || [])
    .flatMap(t => String(t).toLowerCase().split(/\s+/))
    .filter(t => t.length >= 4);
  const paras = text.split(/\n{2,}/).filter(p => p.trim());
  if (!cleanTerms.length) return text.slice(0, maxChars);
  const scored = paras.map((p, i) => {
    const low = p.toLowerCase();
    let score = 0;
    for (const t of cleanTerms) { let idx = low.indexOf(t); while (idx !== -1) { score++; idx = low.indexOf(t, idx + t.length); } }
    return { p, i, score };
  });
  const ranked = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  if (!ranked.length) return text.slice(0, maxChars);
  // Acumula os parágrafos mais relevantes na ordem original até o orçamento.
  const picked = new Set();
  let total = 0;
  for (const s of ranked) { if (total + s.p.length > maxChars) continue; picked.add(s.i); total += s.p.length + 2; if (total >= maxChars) break; }
  if (!picked.size) return ranked[0].p.slice(0, maxChars);
  return scored.filter(s => picked.has(s.i)).map(s => s.p).join('\n\n');
}

// ── SSE: push de atualizações do inbox WhatsApp em tempo real ──────────────────
// Substitui o polling do frontend. Cada aba conectada fica registrada aqui e
// recebe um evento sempre que uma conversa muda (nova mensagem, envio, etc.).
const inboxSseClients = new Set();
function broadcastInboxUpdate() {
  const payload = 'event: inbox\ndata: {"type":"update"}\n\n';
  for (const client of inboxSseClients) {
    try { client.write(payload); } catch (_) { /* conexão morta, será limpa no close */ }
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new FileStore({
    path: process.env.SESSIONS_PATH || path.join(__dirname, '.sessions'),
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

// Normaliza o tipo de call para um dos 3 níveis válidos.
// cold  = lead totalmente novo, sem vínculo prévio (dispara busca automática)
// warm  = lead já qualificado, contexto fornecido manualmente pelo operador
// frozen = lead que já conhece a empresa (mensagem de reconexão)
const CALL_TYPES = ['cold', 'warm', 'frozen'];
function normalizeCallType(v) {
  const t = (v || '').toString().trim().toLowerCase();
  return CALL_TYPES.includes(t) ? t : 'cold';
}

// ── Helper: adiciona coluna apenas se não existir ─────────────────────────────
function addColumnIfNotExists(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// ── Helper: garante um único contato primário por empresa ─────────────────────
// Zera qualquer is_primary=1 existente da empresa. Deve ser chamado ANTES de
// inserir/atualizar um contato como primário — o índice único parcial
// idx_one_primary_per_company rejeitaria um segundo primário. Centraliza a regra
// para que os vários pontos de criação de contato não divirjam.
function clearPrimaryContact(db, companyId) {
  db.prepare('UPDATE contacts SET is_primary=0 WHERE company_id=? AND is_primary=1').run(companyId);
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
    CREATE TABLE IF NOT EXISTS audit_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER,
      username   TEXT,
      action     TEXT NOT NULL,
      details    TEXT DEFAULT '',
      company_id INTEGER,
      contact_id INTEGER,
      message_id INTEGER,
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
    CREATE TABLE IF NOT EXISTS hook_library (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      situation    TEXT NOT NULL,
      product_link TEXT DEFAULT '',
      example_text TEXT NOT NULL,
      category     TEXT DEFAULT 'geral',
      call_type    TEXT DEFAULT 'cold',
      tags         TEXT DEFAULT '',
      score        INTEGER DEFAULT 5,
      active       INTEGER DEFAULT 1,
      created_at   TEXT DEFAULT (datetime('now'))
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
    CREATE TABLE IF NOT EXISTS search_logs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id     INTEGER,
      contact_id     INTEGER,
      call_type      TEXT,
      source         TEXT,
      query          TEXT,
      result_summary TEXT,
      created_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_search_logs_contact ON search_logs(contact_id);
    CREATE TABLE IF NOT EXISTS call_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id  INTEGER NOT NULL,
      contact_id  INTEGER,
      call_type   TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_call_events_company ON call_events(company_id);
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
    CREATE TABLE IF NOT EXISTS opportunity_documents (
      opportunity_id INTEGER NOT NULL,
      document_id    INTEGER NOT NULL,
      created_at     TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (opportunity_id, document_id),
      FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id)    REFERENCES documents(id)     ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_oppdocs_doc ON opportunity_documents(document_id);
  `);

  // Colunas novas em documents: hash p/ dedup (#3) e metadados de origem (#4/#9)
  addColumnIfNotExists(db, 'documents', 'content_hash', 'TEXT');
  addColumnIfNotExists(db, 'documents', 'source_type',  "TEXT DEFAULT 'text'");
  db.exec('CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(content_hash)');

  // Perfis de usuário (marketing x vendas) e identidade do remetente nas mensagens.
  addColumnIfNotExists(db, 'users', 'user_type',      "TEXT DEFAULT 'vendas'");  // 'vendas' | 'marketing'
  addColumnIfNotExists(db, 'users', 'company_name',   "TEXT DEFAULT ''");         // marca usada pelo perfil marketing
  addColumnIfNotExists(db, 'users', 'signature_name', "TEXT DEFAULT ''");         // (#6) pessoa p/ assinatura (opcional, marketing)
  // Atribuição do lead ao usuário que o gerou.
  addColumnIfNotExists(db, 'companies', 'created_by', 'INTEGER');

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
  addColumnIfNotExists(db, 'contacts', 'context', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'contacts', 'title', "TEXT DEFAULT ''");
  // Tipo de call: 'cold' (lead totalmente novo → busca automática), 'warm' (qualificado,
  // contexto manual do operador), 'frozen' (lead que já conhece a empresa → reconexão).
  addColumnIfNotExists(db, 'contacts', 'call_type', "TEXT DEFAULT 'cold'");
  // Persona do prospect no simulador WhatsApp — mantém coerência de tom entre turnos.
  addColumnIfNotExists(db, 'contacts', 'sim_tone', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'messages', 'is_template',  "INTEGER DEFAULT 0");
  addColumnIfNotExists(db, 'messages', 'template_name',"TEXT");
  addColumnIfNotExists(db, 'messages', 'created_at',   "TEXT");
  addColumnIfNotExists(db, 'messages', 'score_comment',"TEXT");
  addColumnIfNotExists(db, 'messages', 'prompt_used',  "TEXT");
  addColumnIfNotExists(db, 'messages', 'comment_scope',"TEXT DEFAULT 'global'");
  addColumnIfNotExists(db, 'messages', 'versions',     "TEXT DEFAULT '[]'");
  addColumnIfNotExists(db, 'messages', 'product',      "TEXT DEFAULT ''");
  // Biblioteca de ganchos: rastreia qual arquétipo gerou a 1ª mensagem — base do
  // loop de aprendizado (#1), anti-repetição (#2) e das métricas de naturalidade (#7).
  addColumnIfNotExists(db, 'messages', 'hook_id',       "INTEGER");
  addColumnIfNotExists(db, 'messages', 'hook_category', "TEXT DEFAULT ''");
  // RLHF v2: threading (histórico da conversa) + tipagem de sinal de feedback
  addColumnIfNotExists(db, 'messages', 'thread_id',    "INTEGER");
  addColumnIfNotExists(db, 'messages', 'seq_no',       "INTEGER");
  addColumnIfNotExists(db, 'messages', 'direction',    "TEXT DEFAULT 'outbound'");
  addColumnIfNotExists(db, 'messages', 'feedback_kind',"TEXT");
  // Snapshot do texto exato a que uma crítica se refere — impede que a âncora crítica↔mensagem
  // "deslize" quando a mensagem é regenerada (o ai_original é sobrescrito).
  addColumnIfNotExists(db, 'messages', 'criticized_text', "TEXT");
  // (#1) Verificação factual dos ganchos: fontes da busca web + afirmações a checar.
  addColumnIfNotExists(db, 'messages', 'sources',         "TEXT DEFAULT '[]'");   // URLs de fonte (JSON array)
  addColumnIfNotExists(db, 'messages', 'fact_claims',     "TEXT DEFAULT '[]'");   // trechos com fatos/números detectados (JSON array)
  addColumnIfNotExists(db, 'messages', 'needs_fact_check',"INTEGER DEFAULT 0");   // 1 = cita fato específico e precisa de revisão humana
  // (#6) Painel A/B: agrupa variantes geradas para o mesmo lead/mensagem.
  addColumnIfNotExists(db, 'messages', 'variant_group',   "TEXT");                // id do grupo de variantes (mesma geração)
  addColumnIfNotExists(db, 'messages', 'variant_no',      "INTEGER DEFAULT 1");   // 1..N dentro do grupo
  addColumnIfNotExists(db, 'messages', 'variant_angle',   "TEXT DEFAULT ''");     // rótulo do ângulo da variante
  // (#7) Rubrica "não parece bot": nota objetiva + laudo do juiz.
  addColumnIfNotExists(db, 'messages', 'style_score',     "REAL");                // nota 0-5 do LLM-judge
  addColumnIfNotExists(db, 'messages', 'style_report',    "TEXT");                // JSON com breakdown da rubrica

  // (#3) Seed de arquétipos de gancho — dá variedade de abertura e evita templates repetidos.
  // Só insere se a biblioteca estiver vazia (não sobrescreve curadoria do operador).
  try {
    const hookCount = db.prepare('SELECT COUNT(*) AS c FROM hook_library').get().c;
    if (hookCount === 0) {
      const insHook = db.prepare(
        "INSERT INTO hook_library (situation, product_link, example_text, category, call_type, tags, score) VALUES (?,?,?,?,?,?,?)"
      );
      for (const h of DEFAULT_HOOKS) insHook.run(h.situation, h.product_link, h.example_text, h.category, h.call_type, h.tags, h.score);
      console.log(`✅ hook_library populada com ${DEFAULT_HOOKS.length} arquétipos de gancho`);
    }
  } catch (e) { console.warn('[hook-seed] não foi possível popular hook_library:', e.message); }
  // RLHF v2: regras destiladas com escopo, ciclo de vida e rastreabilidade
  addColumnIfNotExists(db, 'learned_patterns', 'scope',              "TEXT DEFAULT 'global'");
  addColumnIfNotExists(db, 'learned_patterns', 'status',             "TEXT DEFAULT 'active'");
  addColumnIfNotExists(db, 'learned_patterns', 'source_message_ids', "TEXT DEFAULT '[]'");
  addColumnIfNotExists(db, 'learned_patterns', 'updated_at',         "TEXT");
  // Backfill de thread_id/seq_no para mensagens antigas (uma thread por contato)
  try {
    db.exec(`UPDATE messages SET thread_id=contact_id WHERE thread_id IS NULL AND contact_id IS NOT NULL`);
    db.exec(`UPDATE messages SET direction='outbound' WHERE direction IS NULL`);
  } catch (_) { /* colunas ainda não existem em bases muito antigas */ }

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

  // ── LinkedIn: busca pontual (1 lead) + validação humana ─────────────────────
  // Fluxo assistido/manual: o operador cola o texto do perfil, a IA estrutura os
  // dados, e nada é gravado nos campos finais sem confirmação humana.
  // linkedin_status: '' | 'pending_review' | 'confirmed' | 'rejected'
  addColumnIfNotExists(db, 'contacts', 'linkedin_status',          "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'contacts', 'linkedin_parsed',          "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'contacts', 'linkedin_raw',             "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'contacts', 'linkedin_headline',        "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'contacts', 'linkedin_current_role',    "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'contacts', 'linkedin_current_company', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'contacts', 'linkedin_location',        "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'contacts', 'linkedin_summary',         "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'contacts', 'linkedin_reviewed_at',     "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'contacts', 'linkedin_reviewed_by',     "TEXT DEFAULT ''");

  // Rastreamento de origem da importação
  addColumnIfNotExists(db, 'contacts',  'import_source', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'companies', 'import_source', "TEXT DEFAULT ''");

  // ── WhatsApp: deduplicação de mensagens recebidas ───────────────────────────
  // A Meta reenvia webhooks em caso de timeout/erro. Guardamos o id único da
  // mensagem (msg.id) para ignorar reentregas e evitar mensagens duplicadas.
  addColumnIfNotExists(db, 'messages', 'wa_message_id', "TEXT");
  addColumnIfNotExists(db, 'messages', 'style_profile', "TEXT DEFAULT ''");

  // Normaliza contatos primários duplicados ANTES de criar o índice único parcial
  // (o índice falharia se já existissem múltiplos is_primary=1 na mesma empresa).
  db.exec(`
    UPDATE contacts SET is_primary=0
    WHERE is_primary=1
      AND id NOT IN (SELECT MIN(id) FROM contacts WHERE is_primary=1 GROUP BY company_id);
  `);
  // Índices que garantem unicidade e aceleram o inbox
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_primary_per_company
      ON contacts(company_id) WHERE is_primary = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa_message_id
      ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_company_channel
      ON messages(company_id, channel, status, id);
  `);

  // ── Teste cego anti-detecção de bot (Turing-style) ─────────────────────────
  // Guarda mensagens (reais x geradas pela automação) apresentadas às cegas e os
  // palpites dos testadores, para medir se humanos distinguem bot de humano.
  // Meta de sucesso: taxa de acerto agregada < 50%.
  db.exec(`
    CREATE TABLE IF NOT EXISTS blind_test_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      source     TEXT    NOT NULL,              -- 'real' | 'auto'
      text       TEXT    NOT NULL,
      batch      TEXT    DEFAULT '',
      created_at TEXT    DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS blind_test_guesses (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id     INTEGER REFERENCES blind_test_items(id) ON DELETE CASCADE,
      tester_name TEXT    NOT NULL,
      guess       TEXT    NOT NULL,             -- 'real' | 'auto'
      correct     INTEGER DEFAULT 0,
      created_at  TEXT    DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_blind_guess_item   ON blind_test_guesses(item_id);
    CREATE INDEX IF NOT EXISTS idx_blind_guess_tester ON blind_test_guesses(tester_name);
  `);
  addColumnIfNotExists(db, 'blind_test_items', 'scenario', "TEXT DEFAULT ''");
  addColumnIfNotExists(db, 'blind_test_guesses', 'reason', "TEXT DEFAULT ''");

  // Seed usuário admin padrão
  const adminUser = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminUser) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare("INSERT INTO users (username, password, name) VALUES (?, ?, ?)").run('admin', hash, 'Administrador');
    console.log('Usuário admin criado — login: admin | senha: admin123');
  }

  // Seed da biblioteca de ganchos — arquétipos de 1ª mensagem que amarram uma
  // SITUAÇÃO/CONTEXTO REAL ao produto, para soar humano (não robotizado).
  // Servem como few-shot no prompt: o modelo imita o TOM, nunca copia literal.
  const hookCount = db.prepare('SELECT COUNT(*) as c FROM hook_library').get().c;
  if (hookCount === 0) {
    const seedHooks = [
      { situation: 'Encontro presencial em feira/evento de bairro', product_link: 'puxa a conversa pelo lugar real onde se cruzaram e conecta ao produto sem pitch', example_text: 'Oi {nome}, te encontrei rapidinho na Feira da Glória no fim de semana mas não deu pra trocar ideia direito. Lembrei de você porque a gente ajuda times como o da {empresa} a {beneficio}. Vale 15 min essa semana?', category: 'evento', call_type: 'cold', tags: 'feira,presencial,evento' },
      { situation: 'Projeto/dor mencionado pelo lead num evento setorial', product_link: 'retoma exatamente o que a pessoa comentou e oferece o produto como caminho', example_text: 'Fala {nome}! Você comentou no CWO Gov sobre aquele projeto de consolidação — a gente tem servidor com GPU justamente pra esse tipo de carga. Faz sentido eu te mostrar em 15 min como outros órgãos resolveram isso?', category: 'evento', call_type: 'cold', tags: 'palestra,projeto,dor,govtech' },
      { situation: 'Indicação de um conhecido em comum', product_link: 'usa a conexão em comum como ponte de confiança', example_text: 'Oi {nome}, o {referencia} comentou que vocês da {empresa} estão tocando {contexto} e disse que valia eu te chamar. A gente faz {beneficio}. Topa um papo rápido de 15 min?', category: 'indicacao', call_type: 'warm', tags: 'referral,indicacao' },
      { situation: 'Post/conteúdo publicado pelo lead no LinkedIn', product_link: 'reage a uma ideia específica do post e emenda no produto', example_text: 'Curti demais seu post sobre {tema}, {nome} — bateu com um problema que a gente resolve pra {setor}. Queria te mostrar em 15 min como isso vira {beneficio} na prática.', category: 'conteudo', call_type: 'cold', tags: 'linkedin,post,conteudo' },
      { situation: 'Notícia recente da empresa (expansão, rodada, contratação)', product_link: 'parabeniza pelo movimento e liga ao ganho que o produto traz nesse momento', example_text: 'Vi que a {empresa} anunciou {noticia}, {nome} — parabéns! Nessa fase costuma pesar {dor}, e é exatamente o que a gente destrava. Vale 15 min pra te mostrar?', category: 'noticia', call_type: 'cold', tags: 'noticia,expansao,funding' },
      { situation: 'Reconexão com lead que já conhece a empresa', product_link: 'retoma o relacionamento sem se reapresentar, trazendo novidade relevante', example_text: 'Oi {nome}, faz um tempo que a gente não se fala! Lançamos {novidade} e lembrei na hora do que você tinha comentado sobre {contexto}. Bora retomar num café virtual de 15 min?', category: 'reconexao', call_type: 'frozen', tags: 'reconexao,follow' },
      { situation: 'Uso conhecido de infraestrutura/tecnologia pelo lead', product_link: 'demonstra que entende o stack dele e mostra o encaixe técnico', example_text: 'Fala {nome}, sei que vocês da {empresa} rodam {stack} — a gente tem visto times parecidos ganharem {beneficio} com {produto}. Faz sentido um papo técnico rápido de 15 min?', category: 'tecnico', call_type: 'cold', tags: 'infra,tecnico,stack' },
      { situation: 'Mesma comunidade/grupo profissional', product_link: 'usa o pertencimento ao grupo como abertura natural', example_text: 'Oi {nome}, também sou do grupo {comunidade}! Vi que você toca {area} na {empresa} — a gente ajuda gente daqui com {beneficio}. Te roubo 15 min pra trocar ideia?', category: 'comunidade', call_type: 'cold', tags: 'grupo,comunidade' },
    ];
    const insHook = db.prepare('INSERT INTO hook_library (situation,product_link,example_text,category,call_type,tags,score) VALUES (?,?,?,?,?,?,5)');
    for (const h of seedHooks) insHook.run(h.situation, h.product_link, h.example_text, h.category, h.call_type, h.tags);
    console.log(`Biblioteca de ganchos populada com ${seedHooks.length} arquétipos.`);
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

      const waMsgId = msg.id || null;
      const db = getDb();

      // Dedup: se a Meta reenviou o mesmo webhook, ignoramos silenciosamente.
      if (waMsgId) {
        const dup = db.prepare('SELECT id FROM messages WHERE wa_message_id=?').get(waMsgId);
        if (dup) {
          console.log(`[WhatsApp Webhook] Reentrega ignorada (wa_message_id=${waMsgId})`);
          db.close();
          return;
        }
      }

      // Busca o contato pelo número normalizado (compara apenas os dígitos finais,
      // evitando falsos positivos do antigo LIKE '%phone%').
      const phoneTail = (phone || '').replace(/\D/g, '').slice(-8);
      const contact = db.prepare(
        `SELECT c.*, co.auto_reply_mode, co.name as company_name
           FROM contacts c JOIN companies co ON c.company_id=co.id
          WHERE c.whatsapp != ''
            AND replace(replace(replace(replace(replace(c.whatsapp,'+',''),'-',''),' ',''),'(',''),')','') LIKE ?
          LIMIT 1`
      ).get(`%${phoneTail}`);

      if (!contact) {
        console.log(`[WhatsApp Webhook] Número desconhecido: ${phone}`);
        db.close();
        return;
      }

      // 1. Abre janela de 24h
      db.prepare("UPDATE contacts SET last_wa_interaction=datetime('now') WHERE id=?").run(contact.id);

      // 2. Salva mensagem recebida (com wa_message_id para dedup futura)
      const ins = db.prepare(
        "INSERT INTO messages (contact_id,company_id,channel,day,msg_type,content,ai_original,status,approved,created_at,wa_message_id) VALUES (?,?,'whatsapp',1,'text',?,?,'received',1,datetime('now'),?)"
      ).run(contact.id, contact.company_id, text, text, waMsgId);
      const messageId = ins.lastInsertRowid;
      db.close();
      broadcastInboxUpdate();

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
          let draft = await callClaude('Você é SDR especialista em respostas rápidas.', draftPrompt, 200);
          draft = sanitizeOutbound(draft, styleProfile());

          // Salva draft e envia automaticamente
          db2.prepare(
            "INSERT INTO messages (contact_id,company_id,channel,day,msg_type,content,ai_original,status,approved,created_at) VALUES (?,?,'whatsapp',1,'text',?,?,'sent',1,datetime('now'))"
          ).run(contact.id, contact.company_id, draft, draft);

          await sendWhatsAppMessage(phone, draft);
          console.log(`[WhatsApp Webhook] Auto-reply enviado para ${phone}`);
        }
      }

      db2.close();
      broadcastInboxUpdate();
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

// Foco 100% WhatsApp: a geração (single e bulk) produz apenas mensagem de WhatsApp.
const SEQUENCE_CHANNELS = [
  { day: 1, channel: 'whatsapp', type: 'first_outreach' },
];

// ════════════════════════════════════════════════════════════════════════════
// GANCHO DA 1ª MENSAGEM — melhorias (#1 fact-check, #3 anti-template, #4 RAG,
// #6 A/B, #7 rubrica "não parece bot"). Constantes e helpers reutilizáveis.
// ════════════════════════════════════════════════════════════════════════════

// (#3) Arquétipos de abertura para popular a hook_library vazia. Dão variedade de
// estrutura e servem de few-shot para o modelo NÃO cair sempre no mesmo template.
const DEFAULT_HOOKS = [
  { situation: 'Notícia/movimento recente da empresa (expansão, rodada, contratação)', product_link: 'conecta o fato ao ganho que o produto traz', example_text: 'Vi que vocês acabaram de {fato_recente} — nesse momento, {dor_tipica} costuma virar gargalo. Foi exatamente isso que a gente resolveu com {produto}.', category: 'noticia', call_type: 'cold', tags: 'evento,noticia', score: 8 },
  { situation: 'Dor específica do cargo/setor como ponto de entrada', product_link: 'produto como resposta direta à dor', example_text: '{nome}, na maioria dos times de {setor} que falo, {dor} é o que mais trava. A gente tem ajudado a destravar isso com {produto} — sem trocar o que já funciona.', category: 'dor', call_type: 'cold', tags: 'dor,pain', score: 7 },
  { situation: 'Prova social / resultado concreto de par do mesmo setor', product_link: 'resultado numérico ligado ao produto', example_text: 'Um time de {setor} parecido com o de vocês cortou {metrica} usando {produto}. Achei que faria sentido te mostrar como.', category: 'prova_social', call_type: 'cold', tags: 'case,resultado', score: 7 },
  { situation: 'Parceria/ecossistema em comum (warm) — retoma vínculo real', product_link: 'produto dentro do contexto da parceria', example_text: 'Oi {nome}! Como {contexto_parceria}, o {produto} encaixa direto no que vocês estão montando. Vale trocar uma ideia rápida?', category: 'parceria', call_type: 'warm', tags: 'parceria,ecossistema', score: 8 },
  { situation: 'Pergunta genuína sobre prioridade atual do lead', product_link: 'produto some no fundo, foco na conversa', example_text: '{nome}, uma dúvida honesta: {pergunta_sobre_prioridade}? Pergunto porque é onde o {produto} costuma fazer mais diferença.', category: 'pergunta', call_type: 'cold', tags: 'pergunta,curiosidade', score: 6 },
];

// (#3) Clichês proibidos + instrução anti-template injetada no prompt da 1ª mensagem.
const ANTI_TEMPLATE_RULES =
  '## NATURALIDADE (obrigatório)\n' +
  '- Varie a ESTRUTURA de abertura a cada mensagem; não comece sempre igual.\n' +
  '- PROIBIDO usar clichês de robô: "espero que esteja bem", "tudo bem?", "meu nome é ... e vim aqui porque", ' +
  '"passando para apresentar", "somos uma empresa que", "gostaria de agendar", "não perca essa oportunidade".\n' +
  '- Abra por uma situação/fato/dor REAL do lead — nunca por auto-apresentação genérica.\n' +
  '- Soe como uma pessoa escrevendo no WhatsApp: direto, específico, sem jargão de marketing.\n' +
  '- PROIBIDO usar placeholders/campos a preencher como "[seu nome]", "[nome]", "{empresa}", "<link>". ' +
  'Se você não souber um dado (ex.: seu próprio nome), NÃO o mencione e reescreva a frase sem ele — nunca deixe um espaço reservado.';

// (#6) Ângulos distintos para as variantes A/B — cada uma abre por um caminho diferente.
const VARIANT_ANGLES = [
  { key: 'situacao', label: 'Abertura pela situação/fato do lead', guidance: 'Abra pela SITUAÇÃO ou FATO específico do lead (contexto/gancho) e conecte ao produto.' },
  { key: 'prova',    label: 'Abertura por prova social/resultado', guidance: 'Abra por um RESULTADO/PROVA SOCIAL concreta de um par do mesmo setor e só então conecte à realidade do lead.' },
];

// (#7) Rubrica objetiva do teste "não parece bot" (5 critérios, 0-1 cada → total 0-5).
const STYLE_RUBRIC_CRITERIA = [
  { key: 'personalizacao',    desc: 'Personalização real: cita algo específico do lead (não serve para qualquer empresa)' },
  { key: 'sem_cliche',        desc: 'Ausência de clichê de robô (sem "tudo bem?", "espero que esteja bem", auto-apresentação genérica)' },
  { key: 'produto_especifico',desc: 'Especificidade do produto: menciona o produto/uso concreto e relevante ao lead' },
  { key: 'cta_unico',         desc: 'CTA único e progressivo (uma pergunta/convite leve, sem tentar vender direto)' },
  { key: 'tom_cargo',         desc: 'Tom coerente com o cargo do contato e som humano/natural' },
];

// (#1) Detecta afirmações factuais "checáveis" (números, %, moeda, anos, nomes de produto/modelo).
// Retorna os trechos encontrados — se houver e não houver fontes, a mensagem é marcada p/ revisão.
function detectFactClaims(text) {
  const t = String(text || '');
  const claims = new Set();
  const patterns = [
    /(?:US\$|R\$|€|\$)\s?\d[\d.,]*\s?(?:bi|bilh|mi|milh|k|mil)?/gi, // valores monetários
    /\b\d+[\d.,]*\s?%/g,                                            // percentuais
    /\b(?:19|20)\d{2}\b/g,                                          // anos
    /\b\d+[\d.,]*\s?(?:TFLOPS|GB|TB|tokens\/s|GPU|GPUs|servidores|clientes|países|paises)\b/gi, // specs/quantidades
    /\bQ[1-4]\b/g,                                                  // trimestres
  ];
  for (const re of patterns) { const m = t.match(re); if (m) m.forEach(x => claims.add(x.trim())); }
  return [...claims];
}

// (#4) Monta um bloco de contexto de PRODUTO a partir do RAG (tabela documents),
// para o modelo citar specs reais em vez de inventar. Reusa extractRelevantChunk.
function buildProductContext(db, terms, maxChars = 1200) {
  try {
    const docs = db.prepare('SELECT name, content FROM documents').all();
    if (!docs.length) return '';
    const rankTerms = String(terms || '').toLowerCase().split(/\s+/).filter(t => t.length >= 4);
    const scored = docs.map(d => {
      const low = String(d.content || '').toLowerCase();
      let score = 0;
      for (const t of rankTerms) { let idx = low.indexOf(t); while (idx !== -1) { score++; idx = low.indexOf(t, idx + t.length); } }
      return { ...d, score };
    });
    const relevant = scored.filter(d => d.score > 0).sort((a, b) => b.score - a.score);
    const pick = (relevant.length ? relevant : scored).slice(0, 2);
    if (!pick.length) return '';
    const body = pick.map(d => `[${d.name}] ${extractRelevantChunk(d.content, rankTerms, Math.floor(maxChars / pick.length))}`).join('\n');
    return '## BASE DE PRODUTO (use specs/fatos REAIS daqui; NÃO invente números)\n' + body;
  } catch (e) { console.warn('[product-context] indisponível:', e.message); return ''; }
}

// (#7) LLM-judge: avalia uma mensagem pela rubrica e retorna {total, scores, verdict, notes}.
async function scoreMessageStyle(message, ctx = {}) {
  const rubricText = STYLE_RUBRIC_CRITERIA.map((c, i) => `${i + 1}. ${c.key}: ${c.desc}`).join('\n');
  const system = 'Você é um revisor rígido de copy de prospecção B2B. Avalia se a mensagem "não parece bot" ' +
    'e personaliza de verdade. Seja crítico: na dúvida, pontue 0. Responda SOMENTE com JSON válido.';
  const user =
    `Contexto do lead: empresa="${ctx.company || '?'}", setor="${ctx.sector || '?'}", cargo="${ctx.role || '?'}", produto="${ctx.product || '?'}".\n\n` +
    `MENSAGEM:\n"""${message}"""\n\n` +
    `Avalie cada critério com 0 (falha) ou 1 (cumpre):\n${rubricText}\n\n` +
    'Retorne JSON plano: {"scores":{"personalizacao":0|1,"sem_cliche":0|1,"produto_especifico":0|1,"cta_unico":0|1,"tom_cargo":0|1},' +
    '"total":0-5,"verdict":"passou"|"ajustar"|"reprovou","notes":"1 frase objetiva"}. ' +
    'verdict="passou" só se total>=4 e sem_cliche=1 e personalizacao=1.';
  const raw = await callClaude(system, user, 400);
  let clean = String(raw || '').replace(/```json\s*|\s*```/g, '').trim();
  const m = clean.match(/\{[\s\S]*\}/); if (m) clean = m[0];
  try {
    const p = JSON.parse(clean);
    const scores = p.scores || {};
    const total = typeof p.total === 'number' ? p.total : Object.values(scores).reduce((a, b) => a + (Number(b) || 0), 0);
    return { total, scores, verdict: p.verdict || (total >= 4 ? 'passou' : 'ajustar'), notes: p.notes || '' };
  } catch { return { total: null, scores: {}, verdict: 'erro', notes: 'Falha ao interpretar avaliação do juiz', raw }; }
}

// ── Flags/Etiquetas de empresa ────────────────────────────────────────────────
// Catálogo de etiquetas aplicáveis a empresas. `blocks_outreach: true` faz a
// automação (geração de sequência) ser bloqueada para a empresa.
const COMPANY_FLAGS = [
  { key: 'nao_contatar',        label: 'Não contatar',         badge: 'bg-danger',            blocks_outreach: true },
  { key: 'ja_contato',          label: 'Já contatada',         badge: 'bg-warning text-dark', blocks_outreach: false },
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

// Detecção de relacionamento prévio + duplicidade entre empresas mora em
// lib/relationships.js (testável isoladamente). Reexporta-se aqui para uso local.
const { RELATIONSHIP_FLAG_KEYS, PRIOR_RELATIONSHIP_WARNING, companyHasPriorRelationship, priorRelationshipInfo, contactCreationWarnings } = rel;

// (#3) Detecção/limpeza de placeholders foi movida para lib/humanize.js
// (findUnresolvedPlaceholders / stripPlaceholders / sanitizeOutbound) — importadas abaixo.

// (#5/#7) Parser leve de data/hora em PT-BR para negociação de agenda.
// Reconhece dia da semana (segunda..sexta/sáb/dom), "amanhã/hoje", e hora ("15h", "15:30", "às 9").
// Retorna { iso, label } do próximo horário compatível, ou null. Usa a data atual do servidor.
const WEEKDAYS_PT = { domingo: 0, segunda: 1, terca: 2, 'terça': 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6, 'sábado': 6 };
function parseMeetingDateTime(text, now = new Date()) {
  if (!text) return null;
  const t = text.toLowerCase();
  // hora
  const hm = t.match(/\b(\d{1,2})\s*(?:h|:)\s*(\d{2})?\b/) || t.match(/\b[àa]s?\s+(\d{1,2})\b/);
  if (!hm) return null;
  let hour = parseInt(hm[1]); const min = hm[2] ? parseInt(hm[2]) : 0;
  if (hour < 0 || hour > 23) return null;
  const target = new Date(now);
  let matchedDay = false;
  if (/\bamanh[ãa]\b/.test(t)) { target.setDate(now.getDate() + 1); matchedDay = true; }
  else if (/\bhoje\b/.test(t)) { matchedDay = true; }
  else {
    for (const [name, dow] of Object.entries(WEEKDAYS_PT)) {
      if (t.includes(name)) {
        const diff = (dow - now.getDay() + 7) % 7 || 7; // próxima ocorrência (nunca hoje)
        target.setDate(now.getDate() + diff); matchedDay = true; break;
      }
    }
  }
  if (!matchedDay) return null;
  target.setHours(hour, min, 0, 0);
  const label = target.toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  // ISO local (sem timezone shift): YYYY-MM-DDTHH:MM:00
  const pad = (n) => String(n).padStart(2, '0');
  const iso = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(hour)}:${pad(min)}:00`;
  return { iso, label };
}

// (#10) LGPD/consentimento: retorna motivo (string) se o envio deve ser bloqueado, ou null se liberado.
// Bloqueia se: empresa opted_out, contato opted_out, ou flag de "não contatar" na empresa.
function sendingBlockedByConsent(db, companyId, contactId) {
  try {
    if (companyId) {
      const co = db.prepare('SELECT opted_out FROM companies WHERE id=?').get(companyId);
      if (co && co.opted_out) return 'Empresa marcada como opt-out (blacklist)';
      if (companyIsBlocked(db, companyId)) return "Empresa com flag 'não contatar'";
    }
    if (contactId) {
      const ct = db.prepare('SELECT opted_out FROM contacts WHERE id=?').get(contactId);
      if (ct && ct.opted_out) return 'Contato marcado como opt-out';
    }
  } catch (_) { /* colunas ausentes: não bloqueia */ }
  return null;
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

// Normaliza uma lista de turnos p/ a API do Claude: mescla turnos consecutivos do mesmo papel
// e garante que a conversa comece com 'user' (a API rejeita histórico iniciando em 'assistant').
function normalizeTurns(turns) {
  const out = [];
  for (const t of turns) {
    const txt = (t?.content || '').trim();
    if (!txt) continue;
    if (out.length && out[out.length - 1].role === t.role) out[out.length - 1].content += '\n' + txt;
    else out.push({ role: t.role, content: txt });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// `priorTurns` (opcional): histórico estruturado [{role:'user'|'assistant', content}] anexado ANTES
// do userPrompt. Melhora a coerência multi-turno vs. despejar o histórico como texto no prompt.
async function callClaude(systemPrompt, userPrompt, maxTokens = 800, priorTurns = null) {
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

    // Remetente conforme o perfil do usuário (vendas = nome próprio; marketing = marca).
    const senderMatch = userPrompt.match(/Remetente:\s*([^\n]+)/);
    const senderRaw = senderMatch ? senderMatch[1] : '';
    const isMarketing = /perfil marketing/i.test(senderRaw);
    let signature, intro;
    if (isMarketing) {
      const b = senderRaw.match(/empresa\s+"([^"]+)"/i);
      const brand = (b ? b[1] : 'nossa empresa').trim();
      signature = brand;
      intro = `aqui é da ${brand}`;
    } else if (senderRaw) {
      const full = senderRaw.replace(/\s*\(perfil.*$/i, '').trim() || 'Equipe de Vendas';
      signature = full;
      intro = `aqui é o ${full.split(/\s+/)[0]}`;
    } else {
      signature = 'SDR Sales AI';
      intro = 'tudo bem';
    }

    if (channel === 'linkedin') {
      return `Olá ${contactName}, ${intro} — vi que você atua na ${companyName} e achei interessante o seu perfil. Ajudamos empresas de tecnologia a otimizarem seus fluxos comerciais com IA. Gostaria de conectar para trocar ideias sobre o mercado B2B.\n\n${signature}`;
    } else if (channel === 'email') {
      return `Assunto: Otimização de processos comerciais na ${companyName}\n\nOlá ${contactName},\n\nTudo bem? ${isMarketing ? `Aqui é da ${signature}.` : `Meu nome é ${signature}.`}\n\nVi que você é responsável pela área comercial na ${companyName} e decidi entrar em contato. Muitas empresas do setor de tecnologia sofrem com a perda de leads qualificados devido a follow-ups lentos.\n\nDesenvolvemos uma ${product} que ajuda a automatizar a triagem e o primeiro contato via WhatsApp, aumentando as taxas de conversão de leads.\n\nVocê teria 15 minutos nesta semana para uma demonstração rápida?\n\nAbraços,\n${signature}`;
    } else {
      return `Olá ${contactName}! Tudo bem? ${isMarketing ? `Aqui é da ${signature}` : `${intro}`}.\n\nVi que você é o contato principal da ${companyName}.\n\nEstamos ajudando empresas do setor de tecnologia a automatizarem a triagem de leads com o nosso ${product}, melhorando a produtividade do time comercial.\n\nVocê teria 15 minutos para batermos um papo rápido e eu te mostrar como funciona na prática?\n\n${signature}`;
    }
  }

  // (#2) Retry com backoff exponencial para erros transitórios (429/5xx/rede).
  // Erros não-transitórios (ex.: 400/401/créditos) falham de imediato — retry não ajuda.
  const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
  const maxAttempts = 3;
  let lastErr = 'desconhecido';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
          messages: normalizeTurns([...(Array.isArray(priorTurns) ? priorTurns : []), { role: 'user', content: userPrompt }]),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        lastErr = data.error ? data.error.message : `HTTP ${res.status}`;
        if (RETRYABLE.has(res.status) && attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, 400 * 2 ** (attempt - 1)));
          continue;
        }
        return `${AI_ERROR_PREFIX} ${lastErr}]`;
      }
      return data.content[0].text;
    } catch (e) {
      // Falha de rede: transitória, vale retry
      lastErr = e.message;
      if (attempt < maxAttempts) { await new Promise(r => setTimeout(r, 400 * 2 ** (attempt - 1))); continue; }
      return `${AI_ERROR_PREFIX} ${lastErr}]`;
    }
  }
  return `${AI_ERROR_PREFIX} ${lastErr}]`;
}

// (#2) Sentinela de falha da IA. Endpoints que PERSISTEM mensagens devem checar isAiError()
// e abortar (502) em vez de gravar o texto de erro como se fosse uma mensagem real.
const AI_ERROR_PREFIX = '[ERRO API:';
function isAiError(text) {
  return typeof text === 'string' && text.startsWith(AI_ERROR_PREFIX);
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

// Prepara o contexto de abordagem conforme o TIPO DE CALL do contato.
// - cold  : lead totalmente novo → dispara busca automática na WEB + base de conhecimento
//           (golden_cases/learned_patterns) e registra cada passo em `search_logs`.
// - warm  : lead já qualificado → usa EXATAMENTE o contexto manual do operador, SEM busca.
// - frozen: lead que já conhece a empresa → usa contexto/histórico existente, sem busca nova.
async function prepareCallContext(company, contact, productValue) {
  const callType = normalizeCallType(contact?.call_type);
  productValue = productValue || 'solução de automação de vendas com IA';

  if (callType === 'warm') {
    console.log(`[warm-call] contato ${contact?.id} (${contact?.name}) — usando contexto manual do operador, SEM busca automática.`);
    return { call_type: 'warm', hook: null, autoResearched: false, manualContext: contact?.context || '' };
  }
  if (callType === 'frozen') {
    console.log(`[frozen-call] contato ${contact?.id} (${contact?.name}) — lead já conhece a empresa; reconexão, sem busca nova.`);
    return { call_type: 'frozen', hook: company?.research_hook || null, autoResearched: false, manualContext: contact?.context || '' };
  }

  // ── COLD: lead novo, sem vínculo prévio → pesquisar antes de abordar ──────────
  console.log(`[cold-search] contato ${contact?.id} (${contact?.name}) — lead novo; iniciando busca externa (web + base de conhecimento)...`);
  const roleInfo = ROLE_PROFILES[contact?.role] || ROLE_PROFILES.other;

  // 1) Base de conhecimento interna (golden_cases + padrões aprendidos)
  let kbSummary = '';
  const dbk = getDb();
  try {
    const golden = dbk.prepare('SELECT content FROM golden_cases ORDER BY score DESC LIMIT 2').all();
    const goldenCtx = golden.map(g => g.content).join('\n');
    const learned = buildLearnedContext(dbk, 'whatsapp', contact?.role || 'other');
    kbSummary = [goldenCtx, learned].filter(Boolean).join('\n');
    dbk.prepare('INSERT INTO search_logs (company_id, contact_id, call_type, source, query, result_summary) VALUES (?,?,?,?,?,?)')
      .run(company.id, contact?.id || null, 'cold', 'knowledge_base',
           `base de conhecimento (golden_cases + learned_patterns, role=${contact?.role || 'other'})`,
           (kbSummary || '(vazio)').slice(0, 500));
  } catch (e) { console.warn('[cold-search] base de conhecimento indisponível:', e.message); }
  // Biblioteca de ganchos: orienta o formato "situação real → produto" já na geração do hook.
  let hookExamples = '';
  try { hookExamples = buildHookExamples(dbk, { callType: 'cold', limit: 3 }); } catch (_) {}
  dbk.close();
  console.log(`[cold-search] base de conhecimento consultada (${kbSummary.length} chars).`);

  // 2) Busca na WEB (Claude com web_search nativo)
  const webQuery = `Notícias e contexto recentes sobre a empresa "${company.name}"${company.sector ? ' (setor: ' + company.sector + ')' : ''}${contact ? ' e o contato ' + contact.name + ' (' + contact.role + ')' : ''}`;
  const prompt = `
Pesquise na WEB informações REAIS e recentes sobre a empresa "${company.name}"${company.sector ? ' (setor: ' + company.sector + ')' : ''}${contact ? ' e, se possível, sobre o contato ' + contact.name + ' (' + contact.role + ')' : ''}. Procure por: notícias recentes, expansões, contratações, rodadas de investimento, lançamentos de produto, parcerias e desafios do setor.

Produto sendo vendido: ${productValue}
Perfil do cargo: foco em ${roleInfo.focus}, tom ${roleInfo.tone}
${kbSummary ? 'Base de conhecimento interna (use como apoio):\n' + kbSummary.slice(0, 800) : ''}
${hookExamples ? hookExamples.slice(0, 900) : ''}

Com base SOMENTE no que você encontrar na web, gere um JSON PLANO e CONCISO com exatamente estas chaves:
- "research_context": array de 2-3 strings curtas (uma frase cada), cada uma com um fato REAL encontrado
- "hook": uma única string (máx 2 linhas) que abra por uma SITUAÇÃO/CONTEXTO real encontrado e conecte ao produto, no tom natural dos exemplos da biblioteca (sem soar robótico)
- "pain_points": array de exatamente 3 strings (dores específicas do setor/porte)
- "value_proposition": uma única string
- "sources": array de URLs usados como fonte (strings)

Não aninhe objetos. Se não encontrar nada específico na web, baseie-se em tendências reais do setor e indique isso. Responda APENAS com JSON válido, sem markdown, sem comentários.`;

  const result = await callClaudeWithSearch('Você é assistente de pesquisa de vendas B2B que usa busca na web para encontrar informações reais e atuais sobre empresas e seus executivos.', prompt, 2600);
  let hook, ctx, sources = [];
  let raw = (result || '').replace(/```json\s*|\s*```/g, '').trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) raw = jsonMatch[0];
  try {
    const p = JSON.parse(raw);
    hook = p.hook || result; ctx = JSON.stringify(p);
    if (Array.isArray(p.sources)) sources = p.sources.filter(Boolean);
  }
  catch { hook = result; ctx = result; }

  const dbw = getDb();
  dbw.prepare('INSERT INTO search_logs (company_id, contact_id, call_type, source, query, result_summary) VALUES (?,?,?,?,?,?)')
    .run(company.id, contact?.id || null, 'cold', 'web', webQuery, (hook || '(sem retorno)').slice(0, 500));
  dbw.prepare('UPDATE companies SET research_hook=?, research_context=?, status=? WHERE id=?').run(hook, ctx, 'researched', company.id);
  // Retenção: mantém apenas os 30 registros de busca mais recentes por contato.
  if (contact?.id) {
    dbw.prepare(`DELETE FROM search_logs WHERE contact_id=? AND id NOT IN (
      SELECT id FROM search_logs WHERE contact_id=? ORDER BY id DESC LIMIT 30
    )`).run(contact.id, contact.id);
  }
  dbw.close();
  console.log(`[cold-search] busca web concluída. hook="${(hook || '').slice(0, 80)}" (${sources.length} fontes)`);
  return { call_type: 'cold', hook, autoResearched: true, manualContext: contact?.context || '', sources };
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

// Nota: a rota principal `/` é servida pelo build React em `public/index.html`
// via `express.static` (middleware no topo) e pelo catch-all no final do arquivo.
// A antiga rota server-rendered (templates/index.html) foi removida por ser código morto.

// ════════════════════════════════════════════════════════════════════════════
// API — todas protegidas
// ════════════════════════════════════════════════════════════════════════════
app.use('/api', requireLogin);

// (#9) Rate limiting simples em memória por usuário/IP (janela deslizante).
// Protege contra abuso/loop acidental. Ajustável por env; healthchecks isentos.
const RL_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000');
const RL_MAX = parseInt(process.env.RATE_LIMIT_MAX || '120');
const _rlHits = new Map(); // key -> number[] (timestamps)
app.use('/api', (req, res, next) => {
  const key = (req.session && req.session.userId) ? `u:${req.session.userId}` : `ip:${req.ip}`;
  const now = Date.now();
  const arr = (_rlHits.get(key) || []).filter(ts => now - ts < RL_WINDOW_MS);
  arr.push(now);
  _rlHits.set(key, arr);
  if (arr.length > RL_MAX) {
    res.set('Retry-After', String(Math.ceil(RL_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Muitas requisições — tente novamente em instantes.' });
  }
  next();
});

// (#9) Audit log: registra ações sensíveis (aprovar/enviar/agendar) com autor e timestamp.
function audit(req, action, details, refs = {}) {
  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO audit_logs (user_id, username, action, details, company_id, contact_id, message_id, created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))"
    ).run(
      req.session?.userId || null, req.session?.username || null, action, details || '',
      refs.company_id || null, refs.contact_id || null, refs.message_id || null
    );
    db.close();
  } catch (e) { console.warn('[audit] falhou:', e.message); }
}

// Me
app.get('/api/me', (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT username, name, user_type, company_name, signature_name FROM users WHERE id=?').get(req.session.userId);
  db.close();
  res.json({
    username: req.session.username,
    name: req.session.name,
    user_type: u?.user_type || 'vendas',
    company_name: u?.company_name || '',
    signature_name: u?.signature_name || '',
    // Nome pessoal utilizável para assinar/apresentar (null se só houver nome genérico).
    // O front usa isto para avisar o vendedor a configurar o nome antes de gerar mensagens.
    sales_name: resolveSalesName(u),
  });
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
    cold_calls_total:    db.prepare("SELECT COUNT(*) as c FROM call_events WHERE call_type='cold'").get().c,
    warm_calls_total:    db.prepare("SELECT COUNT(*) as c FROM call_events WHERE call_type='warm'").get().c,
    frozen_calls_total:  db.prepare("SELECT COUNT(*) as c FROM call_events WHERE call_type='frozen'").get().c,
  });
  db.close();
});

// Contagem e histórico de abordagens (cold/warm/frozen) de uma empresa.
app.get('/api/companies/:id/call-stats', (req, res) => {
  const db = getDb();
  const company = db.prepare('SELECT id FROM companies WHERE id=?').get(req.params.id);
  if (!company) { db.close(); return res.status(404).json({ error: 'Empresa não encontrada' }); }
  const rows = db.prepare('SELECT call_type, COUNT(*) as c FROM call_events WHERE company_id=? GROUP BY call_type').all(req.params.id);
  const counts = { cold: 0, warm: 0, frozen: 0 };
  for (const r of rows) { if (counts[r.call_type] !== undefined) counts[r.call_type] = r.c; }
  const total = counts.cold + counts.warm + counts.frozen;
  const history = db.prepare(
    `SELECT e.call_type, e.contact_id, e.created_at, c.name as contact_name
     FROM call_events e LEFT JOIN contacts c ON c.id = e.contact_id
     WHERE e.company_id=? ORDER BY e.created_at DESC, e.id DESC LIMIT 50`
  ).all(req.params.id);
  db.close();
  res.json({ ...counts, total, history });
});

// ── Companies ─────────────────────────────────────────────────────────────────
app.get('/api/companies', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT c.*,
      COUNT(ct.id) as contact_count,
      GROUP_CONCAT(ct.name || ' (' || ct.role || ')', '||') as contacts_summary,
      u.name as created_by_name, u.username as created_by_username,
      (SELECT COUNT(*) FROM call_events e WHERE e.company_id=c.id AND e.call_type='cold')   as cold_calls,
      (SELECT COUNT(*) FROM call_events e WHERE e.company_id=c.id AND e.call_type='warm')   as warm_calls,
      (SELECT COUNT(*) FROM call_events e WHERE e.company_id=c.id AND e.call_type='frozen') as frozen_calls,
      (SELECT GROUP_CONCAT(cf.flag) FROM company_flags cf WHERE cf.company_id=c.id) as flags
    FROM companies c
    LEFT JOIN contacts ct ON ct.company_id = c.id
    LEFT JOIN users u ON u.id = c.created_by
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `).all();

  for (const row of rows) {
    row.contacts = db.prepare('SELECT * FROM contacts WHERE company_id=? ORDER BY is_primary DESC, created_at ASC').all(row.id);
    row.flags = row.flags ? row.flags.split(',') : [];
    // Indicador derivado de múltiplos sinais (etiqueta + contatos warm/frozen +
    // mensagens + abordagens anteriores), não só da etiqueta manual.
    const prior = priorRelationshipInfo(db, row.id);
    row.has_prior_relationship = prior.has;
    row.prior_relationship_reasons = prior.reasons;
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
  const contactCallType = normalizeCallType(req.body.contact_call_type);
  if (!name) return res.status(400).json({ error: 'Nome da empresa é obrigatório' });
  const db = getDb();
  try {
    // Deduplicação por chave normalizada (ignora acento/caixa/espaços):
    // "Itaú" e "Itau" são tratadas como a mesma empresa.
    const nameKey = normalizeCompanyKey(name);
    const dup = db.prepare('SELECT id, name FROM companies').all().find((c) => normalizeCompanyKey(c.name) === nameKey);
    if (dup) return res.status(409).json({ error: 'Empresa já cadastrada', existing_id: dup.id });
    // Valida e-mail do primeiro contato antes de criar a empresa (evita órfã).
    if (contact_name && contact_name.trim() && contact_email && !isValidEmailServer(contact_email)) {
      return res.status(400).json({ error: 'E-mail do contato inválido' });
    }
    const r = db.prepare('INSERT INTO companies (name, sector, created_by) VALUES (?, ?, ?)').run(name, sector || '', req.session.userId || null);
    const companyId = r.lastInsertRowid;
    db.prepare('INSERT INTO consent_logs (company_id, action, details) VALUES (?, ?, ?)').run(companyId, 'company_added', `Empresa "${name}" adicionada ao sistema`);
    // Cria o primeiro contato (enviado pelo formulário "Nova Empresa") se informado.
    let contactId = null;
    let notice = { warning: null, prior_relationship: null, duplicate_contacts: [], suggested_call_type: null };
    if (contact_name && contact_name.trim()) {
      const normalizedWa = normalizePhone(contact_whatsapp);
      const cr = db.prepare('INSERT INTO contacts (company_id, name, role, email, linkedin, whatsapp, is_primary, call_type) VALUES (?,?,?,?,?,?,1,?)')
        .run(companyId, contact_name.trim(), contact_role || 'other', contact_email || '', contact_linkedin || '', normalizedWa, contactCallType);
      contactId = cr.lastInsertRowid;
      db.prepare('INSERT INTO consent_logs (company_id, contact_id, action, details) VALUES (?,?,?,?)').run(companyId, contactId, 'contact_added', `Contato "${contact_name.trim()}" adicionado`);
      // Sinaliza relacionamento prévio (cold) e/ou contato duplicado em outra empresa.
      notice = contactCreationWarnings(db, companyId, contactCallType, { email: contact_email, whatsapp: normalizedWa, linkedin: contact_linkedin });
      if (notice.warning) {
        db.prepare('INSERT INTO consent_logs (company_id, contact_id, action, details) VALUES (?,?,?,?)').run(companyId, contactId, 'contact_warning', notice.warning);
      }
    }
    res.json({ id: companyId, contact_id: contactId, ...notice });
  } finally {
    db.close();
  }
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

  const insCompany    = db.prepare('INSERT INTO companies (name, sector, import_source, created_by) VALUES (?, ?, ?, ?)');
  const logCompany    = db.prepare('INSERT INTO consent_logs (company_id, action, details) VALUES (?,?,?)');
  const findContact   = db.prepare("SELECT id FROM contacts WHERE email != '' AND email=? AND company_id=?");
  const findContactByName = db.prepare('SELECT id FROM contacts WHERE LOWER(TRIM(name))=LOWER(TRIM(?)) AND company_id=?');
  const countContacts = db.prepare('SELECT COUNT(*) as c FROM contacts WHERE company_id=?');
  const insContact    = db.prepare('INSERT INTO contacts (company_id, name, role, title, email, linkedin, whatsapp, is_primary, import_source) VALUES (?,?,?,?,?,?,?,?,?)');
  const backfillTitle = db.prepare("UPDATE contacts SET title=? WHERE id=? AND (title IS NULL OR title='')");
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
      companyId = insCompany.run(companyName, (row.sector || '').toString().trim(), importSource, req.session.userId || null).lastInsertRowid;
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
    const rawTitle = (row.role || '').toString().trim().slice(0, 120); // cargo original da planilha
    const dup = (email && findContact.get(email, companyId)) || (!email && findContactByName.get(contactName, companyId));
    if (dup) { if (rawTitle) backfillTitle.run(rawTitle, dup.id); skipped++; continue; } // preenche o cargo se faltava

    const isPrimary = countContacts.get(companyId).c === 0 ? 1 : 0;
    const cr = insContact.run(companyId, contactName, roleFromText(row.role), rawTitle, email, '', normalizePhone(row.whatsapp), isPrimary, importSource);
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
  const messages = db.prepare('SELECT m.*, ct.name as contact_name FROM messages m LEFT JOIN contacts ct ON m.contact_id=ct.id WHERE m.company_id=? ORDER BY m.day, m.id ASC').all(req.params.id);
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
  try {
    const company = db.prepare('SELECT id FROM companies WHERE id=?').get(req.params.id);
    if (!company) return res.status(404).json({ error: 'Empresa não encontrada' });

    if (email && !isValidEmailServer(email)) {
      return res.status(400).json({ error: 'E-mail inválido' });
    }
    if (email) {
      const dup = db.prepare("SELECT id FROM contacts WHERE email != '' AND email=? AND company_id=?").get(email, req.params.id);
      if (dup) return res.status(409).json({ error: 'Contato com este e-mail já cadastrado nesta empresa' });
    }

    const isPrimary = db.prepare('SELECT COUNT(*) as c FROM contacts WHERE company_id=?').get(req.params.id).c === 0 ? 1 : 0;
    const normalizedWa = normalizePhone(whatsapp);
    const callType = normalizeCallType(req.body.call_type);
    const r = db.prepare('INSERT INTO contacts (company_id, name, role, email, linkedin, whatsapp, is_primary, call_type) VALUES (?,?,?,?,?,?,?,?)').run(req.params.id, name, role || 'other', email || '', linkedin || '', normalizedWa, isPrimary, callType);
    db.prepare('INSERT INTO consent_logs (company_id, contact_id, action, details) VALUES (?,?,?,?)').run(req.params.id, r.lastInsertRowid, 'contact_added', `Contato "${name}" adicionado`);

    // Sinaliza (sem bloquear): relacionamento prévio (cold em empresa já contatada)
    // e/ou contato duplicado em outra(s) empresa(s). Ver lib/relationships.js.
    const notice = contactCreationWarnings(db, req.params.id, callType, { email, whatsapp: normalizedWa, linkedin });
    if (notice.warning) {
      db.prepare('INSERT INTO consent_logs (company_id, contact_id, action, details) VALUES (?,?,?,?)').run(req.params.id, r.lastInsertRowid, 'contact_warning', notice.warning);
    }
    res.json({ id: r.lastInsertRowid, ...notice });
  } finally {
    db.close();
  }
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
  // call_type é opcional no PATCH: se não vier, mantém o valor atual.
  if (req.body.call_type !== undefined) {
    db.prepare('UPDATE contacts SET call_type=? WHERE id=? AND company_id=?')
      .run(normalizeCallType(req.body.call_type), req.params.contactId, req.params.companyId);
  }
  db.prepare('UPDATE contacts SET name=?, role=?, email=?, linkedin=?, whatsapp=? WHERE id=? AND company_id=?')
    .run(name, role || 'other', email || '', linkedin || '', normalizedWa, req.params.contactId, req.params.companyId);
  db.close();
  res.json({ ok: true });
});

app.patch('/api/companies/:companyId/contacts/:contactId/set-primary', (req, res) => {
  const db = getDb();
  const contact = db.prepare('SELECT id FROM contacts WHERE id=? AND company_id=?').get(req.params.contactId, req.params.companyId);
  if (!contact) { db.close(); return res.status(404).json({ error: 'Contato não encontrado' }); }
  clearPrimaryContact(db, req.params.companyId);
  db.prepare('UPDATE contacts SET is_primary=1 WHERE id=?').run(req.params.contactId);
  db.close();
  res.json({ ok: true });
});

app.delete('/api/companies/:companyId/contacts/:contactId', (req, res) => {
  const { companyId, contactId } = req.params;
  const db = getDb();
  try {
    // Remove tudo que referencia o contato ANTES (senão a FK bloqueia a exclusão).
    for (const t of ['messages', 'sentiment_logs', 'consent_logs', 'schedule_slots', 'notifications']) {
      db.prepare(`DELETE FROM ${t} WHERE contact_id=?`).run(contactId);
    }
    const r = db.prepare('DELETE FROM contacts WHERE id=? AND company_id=?').run(contactId, companyId);
    db.close();
    res.json({ ok: true, deleted: r.changes });
  } catch (e) {
    db.close();
    res.status(500).json({ error: 'Erro ao excluir contato: ' + (e.message || e) });
  }
});

// Contexto pessoal do lead (texto livre) — usado para enriquecer o gancho gerado pela IA
// e para o operador lembrar quem é a pessoa.
app.put('/api/contacts/:id/context', (req, res) => {
  const context = (req.body.context || '').toString();
  const db = getDb();
  const contact = db.prepare('SELECT id FROM contacts WHERE id=?').get(req.params.id);
  if (!contact) { db.close(); return res.status(404).json({ error: 'Contato não encontrado' }); }
  db.prepare('UPDATE contacts SET context=? WHERE id=?').run(context, req.params.id);
  db.close();
  res.json({ ok: true, context });
});

// Atualiza apenas o tipo de call de um contato (cold/warm/frozen) — usado pelo painel do contato.
app.put('/api/contacts/:id/call-type', (req, res) => {
  const callType = normalizeCallType(req.body.call_type);
  const db = getDb();
  const contact = db.prepare('SELECT id FROM contacts WHERE id=?').get(req.params.id);
  if (!contact) { db.close(); return res.status(404).json({ error: 'Contato não encontrado' }); }
  db.prepare('UPDATE contacts SET call_type=? WHERE id=?').run(callType, req.params.id);
  db.close();
  res.json({ ok: true, call_type: callType });
});

// Log das buscas externas (internet + base de conhecimento) feitas para um contato.
// Usado para VERIFICAR que o cold call disparou pesquisa antes de gerar a mensagem.
app.get('/api/contacts/:id/search-logs', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM search_logs WHERE contact_id=? ORDER BY id DESC LIMIT 50').all(req.params.id);
  db.close();
  res.json(rows);
});

// Envia uma mensagem de WhatsApp avulsa na conversa (mensagem de saída, nossa).
// Usado no workspace da aba WhatsApp para iniciar/continuar a conversa com o lead
// sem precisar gerar a sequência multicanal.
app.post('/api/companies/:id/message', (req, res) => {
  const content = (req.body.content || '').toString().trim();
  if (!content) return res.status(400).json({ error: 'Mensagem vazia' });
  const db = getDb();
  const contact = req.body.contact_id
    ? db.prepare('SELECT * FROM contacts WHERE id=? AND company_id=?').get(req.body.contact_id, req.params.id)
    : db.prepare('SELECT * FROM contacts WHERE company_id=? AND is_primary=1').get(req.params.id)
      || db.prepare('SELECT * FROM contacts WHERE company_id=? LIMIT 1').get(req.params.id);
  if (!contact) { db.close(); return res.status(404).json({ error: 'Contato não encontrado' }); }
  const prompt_used = (req.body.prompt_used || '').toString() || null;
  const product = (req.body.product || '').toString().trim(); // produto sendo vendido (pra IA lembrar)
  // status: 'pending' = rascunho (avaliável/editável antes de enviar) | 'sent' = enviada direto.
  const status = req.body.status === 'pending' ? 'pending' : 'sent';
  const approved = status === 'sent' ? 1 : 0;
  const r = db.prepare(
    "INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, approved, created_at, prompt_used, product) VALUES (?,?,'whatsapp',1,'text',?,?,?,?,datetime('now'),?,?)"
  ).run(contact.id, req.params.id, content, content, status, approved, prompt_used, product);
  db.close();
  broadcastInboxUpdate();
  res.json({ ok: true, id: r.lastInsertRowid, status });
});

// Prompt de geração de mensagem de WhatsApp de vendas, estruturado para APROVEITAR
// o aprendizado: regras duras (o que o revisor reprovou) + checagem final anti-violação.
// ── Identidade do remetente (perfil marketing x vendas) ───────────────────────
// Retorna o usuário logado (ou null). Uso pontual na geração de mensagens.
function getSessionUser(db, req) {
  const uid = req?.session?.userId;
  if (!uid) return null;
  try { return db.prepare('SELECT id, username, name, user_type, company_name, signature_name FROM users WHERE id=?').get(uid) || null; }
  catch { return null; }
}

// Nomes genéricos/de sistema que NÃO devem virar assinatura (soam robóticos: "— Administrador").
const GENERIC_SENDER_NAMES = /^(admin|administrador|administrator|usuario|usuário|user|teste|test|root|suporte|sistema|system|demo|operador)$/i;
function isGenericSenderName(name) {
  const n = String(name || '').trim();
  if (!n) return true;
  return GENERIC_SENDER_NAMES.test(n) || GENERIC_SENDER_NAMES.test(n.split(/\s+/)[0]);
}
// Resolve o melhor nome pessoal do vendedor: prioriza signature_name; ignora nome genérico.
function resolveSalesName(user) {
  const sig = (user?.signature_name || '').trim();
  if (sig && !isGenericSenderName(sig)) return sig;
  const nm = (user?.name || '').trim();
  if (nm && !isGenericSenderName(nm)) return nm;
  return null; // sem nome pessoal utilizável → não assinar com rótulo genérico
}

// Monta o bloco de prompt que define QUEM assina/apresenta a mensagem:
// - vendas    → nome próprio do vendedor (nunca um nome genérico/de sistema)
// - marketing → nome da empresa/marca (nunca nome de pessoa)
function buildSenderBlock(user) {
  if (!user) return '';
  const type = (user.user_type || 'vendas').toLowerCase();
  if (type === 'marketing') {
    const brand = (user.company_name || '').trim() || (isGenericSenderName(user.name) ? '' : user.name) || 'nossa empresa';
    const sig = (user.signature_name || '').trim();
    const assinatura = sig ? `"${brand} — ${sig}" (a marca em primeiro lugar; a pessoa apenas complementa)` : `"${brand}" ou "Equipe ${brand}"`;
    return `\n# REMETENTE (quem apresenta/assina — OBRIGATÓRIO)
Você escreve em nome da EMPRESA "${brand}" (equipe de marketing). Apresente-se SEMPRE como a empresa "${brand}" — NUNCA use um nome de pessoa isolado como remetente. Assine como ${assinatura}.\n`;
  }
  const full = resolveSalesName(user);
  if (!full) {
    // Sem nome pessoal decente: proíbe assinatura genérica ("— Administrador") que soa a bot.
    return `\n# REMETENTE (quem assina — OBRIGATÓRIO)
Escreva como uma pessoa real da equipe comercial. NÃO assine com nome de usuário/cargo genérico (ex.: "Administrador", "Suporte", "Sistema") e NÃO use assinatura corporativa. Encerre de forma natural e humana, sem bloco de assinatura. Como você NÃO tem um nome próprio definido, NÃO se apresente pelo nome e NUNCA escreva um placeholder como "[seu nome]" — simplesmente omita a auto-apresentação.\n`;
  }
  const first = full.split(/\s+/)[0];
  return `\n# REMETENTE (quem apresenta/assina — OBRIGATÓRIO)
Você escreve em nome de ${full}, um vendedor. Ao se apresentar, use o primeiro nome "${first}". Assine/encerre como ${full}. NUNCA se apresente como uma empresa no lugar do seu nome.\n`;
}

// Linha compacta de remetente para prompts inline / modo demo offline.
function senderLine(user) {
  if (!user) return '';
  const type = (user.user_type || 'vendas').toLowerCase();
  if (type === 'marketing') {
    const brand = (user.company_name || '').trim() || (isGenericSenderName(user.name) ? '' : user.name) || 'nossa empresa';
    const sig = (user.signature_name || '').trim();
    const assina = sig ? `"${brand} — ${sig}"` : `"${brand}"`;
    return `Remetente: empresa "${brand}" (perfil marketing — apresente-se como a EMPRESA, nunca como pessoa isolada; assine ${assina})`;
  }
  const full = resolveSalesName(user);
  if (!full) return 'Remetente: pessoa real da equipe comercial — NÃO assine com nome genérico/de sistema ("Administrador", "Suporte") nem assinatura corporativa; encerre de forma natural, sem bloco de assinatura. Sem nome próprio definido: NÃO se apresente pelo nome e NUNCA use placeholder como "[seu nome]" — omita a auto-apresentação.';
  return `Remetente: ${full} (perfil vendas — apresente-se pelo primeiro nome e assine como ${full})`;
}

// Camada de humanização anti-detecção de bot (funções puras e testáveis).
const {
  BOT_WORDS, botWordScan, similarity, maxSimilarity,
  styleProfile, humanizationBlock, humanizeWhatsapp,
  splitBubbles, humanDelayMs, offHours, qualityIssues,
  findUnresolvedPlaceholders, stripPlaceholders, sanitizeOutbound,
  productMentioned,
} = require('./lib/humanize');

// Contador monotônico para agrupar variantes A/B de uma mesma geração.
// Evita Date.now() (não determinístico) e garante unicidade dentro do processo.
let __variantGroupSeq = 0;

const WA_SYSTEM = 'Você é um SDR brasileiro especialista em prospecção por WhatsApp. Escreve mensagens curtas, humanas e específicas para conseguir UMA reunião com a pessoa. Nunca soa como robô, template ou marketing genérico. Segue à risca as regras dadas pelo revisor humano. REGRA ABSOLUTA: sua resposta é SEMPRE o texto de UMA mensagem de WhatsApp pronta para enviar ao lead — você NUNCA faz perguntas, NUNCA pede esclarecimento, NUNCA comenta sobre a tarefa nem fala com o operador. Se faltar alguma informação, use o melhor palpite pelo contexto e escreva a mensagem mesmo assim.';

function buildWhatsappUserPrompt({ company, contact, observation, rules, negExamples, threadHistory, previous, product, docsContext, sender, humanBlock }) {
  const senderBlock = buildSenderBlock(sender);
  const who = `${contact?.name || 'o contato'}${contact?.role ? ` (${contact.role})` : ''}${company ? ` — empresa ${company.name}${company.sector ? `, setor ${company.sector}` : ''}` : ''}`;

  // Bloco de REGRAS APRENDIDAS estruturado (v2), separando global x canal.
  let rulesBlock = '';
  if (rules && (rules.global?.length || rules.channel?.length)) {
    rulesBlock = '\n# REGRAS APRENDIDAS com o revisor (aplique SEMPRE)';
    if (rules.global?.length)  rulesBlock += '\nGerais:\n' + rules.global.map(x => `- ${x}`).join('\n');
    if (rules.channel?.length) rulesBlock += '\nEspecíficas de WhatsApp:\n' + rules.channel.map(x => `- ${x}`).join('\n');
    rulesBlock += '\n';
  }
  // Teto de tokens (#5): limita histórico e exemplos negativos a fatias do orçamento.
  const cap = (s, n) => s && s.length > n ? s.slice(0, n) + '\n…(histórico anterior omitido)' : s;
  const histBlock = (threadHistory && threadHistory.trim())
    ? `\n# HISTÓRICO DA THREAD (respeite: não repita saudações/nome já usados; responda ao último ponto do lead)\n${cap(threadHistory, Math.floor(MAX_PROMPT_CHARS / 2))}\n`
    : '';
  const negBlock = (negExamples && negExamples.trim())
    ? `\n# EXEMPLOS NEGATIVOS (reprovados — NÃO repita estes erros)\n${cap(negExamples, Math.floor(MAX_PROMPT_CHARS / 3))}\n`
    : '';
  // (#8) Material do produto (documentos vinculados às oportunidades da empresa).
  const docsBlock = (docsContext && docsContext.trim())
    ? `\n# MATERIAL DO PRODUTO (referência — use dados concretos daqui, mas NÃO copie trechos literais)\n${cap(docsContext, Math.floor(MAX_PROMPT_CHARS / 3))}\n`
    : '';

  return `# Tarefa
Gere uma nova versão de uma mensagem de WhatsApp para ${who}. Objetivo: conseguir uma reunião curta.
${product ? `\n# Produto/serviço sendo vendido (é ISTO que a mensagem oferece — mencione de forma natural)\n${product}\n` : ''}
# Mensagem atual (BASE — mantenha o mesmo assunto, o mesmo produto/oferta e o mesmo objetivo dela)
"""${previous || '(ainda não há mensagem)'}"""

${observation
  ? `# Correção pedida pelo revisor (OBRIGATÓRIA)
A mensagem acima foi reprovada. Corrija EXATAMENTE isto: "${observation}".
Mude só o necessário para atender a correção — mantenha o mesmo assunto/produto e objetivo (a não ser que a correção seja justamente sobre trocar o assunto).`
  : `# O que fazer
NÃO houve reprovação. Gere uma VARIAÇÃO diferente da mensagem acima: mesmo assunto, mesmo produto/oferta e mesmo objetivo — mudando apenas a abordagem e a redação (abertura, ângulo, tom, estrutura). NÃO troque o tema nem remova o produto/assunto que a mensagem atual menciona.`}
${senderBlock}${contact?.context ? `\n# Sobre a pessoa (personalize)\n${contact.context}\n` : ''}${rulesBlock}${histBlock}${negBlock}${docsBlock}${humanBlock || ''}
# Regras
- Mantenha o assunto/produto da mensagem atual.
- Não pareça IA nem template; soe como um humano no WhatsApp.
- Curta: no máximo ~70 palavras, uma única mensagem.

# Checagem final (obrigatória antes de responder)
Confirme que a nova mensagem trata do MESMO assunto/produto da mensagem atual${observation ? ' e que a correção pedida foi aplicada. Uma regra "não falar sobre X" = o tema X não pode aparecer em NENHUMA frase, nem indireta, nem com sinônimos.' : '.'} Se algo estiver errado, reescreva antes de responder.

Se algum detalhe faltar (produto, etc.), NÃO pergunte e NÃO comente — escreva a melhor mensagem possível com o contexto que tem, mantendo o assunto da mensagem atual.
Responda APENAS com o texto da mensagem final de WhatsApp — jamais uma pergunta, pedido de esclarecimento ou explicação. Sem aspas, sem título, sem comentários.`;
}

// Detecta quando a IA "saiu do papel" e respondeu com uma pergunta/comentário
// em vez de uma mensagem de WhatsApp pronta.
function looksLikeMeta(t) {
  const s = (t || '').toLowerCase();
  if (/poderia me (informar|dizer|confirmar)|qual (é|e) o produto|que produto|qual produto|preciso (entender|saber|de mais|de mais detalhes)|me (informe|diga|confirme|esclare)|não ficou claro|nao ficou claro|pode esclarecer|não sei qual|nao sei qual|o revisor disse|a mensagem atual|para garantir que/.test(s)) return true;
  if (/\?\s*$/.test((t || '').trim()) && /(revisor|produto|mensagem|corrig|reescrev)/.test(s)) return true;
  return false;
}

// (#8) Contexto de material do produto: documentos vinculados às oportunidades da
// empresa (via opportunity_documents). Seleciona trechos relevantes (#2) por termo.
function buildCompanyDocsContext(db, companyId, terms, budget = Math.floor(MAX_PROMPT_CHARS / 3)) {
  if (!companyId) return '';
  const docs = db.prepare(`
    SELECT DISTINCT d.name, d.content
    FROM opportunity_documents od
    JOIN opportunities o ON o.id = od.opportunity_id
    JOIN documents d ON d.id = od.document_id
    WHERE o.company_id = ?
  `).all(companyId);
  if (!docs.length) return '';
  const perDoc = Math.floor(budget / docs.length);
  return docs.map(d => `[${d.name}]\n${extractRelevantChunk(d.content, terms, perDoc)}`).join('\n\n---\n\n');
}

async function generateWhatsapp(company, contact, observation, ctx, previous, product) {
  const { rules, negExamples, threadHistory, docsContext, sender, recentTexts, threadSeed } = ctx || {};
  const profile = (ctx && ctx.profile) || styleProfile(threadSeed);
  const humanBlock = humanizationBlock(profile);
  const basePrompt = buildWhatsappUserPrompt({ company, contact, observation, rules, negExamples, threadHistory, previous, product, docsContext, sender, humanBlock });

  // Até 3 tentativas: regenera se a IA sair do papel, usar jargão de robô, ou
  // ficar parecida demais com mensagens recentes (itens 1 e 2 do anti-bot).
  let best = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let extra = '';
    if (attempt > 0 && best) {
      const reasons = [];
      if (best.issues.botMarks.length) reasons.push(`remova termos que soam de robô/marketing: ${best.issues.botMarks.join(', ')}`);
      if (best.issues.tooSimilar) reasons.push('está parecida demais com mensagens que você já mandou — mude abertura, ângulo e palavras');
      extra = `

ATENÇÃO: reescreva do zero. ${reasons.join('. ')}. Não faça perguntas nem comentários; devolva só a mensagem.`;
    }
    let out = (await callClaude(WA_SYSTEM, basePrompt + extra, 400) || '').trim();
    if (!out || /^\[ERRO API/.test(out)) { if (best) break; return { error: 'Falha ao gerar (IA indisponível)' }; }
    if (looksLikeMeta(out)) {
      const firm = basePrompt + `

ATENÇÃO: NÃO faça perguntas nem comentários. Escreva AGORA apenas a mensagem final de WhatsApp, começando direto pela saudação ao lead pelo primeiro nome.`;
      const retry = (await callClaude(WA_SYSTEM, firm, 400) || '').trim();
      if (retry && !/^\[ERRO API/.test(retry) && !looksLikeMeta(retry)) out = retry;
      else if (previous) out = previous;
    }
    out = sanitizeOutbound(out, profile);
    const issues = qualityIssues(out, recentTexts || []);
    if (!best || issues.botMarks.length < best.issues.botMarks.length ||
        (issues.botMarks.length === best.issues.botMarks.length && issues.simScore < best.issues.simScore)) best = { text: out, issues };
    if (issues.ok) break;
  }
  return { text: best.text, prompt: basePrompt, profile, quality: best.issues };
}

// "Gerar de novo": reescreve a mensagem usando a observação do avaliador + o que a IA
// já aprendeu. Guarda a versão anterior (versionamento) antes de sobrescrever.
app.post('/api/messages/:id/regenerate', async (req, res) => {
  const db = getDb();
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);
  if (!msg) { db.close(); return res.status(404).json({ error: 'Mensagem não encontrada' }); }
  const contact = msg.contact_id ? db.prepare('SELECT * FROM contacts WHERE id=?').get(msg.contact_id) : null;
  const company = msg.company_id ? db.prepare('SELECT * FROM companies WHERE id=?').get(msg.company_id) : null;
  const role = contact?.role || 'other';
  const observation = (req.body.observation || msg.score_comment || '').toString().trim();
  const channel = msg.channel || 'whatsapp';
  // v2: blocos estruturados (regras + negativos ancorados + histórico da thread) — não mais o blob legado.
  const recentTexts = db.prepare("SELECT content FROM messages WHERE direction='outbound' AND content IS NOT NULL AND id<>? AND (thread_id=? OR company_id=?) ORDER BY id DESC LIMIT 8").all(msg.id, msg.thread_id, msg.company_id).map(r => r.content);
  const ctx = {
    rules: buildRules(db, channel, role),
    negExamples: buildNegativeExamples(db, channel),
    threadHistory: buildThreadHistory(db, msg.thread_id, msg.seq_no),
    // (#8) injeta material do produto vinculado às oportunidades desta empresa
    docsContext: buildCompanyDocsContext(db, msg.company_id, [msg.product, contact?.role, company?.sector].filter(Boolean)),
    // identidade do remetente conforme o perfil (marketing x vendas) do usuário logado
    sender: getSessionUser(db, req),
    recentTexts,
    threadSeed: msg.thread_id,
  };
  db.close();

  const gen = await generateWhatsapp(company, contact, observation, ctx, msg.content || msg.ai_original || '', msg.product || '');
  if (gen.error) return res.status(502).json({ error: gen.error });
  const newText = gen.text;
  const userPrompt = gen.prompt;

  const db2 = getDb();
  let versions = [];
  try { versions = JSON.parse(msg.versions || '[]'); } catch {}
  versions.push({
    content: msg.content, prompt_used: msg.prompt_used || null,
    score: msg.score ?? null, score_comment: msg.score_comment || null,
    created_at: msg.created_at || null,
  });
  db2.prepare('UPDATE messages SET content=?, ai_original=?, score=NULL, prompt_used=?, versions=?, style_profile=? WHERE id=?')
    .run(newText, newText, userPrompt, JSON.stringify(versions), JSON.stringify(gen.profile || {}), req.params.id);
  db2.close();
  res.json({ ok: true, content: newText, version: versions.length + 1 });
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

// ── LinkedIn (pontual, 1 lead) — Passo 1: analisar texto colado do perfil ──────
// Fluxo assistido/manual: o operador cola o conteúdo do perfil do LinkedIn e a IA
// estrutura os dados. NADA é gravado nos campos finais aqui — só fica em revisão.
// SEM MOCK: se a chave da Anthropic não estiver configurada, retorna erro claro.
const LINKEDIN_EXTRACT_SYSTEM = 'Você extrai dados estruturados de um texto de perfil do LinkedIn colado por um operador de vendas. Responda SOMENTE com um objeto JSON válido (sem markdown, sem comentários) com EXATAMENTE estas chaves: name (string), headline (string), current_role (string), current_company (string), location (string), summary (string), experience (array de strings), education (array de strings), skills (array de strings), profile_url (string). Use "" para strings ausentes e [] para listas ausentes. NUNCA invente dados que não estejam no texto.';

app.post('/api/contacts/:id/linkedin/parse', async (req, res) => {
  const contactId = req.params.id;
  const { raw_text, profile_url } = req.body || {};

  if (!raw_text || !raw_text.trim()) {
    return res.status(400).json({ ok: false, error: 'Cole o conteúdo do perfil do LinkedIn antes de analisar.' });
  }

  // SEM MOCK: exige chave real da Anthropic. Se não houver, avisa o operador.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'sk-ant-sua-chave-aqui') {
    return res.status(503).json({ ok: false, error: 'IA indisponível: configure ANTHROPIC_API_KEY para analisar o perfil do LinkedIn.' });
  }

  const db0 = getDb();
  const contact = db0.prepare('SELECT * FROM contacts WHERE id=?').get(contactId);
  db0.close();
  if (!contact) return res.status(404).json({ ok: false, error: 'Contato não encontrado' });

  const userPrompt = `Texto do perfil do LinkedIn (colado pelo operador):\n"""\n${raw_text.slice(0, 12000)}\n"""`;

  // (#7) Fallback de parsing: tenta 1x; se o JSON vier inválido, reenvia com
  // instrução mais rígida antes de desistir.
  let parsed = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    try {
      const sys = attempt === 0
        ? LINKEDIN_EXTRACT_SYSTEM
        : LINKEDIN_EXTRACT_SYSTEM + ' ATENÇÃO: sua última resposta não era JSON válido. Responda ESTA vez APENAS com o objeto JSON, começando com { e terminando com }, sem nenhum texto ao redor.';
      const raw = await callClaude(sys, userPrompt, 1200);
      parsed = JSON.parse(extractJsonLoose(raw));
    } catch (e) {
      console.warn(`[linkedin/parse] tentativa ${attempt + 1} falhou:`, e.message);
    }
  }
  if (!parsed) {
    return res.status(502).json({ ok: false, error: 'Não foi possível interpretar o perfil. Tente colar o texto novamente.' });
  }

  if (profile_url && profile_url.trim() && !parsed.profile_url) parsed.profile_url = profile_url.trim();

  // (#6) Deduplicação: avisa se esta URL de perfil já está confirmada em OUTRO contato.
  let dupWarning = null;
  const urlNorm = (parsed.profile_url || '').replace(/\/+$/, '').toLowerCase();
  if (urlNorm) {
    const dbD = getDb();
    const dup = dbD.prepare(
      "SELECT ct.id, ct.name, c.name AS company FROM contacts ct JOIN companies c ON c.id=ct.company_id " +
      "WHERE ct.id!=? AND ct.linkedin_status='confirmed' AND lower(rtrim(ct.linkedin,'/'))=?"
    ).get(contactId, urlNorm);
    dbD.close();
    if (dup) dupWarning = `Esta URL de perfil já está confirmada para "${dup.name}" (${dup.company}). Verifique se não é um homônimo.`;
  }

  const db = getDb();
  db.prepare(`
    UPDATE contacts
    SET linkedin_status = 'pending_review',
        linkedin_parsed = ?,
        linkedin_raw    = ?,
        linkedin        = CASE WHEN (linkedin IS NULL OR linkedin='') AND ?!='' THEN ? ELSE linkedin END
    WHERE id = ?
  `).run(
    JSON.stringify(parsed),
    raw_text.slice(0, 20000),
    parsed.profile_url || '', parsed.profile_url || '',
    contactId
  );
  db.close();

  res.json({ ok: true, status: 'pending_review', parsed, dup_warning: dupWarning });
});

// ── LinkedIn (pontual, 1 lead) — Passo 2: validação humana (confirmar/rejeitar) ─
// Só aqui os dados do perfil são efetivamente gravados no contato — e apenas se o
// operador confirmar que o perfil é realmente daquela pessoa.
app.post('/api/contacts/:id/linkedin/confirm', (req, res) => {
  const contactId = req.params.id;
  const { action, fields } = req.body || {};

  const db0 = getDb();
  const contact = db0.prepare('SELECT * FROM contacts WHERE id=?').get(contactId);
  db0.close();
  if (!contact) return res.status(404).json({ ok: false, error: 'Contato não encontrado' });

  const reviewer = (req.session && (req.session.name || req.session.username)) || 'desconhecido';

  if (action === 'reject') {
    const db = getDb();
    db.prepare("UPDATE contacts SET linkedin_status='rejected', linkedin_reviewed_at=datetime('now'), linkedin_reviewed_by=? WHERE id=?").run(reviewer, contactId);
    db.close();
    return res.json({ ok: true, status: 'rejected' });
  }

  if (action !== 'confirm') {
    return res.status(400).json({ ok: false, error: "action deve ser 'confirm' ou 'reject'" });
  }

  // Usa os campos editados pelo operador; se ausentes, cai no que foi extraído.
  let data = fields;
  if (!data) {
    try { data = JSON.parse(contact.linkedin_parsed || '{}'); } catch { data = {}; }
  }
  const str = v => (v == null ? '' : String(v)).trim();

  const db = getDb();
  db.prepare(`
    UPDATE contacts
    SET linkedin_status           = 'confirmed',
        linkedin_reviewed_at      = datetime('now'),
        linkedin_reviewed_by      = ?,
        linkedin_headline         = ?,
        linkedin_current_role     = ?,
        linkedin_current_company  = ?,
        linkedin_location         = ?,
        linkedin_summary          = ?,
        linkedin        = CASE WHEN ?!='' THEN ? ELSE linkedin END,
        role            = CASE WHEN (role IS NULL OR role='' OR role='other') AND ?!='' THEN ? ELSE role END
    WHERE id = ?
  `).run(
    reviewer,
    str(data.headline),
    str(data.current_role),
    str(data.current_company),
    str(data.location),
    str(data.summary),
    str(data.profile_url), str(data.profile_url),
    str(data.current_role), str(data.current_role),
    contactId
  );
  db.close();

  res.json({ ok: true, status: 'confirmed' });
});

// (#11) OCR de screenshot do perfil do LinkedIn. Recebe a imagem em base64
// (data URL ou base64 puro) e devolve o texto reconhecido, para o operador colar.
// Reusa o worker tesseract.js (por+eng) já usado no OCR de PDFs.
app.post('/api/linkedin/ocr', async (req, res) => {
  const { image } = req.body || {};
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ ok: false, error: 'Envie uma imagem (base64) do perfil.' });
  }
  const b64 = image.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
  let buffer;
  try {
    buffer = Buffer.from(b64, 'base64');
    if (!buffer.length) throw new Error('vazio');
  } catch {
    return res.status(400).json({ ok: false, error: 'Imagem inválida.' });
  }
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(buffer);
    const text = (data.text || '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return res.status(422).json({ ok: false, error: 'Não foi possível ler texto na imagem.' });
    res.json({ ok: true, text });
  } catch (e) {
    console.warn('[linkedin/ocr] falha:', e.message);
    res.status(500).json({ ok: false, error: 'Falha ao processar a imagem (OCR indisponível).' });
  }
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
  // Zera qualquer primário existente antes de marcar este como primário,
  // evitando múltiplos contatos com is_primary=1 (que duplicam a conversa no inbox).
  clearPrimaryContact(db2, company.id);
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
  const callType = normalizeCallType(contact?.call_type);
  const manualContext = (contact?.context || '').trim();
  const productValue = req.body.product_value || 'solução de automação de vendas com IA';
  const golden = db.prepare('SELECT content FROM golden_cases ORDER BY score DESC LIMIT 2').all();
  const goldenCtx = golden.map(g => g.content).join('\n');
  const learned = buildLearnedContext(db, 'whatsapp', contact?.role || 'other');
  // Identidade do remetente (vendas x marketing) do usuário logado — para o gancho
  // se apresentar/assinar com o nome do vendedor em vez de sair sem identidade.
  const sender = getSessionUser(db, req);
  const senderBlock = buildSenderBlock(sender);
  db.close();

  // (#gancho) Comportamento por TIPO DE LEAD — o "Gerar Gancho" respeita o call_type:
  //  - cold  : pesquisa na WEB + base e monta o gancho a partir de fatos reais.
  //  - warm  : SEM busca; usa EXCLUSIVAMENTE o contexto manual do operador (exige contexto).
  //  - frozen: SEM busca; mensagem de RECONEXÃO a partir do contexto/histórico já existente.
  let result;
  if (callType === 'warm') {
    if (!manualContext) {
      return res.status(400).json({
        error: 'Lead warm sem contexto: preencha o contexto do lead antes de gerar o gancho (warm não faz busca automática).',
        code: 'WARM_CONTEXT_REQUIRED',
      });
    }
    console.log(`[gancho-warm] contato ${contact?.id} (${contact?.name}) — usando contexto manual do operador, SEM busca.`);
    const warmPrompt = `
Escreva a PRIMEIRA mensagem (gancho) de WhatsApp para um lead JÁ QUALIFICADO (warm).
${senderBlock}
Use EXCLUSIVAMENTE o contexto abaixo, fornecido pelo operador. NÃO invente fatos externos, NÃO cite notícias e NÃO faça pesquisa — apenas o que está no contexto.
Empresa: "${company.name}"${company.sector ? ' (setor: ' + company.sector + ')' : ''}
Contato: ${contact.name} (${contact.role})
Produto sendo vendido: ${productValue}
Perfil do cargo: foco em ${roleInfo.focus}, tom ${roleInfo.tone}
Contexto do lead (fornecido pelo operador):
${manualContext}
${goldenCtx ? 'Exemplos de sucesso:\n' + goldenCtx : ''}
${learned ? '\nREGRAS OBRIGATÓRIAS aprendidas com o revisor humano (o hook DEVE cumprir todas):\n' + learned + '\n' : ''}

Gere um JSON PLANO e CONCISO com estas chaves:
- "hook": uma única string (máx 2 linhas) com FOCO no produto "${productValue}", tom casual de WhatsApp, sem travessão "—", sem jargão de marketing e sem placeholders como "[seu nome]".
- "pain_points": array de exatamente 3 strings (dores específicas do setor/porte).
- "value_proposition": uma única string.
Não aninhe objetos. Responda APENAS com JSON válido, sem markdown, sem comentários.`;
    result = await callClaude('Você é copywriter B2B especialista em sequências de WhatsApp.', warmPrompt, 800);
  } else if (callType === 'frozen') {
    console.log(`[gancho-frozen] contato ${contact?.id} (${contact?.name}) — reconexão, sem busca nova.`);
    const priorCtx = (company.research_context || manualContext || '').toString().trim();
    const frozenPrompt = `
Escreva uma mensagem de RECONEXÃO (gancho) de WhatsApp para um lead que JÁ CONHECE a empresa (frozen).
${senderBlock}
NÃO se apresente como primeiro contato — retome o relacionamento existente de forma natural. NÃO faça pesquisa nova.
Empresa: "${company.name}"${company.sector ? ' (setor: ' + company.sector + ')' : ''}
Contato: ${contact.name} (${contact.role})
Produto sendo vendido: ${productValue}
Contexto/histórico já existente com este lead:
${priorCtx || '(sem contexto prévio registrado — retome de forma leve, sem inventar fatos)'}
${goldenCtx ? 'Exemplos de sucesso:\n' + goldenCtx : ''}
${learned ? '\nREGRAS OBRIGATÓRIAS aprendidas com o revisor humano (o hook DEVE cumprir todas):\n' + learned + '\n' : ''}

Gere um JSON PLANO e CONCISO com estas chaves:
- "hook": uma única string (máx 2 linhas) de reconexão, com FOCO no produto "${productValue}", tom casual de WhatsApp, sem travessão "—", sem jargão e sem placeholders.
- "pain_points": array de exatamente 3 strings.
- "value_proposition": uma única string.
Não aninhe objetos. Responda APENAS com JSON válido, sem markdown, sem comentários.`;
    result = await callClaude('Você é copywriter B2B especialista em reconexão de leads no WhatsApp.', frozenPrompt, 800);
  } else {
    console.log(`[gancho-cold] contato ${contact?.id} (${contact?.name}) — lead novo; pesquisando na web + base.`);
    const prompt = `
Pesquise na WEB informações REAIS e recentes sobre a empresa "${company.name}"${company.sector ? ' (setor: ' + company.sector + ')' : ''}${contact ? ' e, se possível, sobre o contato ' + contact.name + ' (' + contact.role + ')' : ''}. Procure por: notícias recentes, expansões, contratações, rodadas de investimento, lançamentos de produto, parcerias e desafios do setor.

Produto sendo vendido: ${productValue}
Perfil do cargo: foco em ${roleInfo.focus}, tom ${roleInfo.tone}
${senderBlock}
${manualContext ? 'Contexto pessoal do lead (informado pelo operador — use para deixar o gancho mais pessoal e menos "de IA"):\n' + manualContext : ''}
${goldenCtx ? 'Exemplos de sucesso:\n' + goldenCtx : ''}
${learned ? '\nREGRAS OBRIGATÓRIAS aprendidas com o revisor humano — o "hook" DEVE cumprir TODAS, sem exceção. Uma regra do tipo "não falar sobre X" significa que o tema X não pode aparecer no hook de forma nenhuma (nem indireta, nem sinônimo):\n' + learned + '\n' : ''}

Com base SOMENTE no que você encontrar na web, gere um JSON PLANO e CONCISO com exatamente estas chaves:
- "research_context": array de 2-3 strings curtas (uma frase cada), cada uma com um fato REAL encontrado
- "hook": uma única string (máx 2 linhas) cujo FOCO é a proposta de valor concreta de "${productValue}". O produto DEVE aparecer explicitamente e ser o assunto principal da oferta; use um fato real da empresa apenas como ponte de abertura, nunca como tema central. Não termine falando só da empresa. Siga o bloco REMETENTE acima: havendo um nome de vendedor definido, abra se apresentando pelo primeiro nome dele (ex.: "Oi, aqui é a Marina, ...") — nunca use placeholder como "[seu nome]".
- "pain_points": array de exatamente 3 strings (dores específicas do setor/porte)
- "value_proposition": uma única string
- "sources": array de URLs usados como fonte (strings)

Não aninhe objetos. Se não encontrar nada específico na web, baseie-se em tendências reais do setor e indique isso.
No campo "hook": não use travessão "—", nem jargão de marketing (solução, otimizar, potencializar, etc.); escreva em tom casual de WhatsApp. PROIBIDO usar placeholders/campos a preencher como "[seu nome]", "[nome]", "{empresa}" ou "<link>": se não souber um dado, omita-o e reescreva sem espaço reservado.
Responda APENAS com JSON válido, sem markdown, sem comentários.`;
    result = await callClaudeWithSearch('Você é assistente de pesquisa de vendas B2B que usa busca na web para encontrar informações reais e atuais sobre empresas e seus executivos.', prompt, 2600);
  }
  let hook, ctx, painPoints = [];
  let raw = (result || '').replace(/```json\s*|\s*```/g, '').trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) raw = jsonMatch[0];
  try { const p = JSON.parse(raw); hook = p.hook || result; ctx = JSON.stringify(p); painPoints = Array.isArray(p.pain_points) ? p.pain_points : []; }
  catch { hook = result; ctx = result; }

  // Humaniza o hook (remove travessão "—", aspas de IA, etc.) e remove placeholders
  // não resolvidos ("[seu nome]" & cia) antes de persistir/exibir.
  // Defesa em profundidade: garante a limpeza mesmo se o modelo desobedecer o prompt.
  if (hook) hook = sanitizeOutbound(hook, styleProfile());

  // (#5) Garante que o produto seja central: se o gancho não menciona o produto,
  // reescreve UMA vez usando o contexto real já pesquisado (barato, sem nova busca web).
  if (hook && !productMentioned(hook, productValue)) {
    const rewritePrompt =
      `Reescreva este gancho de WhatsApp para que o FOCO seja o produto "${productValue}".\n` +
      `Use um fato real do contexto abaixo apenas como abertura/ponte; o produto DEVE aparecer explicitamente e ser a oferta central.\n` +
      `Não use travessão "—", nem jargão de marketing, nem placeholders. Máx 2 linhas, tom casual de WhatsApp.\n\n` +
      `Contexto pesquisado: ${ctx}\nGancho atual: ${hook}\n\nDevolva APENAS o novo gancho.`;
    const rew = await callClaude('Você é copywriter B2B especialista em WhatsApp.', rewritePrompt, 300);
    if (rew && rew.trim() && !isAiError(rew)) hook = sanitizeOutbound(rew, styleProfile());
  }

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

  // (#1) Detecta relacionamento prévio ANTES de disparar a abordagem — o momento
  // de risco real. Computado com o banco aberto e antes de limpar as mensagens.
  const priorInfo = priorRelationshipInfo(db, req.params.id);

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
  const productValue = req.body.product_value || 'solução de automação de vendas com IA';
  const golden = db.prepare('SELECT title, content FROM golden_cases WHERE score>=4 LIMIT 3').all();
  const socialProof = golden.map(g => `- ${g.title}: ${g.content.substring(0, 80)}...`).join('\n');
  // Identidade do remetente (marketing x vendas) conforme o usuário logado.
  const sender = getSessionUser(db, req);
  const senderInfo = senderLine(sender);
  db.close();

  // Prepara o contexto conforme o TIPO DE CALL (cold dispara busca; warm/frozen não).
  const callCtx = await prepareCallContext(company, contact, productValue);
  const callType = callCtx.call_type;
  const hook = callCtx.hook || company.research_hook || `Olá ${contact.name},`;
  const manualContext = (callCtx.manualContext || '').trim();
  // Warm exige contexto manual: é a única fonte da mensagem (sem busca automática).
  if (callType === 'warm' && !manualContext) {
    return res.status(400).json({
      error: 'Contato warm sem contexto: preencha o contexto do lead manualmente antes de gerar a mensagem (o warm não faz busca automática).',
      code: 'WARM_CONTEXT_REQUIRED',
    });
  }
  const callGuidance = {
    cold:   'ABORDAGEM FRIA (cold call): primeiro contato, o lead NÃO conhece a empresa. Use o gancho pesquisado para abrir de forma relevante e conquistar atenção.',
    warm:   'ABORDAGEM WARM: o lead JÁ é qualificado. Use EXCLUSIVAMENTE o contexto fornecido pelo operador abaixo — não invente fatos externos nem faça pesquisa. Personalize a partir desse contexto.',
    frozen: 'ABORDAGEM FROZEN: o lead JÁ conhece a empresa. Escreva uma mensagem de RECONEXÃO — NÃO se apresente como se fosse o primeiro contato; retome o relacionamento existente.',
  }[callType];
  const manualBlock = manualContext ? `Contexto fornecido pelo operador (use fielmente):\n${manualContext}` : '';

  const painPoint = req.body.pain_point || req.body.selected_pain || req.body.selected_pain_point || '';
  const painLine = painPoint ? ('Dor principal do lead: ' + painPoint) : '';
  const painCTA  = painPoint ? 'IMPORTANTE: a mensagem deve abordar diretamente a dor mencionada acima como ponto de entrada.' : '';

  // Biblioteca de ganchos: few-shot que orienta a 1ª mensagem a soar humana e situacional.
  // Operador pode fixar um gancho específico via hook_id ou filtrar por categoria (hook_category).
  // #4 coerência: categorias de encontro pessoal (feira/indicação/comunidade) só entram quando
  //    há contexto real que as sustente — manualContext do operador OU frozen (já se conhecem).
  // #2 rotação: exclui ganchos já usados nas últimas mensagens desta empresa.
  let hookExamples = '';
  let selectedHooks = [];
  let primaryHook = null;
  try {
    const dbh = getDb();
    const hasSupport = !!manualContext || callType === 'frozen';
    if (req.body.hook_id) {
      const picked = dbh.prepare('SELECT id, situation, product_link, example_text, category FROM hook_library WHERE id=? AND active=1').get(req.body.hook_id);
      if (picked) {
        selectedHooks = [picked];
        hookExamples = `## GANCHO ESCOLHIDO (use como base da abertura)\n- Situação: ${picked.situation}${picked.product_link ? ` → ${picked.product_link}` : ''}\n  Exemplo: """${picked.example_text}"""\n` +
          'Adapte ao contexto real deste lead — imite o tom, não copie literal.';
      }
    }
    if (!selectedHooks.length) {
      const excludeIds = recentHookIdsForCompany(dbh, req.params.id, 5);
      selectedHooks = selectHooks(dbh, { callType, category: req.body.hook_category || null, limit: 3, hasSupport, excludeIds });
      hookExamples = renderHookExamples(selectedHooks);
    }
    primaryHook = selectedHooks[0] || null;
    dbh.close();
  } catch (_) {}

  // (#4) Contexto de PRODUTO vindo do RAG (documents) — para citar specs reais, não inventar.
  let productContext = '';
  try {
    const dbr = getDb();
    productContext = buildProductContext(dbr, `${company.name} ${company.sector || ''} ${productValue} ${painPoint}`);
    dbr.close();
  } catch (_) {}

  // (#1) Fontes da pesquisa web (cold) — usadas para marcar/checar afirmações factuais.
  const researchSources = Array.isArray(callCtx.sources) ? callCtx.sources : [];

  const results = [];
  for (const tpl of SEQUENCE_CHANNELS) {
    const channelDesc = {
      linkedin: 'mensagem de conexão no LinkedIn (máx 300 chars, tom informal)',
      email:    'email de prospecção (inclua assunto na 1ª linha como "Assunto: ...", corpo máx 150 palavras)',
      whatsapp: 'mensagem WhatsApp (casual, máx 100 palavras)',
    }[tpl.channel];

    // (#6) Primeira mensagem gera 2 variantes A/B (ângulos distintos); demais, 1.
    const isFirst = (tpl.day === 1 || tpl.type === 'first_outreach');
    const angles = isFirst ? VARIANT_ANGLES : [{ key: 'unico', label: '', guidance: '' }];
    const variantGroup = `${contact.id}-${++__variantGroupSeq}`;

    let variantNo = 0;
    for (const angle of angles) {
      variantNo++;
      const prompt = `
${callGuidance}
${senderInfo}
Empresa: ${company.name} (setor: ${company.sector || 'não definido'})
Contato: ${contact.name}, cargo ${contact.role}
Gancho: ${hook}
Produto: ${productValue}
${manualBlock}
${painLine}
Tom: ${roleInfo.tone} | Foco: ${roleInfo.focus}
Canal / Dia ${tpl.day}: ${channelDesc}
${productContext}
${socialProof ? 'Casos de sucesso:\n' + socialProof : ''}
${isFirst && hookExamples ? hookExamples : ''}
${isFirst ? ANTI_TEMPLATE_RULES : ''}
${angle.guidance ? '## ÂNGULO DESTA VARIANTE\n' + angle.guidance : ''}

REGRA FACTUAL: só cite números, datas ou nomes próprios se vierem do gancho pesquisado, do contexto do operador ou da BASE DE PRODUTO acima. NUNCA invente estatísticas.

Escreva APENAS o texto da mensagem, sem explicações.
${painCTA}
CTA progressivo: convide para "conversa de 15 minutos" ou "demo rápida". NÃO tente vender diretamente.`;

      let content = await callClaude('Você é copywriter B2B especialista em sequências multicanal.', prompt, 400);
      // (#2) Se a IA falhou, aborta SEM gravar texto de erro como mensagem da sequência.
      if (isAiError(content)) {
        return res.status(502).json({ error: 'IA indisponível ao gerar a sequência', detail: content });
      }

      // (#3) Auto-crítica: a 1ª mensagem é o ponto mais crítico. Antes de gravar, um juiz
      // avalia se ela "não parece bot" (situacional, personalizada, sem clichê). Se reprovar,
      // regenera UMA vez com o retorno do juiz anexado ao prompt. Falha aberta se a IA cair.
      if (isFirst) {
        try {
          const crit = await scoreMessageStyle(content, {
            company: company.name, sector: company.sector, role: contact.role, product: productValue,
          });
          if (crit && crit.verdict && !['passou', 'erro'].includes(crit.verdict)) {
            const fixPrompt = prompt +
              `\n\n## REVISÃO (a versão anterior foi REPROVADA por soar robótica/genérica)\nMotivo do revisor: ${crit.notes || 'faltou personalização/abertura situacional'}.\n` +
              'Reescreva a mensagem corrigindo isso: abra por uma situação/contexto concreto e soe humana. Retorne APENAS a mensagem.';
            const retry = await callClaude('Você é copywriter B2B especialista em sequências multicanal.', fixPrompt, 400);
            if (retry && retry.trim()) content = retry;
          }
        } catch (e) { console.warn('[first-msg critique] pulada:', e.message); }
      }

      // (#3) Guardrail anti-placeholder: se a IA deixou "[seu nome]" & cia, regenera UMA vez
      // com instrução estrita; se ainda persistir, limpa o texto antes de gravar.
      if (findUnresolvedPlaceholders(content).length) {
        const strictPrompt = prompt +
          '\n\n## CORREÇÃO OBRIGATÓRIA\nA versão anterior continha placeholders (ex.: "[seu nome]"). ' +
          'Reescreva SEM nenhum campo a preencher: se não souber um dado, omita-o. Retorne APENAS a mensagem.';
        const retry = await callClaude('Você é copywriter B2B especialista em sequências multicanal.', strictPrompt, 400);
        if (retry && retry.trim() && !isAiError(retry)) content = retry;
      }

      // (#1/unificação) Saneamento final único (tira "—", aspas de IA e placeholders),
      // igual aos demais caminhos de saída — antes gravava sem limpeza aqui.
      content = sanitizeOutbound(content, styleProfile());

      // (#1) Detecta afirmações checáveis e decide se precisa de revisão factual.
      const factClaims = detectFactClaims(content);
      const needsFactCheck = factClaims.length > 0 ? 1 : 0;
      // Rastreia o arquétipo de gancho que gerou a 1ª mensagem (loop de aprendizado #1 / métricas #7).
      const usedHookId = isFirst && primaryHook ? primaryHook.id : null;
      const usedHookCat = isFirst && primaryHook ? (primaryHook.category || '') : '';

      const db3 = getDb();
      const r = db3.prepare(
        "INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, created_at, sources, fact_claims, needs_fact_check, variant_group, variant_no, variant_angle, hook_id, hook_category) VALUES (?,?,?,?,?,?,?,?,datetime('now'),?,?,?,?,?,?,?,?)"
      ).run(contact.id, req.params.id, tpl.channel, tpl.day, tpl.type, content, content, 'pending',
        JSON.stringify(researchSources), JSON.stringify(factClaims), needsFactCheck, variantGroup, variantNo, angle.label, usedHookId, usedHookCat);
      db3.close();
      results.push({
        id: r.lastInsertRowid, channel: tpl.channel, day: tpl.day, content, status: 'pending', approved: 0,
        contact_name: contact.name, sources: researchSources, fact_claims: factClaims, needs_fact_check: needsFactCheck,
        variant_group: variantGroup, variant_no: variantNo, variant_angle: angle.label,
      });
    }
  }

  const db4 = getDb();
  db4.prepare("UPDATE companies SET status='sequence_created' WHERE id=?").run(req.params.id);
  // Registra a abordagem disparada (histórico/contagem de cold/warm/frozen por empresa).
  db4.prepare("INSERT INTO call_events (company_id, contact_id, call_type, created_at) VALUES (?,?,?,datetime('now'))")
     .run(req.params.id, contact.id, callType);
  db4.close();
  // (#1) Sinaliza (sem bloquear) quando a abordagem disparada é COLD numa empresa
  // que já tinha relacionamento prévio.
  const coldOnPrior = callType === 'cold' && priorInfo.has;
  res.json({
    sequence: results, messages: results, contact, call_type: callType, auto_researched: callCtx.autoResearched,
    warning: coldOnPrior ? PRIOR_RELATIONSHIP_WARNING : null,
    prior_relationship: priorInfo,
    suggested_call_type: coldOnPrior ? 'warm' : null,
  });
});

// (#7) Avalia uma mensagem já gravada pela rubrica "não parece bot" e persiste a nota.
app.post('/api/messages/:id/style-score', async (req, res) => {
  const db = getDb();
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);
  if (!msg) { db.close(); return res.status(404).json({ error: 'Mensagem não encontrada' }); }
  const company = msg.company_id ? db.prepare('SELECT name, sector FROM companies WHERE id=?').get(msg.company_id) : null;
  const contact = msg.contact_id ? db.prepare('SELECT role FROM contacts WHERE id=?').get(msg.contact_id) : null;
  db.close();
  const result = await scoreMessageStyle(msg.content, {
    company: company?.name, sector: company?.sector, role: contact?.role, product: msg.product,
  });
  const db2 = getDb();
  db2.prepare('UPDATE messages SET style_score=?, style_report=? WHERE id=?')
     .run(result.total, JSON.stringify(result), req.params.id);
  db2.close();
  res.json(result);
});

// (#7/#8) Avalia um texto avulso (sem gravar) — usado pelo script de regressão e por testes ad-hoc.
app.post('/api/style-score', async (req, res) => {
  const { message, company, sector, role, product } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Campo "message" é obrigatório' });
  const result = await scoreMessageStyle(message, { company, sector, role, product });
  res.json(result);
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
// Categorias que afirmam um encontro/relacionamento PESSOAL ("te vi na feira",
// "fulano me indicou", "somos do mesmo grupo"). Só podem ser usadas quando há
// contexto real que as sustente (evita a IA inventar encontros — coerência #4).
const HOOK_EVIDENCE_LIGHT = ['evento', 'indicacao', 'comunidade'];

// Seleciona arquétipos de gancho aplicando:
//  #4 coerência  → sem suporte real (hasSupport=false), remove categorias de encontro pessoal
//  #2 rotação    → exclui ganchos já usados recentemente por esta empresa (excludeIds)
//  #1 ranking    → ORDER BY score (o score é ajustado pelo feedback humano, ver rota /score)
function selectHooks(db, { callType = 'cold', category = null, limit = 3, hasSupport = true, excludeIds = [] } = {}) {
  try {
    const blocked = hasSupport ? [] : HOOK_EVIDENCE_LIGHT;
    const runQuery = (cat) => {
      const where = ['active=1', "(call_type=? OR call_type='' OR call_type IS NULL)"];
      const params = [callType];
      if (cat) { where.push('category=?'); params.push(cat); }
      if (blocked.length) { where.push(`category NOT IN (${blocked.map(() => '?').join(',')})`); params.push(...blocked); }
      if (excludeIds.length) { where.push(`id NOT IN (${excludeIds.map(() => '?').join(',')})`); params.push(...excludeIds); }
      return db.prepare(
        `SELECT id, situation, product_link, example_text, category FROM hook_library
         WHERE ${where.join(' AND ')} ORDER BY score DESC, id DESC LIMIT ?`
      ).all(...params, limit);
    };
    let rows = category ? runQuery(category) : [];
    if (rows.length < limit) {
      const seen = new Set(rows.map(r => r.id));
      for (const e of runQuery(null)) { if (!seen.has(e.id) && rows.length < limit) rows.push(e); }
    }
    return rows;
  } catch (e) {
    console.warn('[hook-library] seleção indisponível:', e.message);
    return [];
  }
}

// Ids de ganchos usados nas últimas mensagens desta empresa — para não repetir (#2).
function recentHookIdsForCompany(db, companyId, limit = 5) {
  try {
    return db.prepare(
      `SELECT DISTINCT hook_id FROM messages
       WHERE company_id=? AND hook_id IS NOT NULL ORDER BY id DESC LIMIT ?`
    ).all(companyId, limit).map(r => r.hook_id);
  } catch { return []; }
}

// Renderiza o bloco de texto (few-shot) a partir dos ganchos selecionados.
function renderHookExamples(rows) {
  if (!rows || !rows.length) return '';
  const body = rows.map(r =>
    `- Situação: ${r.situation}${r.product_link ? ` → ${r.product_link}` : ''}\n  Exemplo: """${(r.example_text || '').slice(0, 320)}"""`
  ).join('\n');
  return `## BIBLIOTECA DE GANCHOS (referência de abordagem NATURAL)\n${body}\n` +
    `IMPORTANTE: imite o TOM humano e situacional destes exemplos — abra pela situação/contexto real ligado ao produto. ` +
    `NÃO copie o texto literalmente nem invente encontros que não aconteceram; adapte ao gancho e ao contexto reais deste lead. ` +
    `Placeholders como {nome}/{empresa} são só ilustrativos.`;
}

// Wrapper de compatibilidade (cold-search usa só o texto).
function buildHookExamples(db, opts = {}) {
  return renderHookExamples(selectHooks(db, opts));
}

function buildLearnedContext(db, channel, role) {
  const parts = [];
  try {
    const patterns = db.prepare(
      `SELECT pattern FROM learned_patterns
       WHERE channel=? AND (role=? OR role IS NULL OR role='')
         AND (status IS NULL OR status='active')
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

// ── RLHF v2: blocos estruturados (regras / exemplos / histórico) ─────────────

// Teto de caracteres do userPrompt (#5). ~4 chars/token → ~1.5k tokens de contexto para os
// blocos, deixando folga para a resposta. Seções opcionais são descartadas se estourar.
const MAX_PROMPT_CHARS = 6000;

// Regras destiladas, separadas por escopo (global vs específico do canal). Só ativas.
function buildRules(db, channel, role) {
  const out = { global: [], channel: [] };
  try {
    const rows = db.prepare(
      `SELECT pattern, scope, channel FROM learned_patterns
       WHERE (status IS NULL OR status='active')
         AND (role=? OR role IS NULL OR role='')
       ORDER BY confidence DESC, id DESC`
    ).all(role);
    for (const r of rows) {
      if (r.scope === 'global' || !r.channel) {
        if (out.global.length < 8) out.global.push(r.pattern);
      } else if (r.channel === channel) {
        if (out.channel.length < 5) out.channel.push(r.pattern);
      }
    }
  } catch (_) { /* tabela/coluna ausente */ }
  return out;
}

// Exemplos POSITIVOS: mensagens aprovadas (rotuladas, isoladas dos negativos).
function buildPositiveExamples(db, channel, k = 2) {
  try {
    const rows = db.prepare(
      `SELECT content FROM messages
       WHERE channel=? AND approved=1 AND score>=4 AND content IS NOT NULL
       ORDER BY score DESC, id DESC LIMIT ?`
    ).all(channel, k);
    return rows.map(e => `### POSITIVO (canal: ${channel})\n"""${(e.content || '').slice(0, 300)}"""`).join('\n\n');
  } catch (_) { return ''; }
}

// Exemplos NEGATIVOS: crítica COLADA à mensagem que a originou (par ancorado — P2).
// Ciclo de vida (#3): ignora mensagens já corrigidas (human_correction) ou já aprovadas —
// o modelo não deve "aprender a evitar" algo que já foi consertado.
function buildNegativeExamples(db, channel, k = 2) {
  try {
    const rows = db.prepare(
      `SELECT channel, ai_original, criticized_text, score, score_comment, human_correction FROM messages
       WHERE channel=? AND ai_original IS NOT NULL AND ai_original!=''
         AND (approved IS NULL OR approved=0)
         AND (human_correction IS NULL OR human_correction='')
         AND ((score IS NOT NULL AND score<=2) OR (score_comment IS NOT NULL AND score_comment!=''))
       ORDER BY (CASE WHEN score IS NOT NULL THEN 0 ELSE 1 END), score ASC, id DESC LIMIT ?`
    ).all(channel, k);
    const blocks = [];
    for (const n of rows) {
      const critica = n.score_comment
        || (n.human_correction ? `O avaliador preferiu reescrever assim: "${(n.human_correction || '').slice(0, 200)}"` : '');
      if (!critica) continue;
      // Usa o texto congelado no momento da crítica; só cai no ai_original se não houver snapshot.
      const criticized = n.criticized_text || n.ai_original || '';
      blocks.push(
`### NEGATIVO (canal: ${n.channel || channel})
Mensagem gerada:
"""${criticized.slice(0, 300)}"""
Crítica do avaliador:
"""${critica}"""`);
    }
    return blocks.join('\n\n');
  } catch (_) { return ''; }
}

// Histórico cronológico da thread (enviadas + recebidas + status) — resolve P3.
// Orçamento de contexto (#4): as `fullTurns` trocas mais recentes vão na íntegra;
// as anteriores são truncadas (~140 chars) para o prompt não crescer sem teto.
function buildThreadHistory(db, threadId, beforeSeq, fullTurns = 6) {
  if (!threadId) return '';
  try {
    const hasBefore = beforeSeq != null;
    const rows = db.prepare(
      `SELECT day, channel, direction, status, approved, content, ai_original
       FROM messages
       WHERE thread_id=? ${hasBefore ? 'AND COALESCE(seq_no, id) < ?' : ''}
       ORDER BY COALESCE(seq_no, id) ASC`
    ).all(...(hasBefore ? [threadId, beforeSeq] : [threadId]));
    const items = rows
      .map(r => ({ ...r, txt: (r.content || r.ai_original || '').trim() }))
      .filter(r => r.txt);
    const cutoff = Math.max(0, items.length - fullTurns); // itens antes disto são resumidos
    const lines = items.map((r, i) => {
      const truncate = i < cutoff;
      const body = truncate && r.txt.length > 140 ? r.txt.slice(0, 140) + '…' : r.txt;
      if (r.direction === 'inbound') return `[Dia ${r.day} · ${r.channel} · recebida] ${body}`;
      const st = r.approved ? 'aprovada' : (r.status || 'pendente');
      return `[Dia ${r.day} · ${r.channel} · enviada · ${st}] ${body}`;
    });
    return lines.join('\n');
  } catch (_) { return ''; }
}

// Histórico do simulador como turnos estruturados p/ a API do Claude (#7).
// `aiRole`: 'client' quando a IA responde COMO o prospect (então mensagens do cliente = assistant);
//          'vendor' quando a IA responde COMO o vendedor (mensagens do vendedor = assistant).
function buildSimTurns(db, companyId, contactId, aiRole) {
  if (!companyId || !contactId) return [];
  try {
    const rows = db.prepare(
      `SELECT content, status FROM messages
       WHERE company_id=? AND contact_id=? AND channel='whatsapp'
       ORDER BY id ASC`
    ).all(companyId, contactId);
    return rows
      .map(r => (r.content || '').trim())
      .map((txt, i) => ({ txt, isClient: rows[i].status === 'received' }))
      .filter(r => r.txt)
      .map(r => {
        const clientRole = aiRole === 'client' ? 'assistant' : 'user';
        const vendorRole = aiRole === 'client' ? 'user' : 'assistant';
        return { role: r.isClient ? clientRole : vendorRole, content: r.txt };
      });
  } catch (_) { return []; }
}

// Aloca um thread_id novo por sequência gerada (#6): evita que reruns/campanhas do mesmo
// contato ao longo do tempo colidam numa única thread. Mantém contact_id como vínculo p/ inbound.
function nextThreadId(db) {
  try { return (db.prepare('SELECT COALESCE(MAX(thread_id),0)+1 AS n FROM messages').get().n) || 1; }
  catch (_) { return 1; }
}

// Descobre a thread mais recente de um contato (para anexar respostas inbound sem thread_id explícito).
function latestThreadForContact(db, contactId) {
  if (!contactId) return null;
  try {
    const r = db.prepare(
      `SELECT thread_id FROM messages WHERE contact_id=? AND thread_id IS NOT NULL
       ORDER BY COALESCE(seq_no, id) DESC, id DESC LIMIT 1`
    ).get(contactId);
    return r ? r.thread_id : null;
  } catch (_) { return null; }
}

// Monta o userPrompt de uma mensagem da sequência (RLHF v2 — seções rotuladas).
// Usado na geração real e no preview. `rules`/`posExamples`/`negExamples`/`threadHistory`
// são opcionais; quando ausentes as seções são omitidas (funciona na 1ª e na 5ª mensagem).
// (#9) Monta um bloco de contexto a partir do perfil de LinkedIn VALIDADO do contato.
// Só usa dados de perfis confirmados por humano — nunca de pending/rejected.
function linkedinProfileBlock(contact) {
  if (!contact || contact.linkedin_status !== 'confirmed') return '';
  const lines = [];
  if (contact.linkedin_headline)        lines.push(`- Headline: ${contact.linkedin_headline}`);
  if (contact.linkedin_current_role)    lines.push(`- Cargo atual: ${contact.linkedin_current_role}`);
  if (contact.linkedin_current_company) lines.push(`- Empresa atual: ${contact.linkedin_current_company}`);
  if (contact.linkedin_location)        lines.push(`- Localização: ${contact.linkedin_location}`);
  if (contact.linkedin_summary)         lines.push(`- Resumo: ${String(contact.linkedin_summary).slice(0, 500)}`);
  return lines.length ? lines.join('\n') : '';
}

function buildSequenceUserPrompt({ companyName, sector, contactName, role, hook, productValue, day, channel, socialProof, learned, rules, posExamples, negExamples, threadHistory, sender, linkedinProfile }) {
  const roleInfo = ROLE_PROFILES[role] || ROLE_PROFILES.other;
  const desc = CHANNEL_DESC[channel] || channel;
  const sections = [];
  const senderInfo = senderLine(sender);

  sections.push(
`## BRIEFING
${senderInfo ? senderInfo + '\n' : ''}Empresa: ${companyName} (setor: ${sector || 'não definido'})
Contato: ${contactName}, cargo ${role}
Produto: ${productValue}
Gancho de pesquisa: ${hook}
Tom: ${roleInfo.tone} | Foco: ${roleInfo.focus}
Tarefa: escrever a mensagem do Dia ${day} — canal ${channel} (${desc}).`);

  // REGRAS APRENDIDAS (persistentes, acionáveis) — separadas de exemplos e críticas pontuais.
  if (rules && (rules.global?.length || rules.channel?.length)) {
    let r = '## REGRAS APRENDIDAS (obrigatórias — siga à risca)';
    if (rules.global?.length)  r += '\nGerais:\n' + rules.global.map(x => `- ${x}`).join('\n');
    if (rules.channel?.length) r += `\nEspecíficas do canal ${channel}:\n` + rules.channel.map(x => `- ${x}`).join('\n');
    sections.push(r);
  } else if (learned) {
    sections.push(learned); // fallback legado
  }

  // HISTÓRICO DA THREAD — sempre presente (com fallback explícito na 1ª mensagem).
  sections.push(
    '## HISTÓRICO DA THREAD (ordem cronológica; gere a PRÓXIMA mensagem)\n' +
    ((threadHistory && threadHistory.trim())
      ? threadHistory
      : 'Esta é a PRIMEIRA mensagem da sequência. Não há histórico.'));

  // Seções opcionais marcadas com prioridade de descarte (menor = descartada primeiro) para o teto de tokens (#5).
  const optional = [];
  // Perfil validado do LinkedIn: prioridade alta (personaliza a mensagem; descartado por último).
  if (linkedinProfile) optional.push({ prio: 4, text: '## PERFIL DO CONTATO (LinkedIn validado — use para personalizar; não copie literalmente)\n' + linkedinProfile });
  if (socialProof) optional.push({ prio: 1, text: '## CASOS DE SUCESSO\n' + socialProof });
  if (posExamples) optional.push({ prio: 2, text: '## EXEMPLOS POSITIVOS (aprovados — imite o estilo, não copie o conteúdo)\n' + posExamples });
  if (negExamples) optional.push({ prio: 3, text: '## EXEMPLOS NEGATIVOS (reprovados — NÃO repita estes erros)\n' + negExamples });

  const taskSection =
`## SUA TAREFA
Escreva APENAS o texto da mensagem do Dia ${day} (${channel}), sem explicações, sem rótulos, sem aspas ao redor.
Respeite o histórico acima (não repita saudações/nome já usados; responda ao último ponto do lead, se houver).
CTA progressivo: convide para "conversa de 15 minutos" ou "demo rápida". NÃO tente vender diretamente.`;

  // Teto global de tokens (#5): enquanto o prompt passar do limite, descarta a seção opcional
  // de menor prioridade (casos de sucesso → positivos → negativos). Regras e histórico ficam.
  const assemble = () => '\n' + [...sections, ...optional.map(o => o.text), taskSection].join('\n\n') + '\n';
  optional.sort((a, b) => b.prio - a.prio); // mantém as de maior prioridade
  while (assemble().length > MAX_PROMPT_CHARS && optional.length) optional.pop();
  return assemble();
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

  const threadId = nextThreadId(db); // thread própria por sequência/campanha (#6)
  const results = [];
  for (const tpl of SEQUENCE_CHANNELS) {
    const rules       = buildRules(db, tpl.channel, contact.role);
    const posExamples = buildPositiveExamples(db, tpl.channel);
    const negExamples = buildNegativeExamples(db, tpl.channel);
    const threadHistory = buildThreadHistory(db, threadId);
    const prompt = buildSequenceUserPrompt({
      companyName: company.name, sector: company.sector, contactName: contact.name, role: contact.role,
      hook, productValue, day: tpl.day, channel: tpl.channel, socialProof,
      rules, posExamples, negExamples, threadHistory,
      linkedinProfile: linkedinProfileBlock(contact),
    });

    const profile = styleProfile(threadId);
    let content = await callClaude(SEQ_SYSTEM, prompt, 400);
    if (content && botWordScan(humanizeWhatsapp(content, profile)).length) {
      const strict = prompt + ' ATENÇÃO: sem jargão de marketing (solução, otimizar, potencializar, etc.), sem travessão, tom casual de WhatsApp. Devolva só a mensagem.';
      const retry = await callClaude(SEQ_SYSTEM, strict, 400);
      if (retry) content = retry;
    }
    content = sanitizeOutbound(content, profile);
    const promptUsed = `[SYSTEM]\n${SEQ_SYSTEM}\n\n[USER]\n${prompt}`;
    const dbW = getDb();
    const seqNo = dbW.prepare('SELECT COALESCE(MAX(seq_no),0)+1 AS n FROM messages WHERE thread_id=?').get(threadId).n;
    const r = dbW.prepare("INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, created_at, prompt_used, thread_id, seq_no, direction, style_profile) VALUES (?,?,?,?,?,?,?,?,datetime('now'),?,?,?,'outbound',?)").run(contact.id, companyId, tpl.channel, tpl.day, tpl.type, content, content, 'pending', promptUsed, threadId, seqNo, JSON.stringify(profile));
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

  // Limite de tokens escala com o nº de empresas para evitar JSON truncado.
  const maxTokens = Math.min(8000, 1500 + companies.length * 300);
  // Falhas de formatação da IA são intermitentes: tenta até 3 vezes antes de desistir.
  let parsed = null, lastRaw = '';
  for (let attempt = 1; attempt <= 3 && !parsed; attempt++) {
    lastRaw = await callClaude('Voce e especialista em qualificacao de leads B2B com foco em propensao de compra.', prompt, maxTokens);
    try {
      // Extrai o bloco JSON mesmo que a IA adicione texto antes/depois (parser robusto).
      let clean = (lastRaw || '').replace(/```json\s*|\s*```/g, '').trim();
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (jsonMatch) clean = jsonMatch[0];
      const p = JSON.parse(clean);
      if (p && Array.isArray(p.rankings)) parsed = p;
    } catch (e) { /* formato inválido — tenta novamente */ }
  }
  if (!parsed) {
    return res.status(502).json({ error: 'A IA retornou um formato inesperado após 3 tentativas. Tente novamente em alguns segundos.', raw: lastRaw });
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

  // 2. Insere a mensagem recebida no banco como recebida (com thread_id/seq_no/direction — #6/#2)
  const threadId = latestThreadForContact(db, contact_id) || nextThreadId(db);
  const seqNo = (db.prepare('SELECT COALESCE(MAX(seq_no),0)+1 AS n FROM messages WHERE thread_id=?').get(threadId).n) || 1;
  const receivedIns = db.prepare(
    "INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, approved, direction, thread_id, seq_no, created_at) VALUES (?, ?, 'whatsapp', 1, 'text', ?, ?, 'received', 1, 'inbound', ?, ?, datetime('now'))"
  ).run(contact_id, companyId, response_text, response_text, threadId, seqNo);
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
  if (isAiError(result)) {
    // (#2) IA fora do ar: NÃO inventa sentimento. Marca para revisão humana sem poluir o funil.
    sentiment = 'needs_review'; reasoning = 'Classificação indisponível (IA offline) — revisar manualmente.'; iscore = 5;
  } else {
    try { const p = JSON.parse(extractJsonLoose(result)); sentiment = p.sentiment; reasoning = p.reasoning; iscore = parseInt(p.interest_score) || 5; }
    catch { sentiment = 'out_of_scope'; reasoning = result; iscore = 5; }
  }

  const db2 = getDb();
  db2.prepare('INSERT INTO sentiment_logs (lead_id, contact_id, company_id, response_text, sentiment, reasoning, interest_score) VALUES (?,?,?,?,?,?,?)').run(null, contact_id, companyId, response_text, sentiment, reasoning, iscore);
  // (#2) Em needs_review, mantém o status atual (não rebaixa nem promove sem certeza).
  const statusMap = { interested: 'hot_lead', technical_question: 'needs_followup', negative: 'rejected', out_of_scope: 'contacted', wants_meeting: 'hot_lead' };
  if (sentiment !== 'needs_review') {
    db2.prepare('UPDATE companies SET status=?,interest_score=? WHERE id=?').run(statusMap[sentiment] || 'contacted', iscore, companyId);
  }

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

  // (#7) Intenção de reunião → sugere/cria slot automaticamente em vez de exigir passo manual.
  let meeting_suggestion = null;
  if (sentiment === 'wants_meeting') {
    const already = db2.prepare("SELECT id FROM schedule_slots WHERE company_id=? AND booked=1").get(companyId);
    const parsed = parseMeetingDateTime(response_text);
    if (!already && parsed) {
      // Horário explícito no texto → cria slot SUGERIDO (não reservado; operador confirma).
      const s = db2.prepare(
        'INSERT INTO schedule_slots (date_time,duration_min,meeting_link,booked,company_id,contact_id) VALUES (?,?,?,0,?,?)'
      ).run(parsed.iso, 15, '', companyId, contact_id);
      meeting_suggestion = { slot_id: s.lastInsertRowid, date_time: parsed.iso, label: parsed.label, booked: false };
      db2.prepare('INSERT INTO notifications (company_id,contact_id,message_id,type,title,body) VALUES (?,?,?,?,?,?)')
        .run(companyId, contact_id, receivedMsgId, 'meeting_suggested', `🗓️ Horário sugerido: ${parsed.label}`, `Confirme o slot para ${parsed.label}.`);
    } else if (!already) {
      meeting_suggestion = { slot_id: null, needs_time: true, hint: 'Prospect quer reunião mas sem horário claro — proponha 2 opções.' };
    }
  }
  db2.close();
  broadcastInboxUpdate();

  // Modo treino: NÃO gera a resposta do bot automaticamente. A resposta da IA é criada
  // só quando o operador clica em "Simular resposta do Bot" / "Responder com IA" — assim
  // cada mensagem gerada pela IA é um passo explícito e revisável (nada escapa da avaliação).
  res.json({ ok: true, sentiment, interest_score: iscore, auto_reply_status: null, meeting_suggestion });
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
  // Histórico como turnos estruturados (#7): a IA é o VENDEDOR nesta chamada.
  const priorTurns = buildSimTurns(db, companyId, contact_id, 'vendor');
  db.close();

  const lastMsg = lastReceived?.content;
  if (!lastMsg) {
    return res.status(400).json({ error: 'Nenhuma mensagem recebida para responder. Simule uma resposta do prospect primeiro.' });
  }

  // (#5) Coerência de agenda: extrai os horários já citados na conversa e o mais recente,
  // para o bot não "reabrir" ou contradizer um horário já combinado.
  const mentionedTimes = [];
  for (const turn of priorTurns) {
    const p = parseMeetingDateTime(turn.content);
    if (p) mentionedTimes.push(p.label);
  }
  const lastAgreed = mentionedTimes.length ? mentionedTimes[mentionedTimes.length - 1] : null;
  const scheduleNote = lastAgreed
    ? `\n## AGENDA (coerência — IMPORTANTE)\nHorário mais recente na conversa: "${lastAgreed}". NÃO proponha horários novos nem reabra a negociação de data se já houver um combinado; apenas confirme esse horário de forma objetiva. Se o cliente citou dois horários diferentes, peça UMA confirmação explícita de qual vale.`
    : '';

  const draftPrompt = `Escreva a PRÓXIMA mensagem do VENDEDOR (bot) via WhatsApp, dando continuidade natural à conversa acima.
Regras:
- Responda ao que o cliente disse por último; avance a conversa
- NÃO repita pontos, argumentos ou perguntas que você (vendedor) já fez antes
- Curta (máx 80 palavras), objetiva, tom consultivo e profissional
- Se fizer sentido, convide para uma conversa de 15 minutos
- Escreva APENAS o texto da mensagem${scheduleNote}`;
  const draft_reply = await callClaude('Você é SDR especialista em respostas rápidas para prospects.', draftPrompt, 200, priorTurns);
  if (isAiError(draft_reply)) return res.status(502).json({ error: 'IA indisponível ao gerar resposta do bot', detail: draft_reply });

  // Modo treino: resposta do bot sempre como rascunho pendente para revisão/avaliação.
  const status   = 'pending';
  const approved = 0;

  const db2 = getDb();
  const threadId = latestThreadForContact(db2, contact_id) || nextThreadId(db2);
  const seqNo = (db2.prepare('SELECT COALESCE(MAX(seq_no),0)+1 AS n FROM messages WHERE thread_id=?').get(threadId).n) || 1;
  const ins = db2.prepare(
    "INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, approved, direction, thread_id, seq_no, created_at) VALUES (?, ?, 'whatsapp', 1, 'text', ?, ?, ?, ?, 'outbound', ?, ?, datetime('now'))"
  ).run(contact_id, companyId, draft_reply.trim(), draft_reply.trim(), status, approved, threadId, seqNo);
  db2.close();
  broadcastInboxUpdate();

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

  const toneMap = {
    interested: 'O prospect é receptivo e demonstra interesse genuíno, quer saber mais.',
    skeptical:  'O prospect é cético, tem dúvidas técnicas ou sobre ROI, pede mais detalhes antes de se comprometer.',
    negative:   'O prospect não tem interesse no momento, já tem solução ou não é o decisor.',
    random:     'Escolha aleatoriamente um perfil realista de resposta (pode ser qualquer um dos anteriores).',
  };
  // Persona persistente (#4): se um tom concreto foi pedido, salva; senão reaproveita o já salvo.
  let effectiveTone = (tone && tone !== 'random') ? tone : (contact.sim_tone || 'random');
  if (!toneMap[effectiveTone]) effectiveTone = 'random';
  if (effectiveTone !== 'random' && effectiveTone !== contact.sim_tone) {
    db.prepare('UPDATE contacts SET sim_tone=? WHERE id=?').run(effectiveTone, contact_id);
  }
  const toneInstruction = toneMap[effectiveTone];

  // Histórico como turnos estruturados (#7): a IA responde COMO o prospect/Cliente.
  const priorTurns = buildSimTurns(db, req.params.id, contact_id, 'client');
  db.close();

  const prompt = `Empresa: ${company.name} (setor: ${company.sector || 'não definido'})
Contato: ${contact.name}, cargo: ${contact.role}

Sua tarefa: escreva a PRÓXIMA mensagem que você (o prospect/Cliente) enviaria via WhatsApp, dando
continuidade natural à conversa acima. Se não houver conversa anterior, responda à primeira abordagem.
Perfil do prospect nessa simulação: ${toneInstruction}
Regras:
- Reaja à última mensagem do vendedor; faça a conversa AVANÇAR
- NÃO repita o que você (Cliente) já disse antes — nem as mesmas objeções ou perguntas
- Escreva APENAS o texto da resposta, sem aspas nem explicações
- Tom informal, como WhatsApp real (pode ter erros de digitação leves, abreviações)
- Máx 60 palavras
- NÃO invente informações da empresa`;

  const reply = await callClaude('Você é um prospect B2B respondendo uma mensagem de prospecção via WhatsApp.', prompt, 150, priorTurns);
  if (isAiError(reply)) return res.status(502).json({ error: 'IA indisponível ao gerar resposta do prospect', detail: reply });
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
  const { company_id, name, stage, value, notes, doc_ids } = req.body;
  if (!company_id || !name) return res.status(400).json({ error: 'company_id e name são obrigatórios' });
  const stageVal = VALID_STAGES.includes(stage) ? stage : 'prospecting';
  const db = getDb();
  const company = db.prepare('SELECT id FROM companies WHERE id=?').get(company_id);
  if (!company) { db.close(); return res.status(404).json({ error: 'Empresa não encontrada' }); }
  const r = db.prepare('INSERT INTO opportunities (company_id, name, stage, value, notes) VALUES (?,?,?,?,?)').run(company_id, name, stageVal, value || 0, notes || '');
  const oppId = r.lastInsertRowid;
  // (#1) vincula os documentos usados à oportunidade
  if (Array.isArray(doc_ids) && doc_ids.length) {
    const link = db.prepare('INSERT OR IGNORE INTO opportunity_documents (opportunity_id, document_id) VALUES (?,?)');
    for (const d of doc_ids) { const did = parseInt(d); if (did) link.run(oppId, did); }
  }
  db.close();
  res.json({ id: oppId });
});

// (#1) documentos vinculados a uma oportunidade
app.get('/api/opportunities/:id/documents', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT d.id, d.name, d.source_type, length(d.content) AS size
    FROM opportunity_documents od JOIN documents d ON d.id = od.document_id
    WHERE od.opportunity_id = ? ORDER BY d.name
  `).all(req.params.id);
  db.close();
  res.json(rows);
});

// (#10) cache em memória das sugestões (TTL 10 min), evita reprocessar o mesmo pedido.
const suggestCache = new Map();
const SUGGEST_TTL = 10 * 60 * 1000;

// Sugere nome + notas de uma oportunidade lendo documento(s) da base + contexto do contato.
app.post('/api/opportunities/suggest', async (req, res) => {
  const { company_id, contact_id, doc_ids, hint, refresh } = req.body;
  if (!company_id) return res.status(400).json({ error: 'company_id é obrigatório' });
  if (!Array.isArray(doc_ids) || !doc_ids.length) return res.status(400).json({ error: 'Selecione ao menos um documento' });

  const cacheKey = sha256(JSON.stringify({ company_id, contact_id: contact_id || null, doc_ids: [...doc_ids].sort(), hint: hint || '' }));
  if (!refresh) {
    const hit = suggestCache.get(cacheKey);
    if (hit && (Date.now() - hit.at) < SUGGEST_TTL) return res.json({ ...hit.data, cached: true });
  }

  const db = getDb();
  const company = db.prepare('SELECT * FROM companies WHERE id=?').get(company_id);
  if (!company) { db.close(); return res.status(404).json({ error: 'Empresa não encontrada' }); }
  const contact = contact_id ? db.prepare('SELECT * FROM contacts WHERE id=?').get(contact_id) : null;
  const placeholders = doc_ids.map(() => '?').join(',');
  const docs = db.prepare(`SELECT name,content FROM documents WHERE id IN (${placeholders})`).all(...doc_ids);
  db.close();
  if (!docs.length) return res.status(404).json({ error: 'Documentos não encontrados' });

  // (#2) trechos relevantes por documento, respeitando o orçamento MAX_PROMPT_CHARS.
  const terms = [company.name, company.sector, contact?.role, contact?.context, hint].filter(Boolean);
  const perDoc = Math.floor(MAX_PROMPT_CHARS / docs.length);
  const docsText = docs.map(d => `[${d.name}]\n${extractRelevantChunk(d.content, terms, perDoc)}`).join('\n\n---\n\n');
  const system = 'Você é um consultor de vendas B2B. Baseie-se APENAS nos documentos e no contexto fornecidos. Responda APENAS com JSON válido, sem markdown, no formato {"name": "...", "notes": "..."}.';
  const prompt = `Empresa: ${company.name}${company.sector ? ' (' + company.sector + ')' : ''}\n` +
    (contact ? `Contato: ${contact.name}${contact.role ? ' - ' + contact.role : ''}\n` : '') +
    (contact && contact.context ? `Contexto do contato: ${contact.context}\n` : '') +
    (hint ? `Direcionamento do vendedor: ${hint}\n` : '') +
    `\nDocumentos de referência:\n${docsText}\n\n` +
    `Sugira uma oportunidade de venda: "name" = título curto da oportunidade; "notes" = pitch/proposta de valor conectando o material ao contato/empresa.`;

  const raw = await callClaude(system, prompt, 700);
  let out;
  try { out = JSON.parse(extractJsonLoose(raw)); } catch { out = { name: '', notes: raw }; }
  const data = { name: out.name || '', notes: out.notes || '', docs_used: docs.map(d => d.name) };
  suggestCache.set(cacheKey, { at: Date.now(), data });
  res.json(data);
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

  // (#2) Nunca envia um texto de erro da IA como se fosse mensagem.
  if (isAiError(msg.content)) {
    db.close();
    return res.status(422).json({ error: 'Mensagem contém erro de IA — regenere antes de aprovar.' });
  }

  // (#3) Guardrail de placeholders: bloqueia envio com campos não resolvidos ([Nome], {empresa}, etc.).
  // O operador pode forçar conscientemente com override_placeholder=true.
  const placeholders = findUnresolvedPlaceholders(msg.content);
  if (placeholders.length && !req.body.override_placeholder) {
    db.close();
    return res.status(422).json({ error: 'Placeholders não resolvidos na mensagem', placeholders });
  }

  // (#10) LGPD: bloqueia envio a contatos/empresas com opt-out ou flag "não contatar".
  const lgpd = sendingBlockedByConsent(db, msg.company_id, msg.contact_id);
  if (lgpd) {
    db.prepare('INSERT INTO consent_logs (company_id, contact_id, action, details) VALUES (?,?,?,?)')
      .run(msg.company_id || null, msg.contact_id || null, 'send_blocked', lgpd);
    db.close();
    return res.status(403).json({ error: 'Envio bloqueado por consentimento/LGPD', reason: lgpd });
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
  // (#9) Auditoria: quem aprovou/enviou qual mensagem e quando.
  audit(req, 'message_approved', `Msg ${req.params.id} aprovada (${msg.channel})`, { company_id: msg.company_id, contact_id: msg.contact_id, message_id: Number(req.params.id) });
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
  // Tipagem de sinal (#2): 'rule' (vira regra global via destilação), 'ephemeral' (crítica
  // pontual desta mensagem — não deve virar regra), ou null (comportamento padrão).
  if (req.body.feedback_kind !== undefined) {
    const fk = ['rule', 'ephemeral', 'example_pos', 'example_neg'].includes(req.body.feedback_kind) ? req.body.feedback_kind : null;
    sets.push('feedback_kind=?'); vals.push(fk);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar' });
  const db = getDb();
  // #1: congela o texto atual da mensagem como o "texto criticado", para a âncora não deslizar
  // se a mensagem for regenerada depois. Só grava snapshot quando há comentário de verdade.
  if (hasComment && String(req.body.comment || '').trim()) {
    const cur = db.prepare('SELECT content, ai_original FROM messages WHERE id=?').get(req.params.id);
    sets.push('criticized_text=?'); vals.push((cur && (cur.content || cur.ai_original)) || null);
  }
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
  // (#1) Loop de aprendizado da biblioteca de ganchos: a nota humana da 1ª mensagem
  // ajusta o score do arquétipo que a gerou. Nota alta promove (o gancho sobe no ranking
  // de selectHooks); nota baixa rebaixa. Score fica no intervalo [0,10].
  if (hasScore) {
    try {
      const m = db.prepare('SELECT hook_id FROM messages WHERE id=?').get(req.params.id);
      if (m && m.hook_id) {
        const s = parseInt(req.body.score);
        const delta = s >= 4 ? 1 : (s <= 2 ? -1 : 0);
        if (delta) db.prepare('UPDATE hook_library SET score=MAX(0, MIN(10, score+?)) WHERE id=?').run(delta, m.hook_id);
      }
    } catch (e) { console.warn('[hook-learning] ajuste de score falhou:', e.message); }
  }
  db.close();
  if (hasComment) maybeAutoDistill(); // #7: comentário mal avaliado pode virar regra
  res.json({ ok: true });
});

app.post('/api/messages/:id/correct', (req, res) => {
  const correction = req.body.correction || '';
  const db = getDb();
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id);
  if (!msg) { db.close(); return res.status(404).json({ error: 'Não encontrada' }); }
  let versions = [];
  try { versions = JSON.parse(msg.versions || '[]'); } catch {}
  versions.push({ content: msg.content, prompt_used: msg.prompt_used || null, score: msg.score ?? null, score_comment: msg.score_comment || null, created_at: msg.created_at || null });
  db.prepare('UPDATE messages SET human_correction=?,content=?,versions=? WHERE id=?').run(correction, correction, JSON.stringify(versions), req.params.id);
  db.close();
  maybeAutoDistill(); // #7: destila em segundo plano se houver correções novas suficientes
  res.json({ ok: true, original: msg.ai_original, correction });
});

// Registra uma resposta recebida do lead como uma linha própria na thread (direction='inbound').
// Sem isto o histórico (P3) fica incompleto: o modelo não vê a que objeção está respondendo.
app.post('/api/messages/inbound', (req, res) => {
  const { contact_id, company_id, channel, day, content, thread_id } = req.body || {};
  if (!content || !String(content).trim()) return res.status(400).json({ error: 'content obrigatório' });
  const db = getDb();
  try {
    const threadId = thread_id || latestThreadForContact(db, contact_id) || contact_id;
    if (!threadId) { db.close(); return res.status(400).json({ error: 'thread_id ou contact_id obrigatório' }); }
    const seqNo = db.prepare('SELECT COALESCE(MAX(seq_no),0)+1 AS n FROM messages WHERE thread_id=?').get(threadId).n;
    const r = db.prepare(
      `INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, status, direction, thread_id, seq_no, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`
    ).run(contact_id || null, company_id || null, channel || 'whatsapp', day || 1, 'inbound', String(content), 'received', 'inbound', threadId, seqNo);
    res.json({ ok: true, id: r.lastInsertRowid, thread_id: threadId, seq_no: seqNo });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally { db.close(); }
});

// ── Teste cego anti-detecção de bot (blind Turing test) ───────────────────────
// Semeia mensagens reais x geradas pela automação, coleta palpites e mede a taxa
// de acerto. Sucesso = acerto agregado < 50% (indistinguível de humano).
app.post('/api/blindtest/seed', (req, res) => {
  const db = getDb();
  try {
    const reals = Array.isArray(req.body.real) ? req.body.real : [];
    const autos = Array.isArray(req.body.auto) ? req.body.auto : [];
    const batch = (req.body.batch || new Date().toISOString().slice(0, 16)).toString();
    if (req.body.reset) db.exec('DELETE FROM blind_test_guesses; DELETE FROM blind_test_items;');
    const ins = db.prepare('INSERT INTO blind_test_items (source, text, scenario, batch) VALUES (?,?,?,?)');
    let n = 0;
    const add = (arr, source) => arr.map(t => String(t || '').trim()).filter(Boolean)
      .forEach(t => { ins.run(source, t, (req.body.scenario || '').toString(), batch); n++; });
    db.exec('BEGIN');
    try { add(reals, 'real'); add(autos, 'auto'); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    res.json({ ok: true, inserted: n, batch });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  finally { db.close(); }
});

// Devolve os itens embaralhados SEM revelar a origem (para o testador palpitar).
app.get('/api/blindtest/items', (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare('SELECT id, text, scenario FROM blind_test_items ORDER BY (id * 2654435761) % 1000003').all();
    res.json({ items: rows, total: rows.length });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  finally { db.close(); }
});

// Registra um palpite e marca acerto comparando com a origem real (server-side).
app.post('/api/blindtest/guess', (req, res) => {
  const db = getDb();
  try {
    const { item_id, tester_name, guess, reason } = req.body || {};
    if (!item_id || !tester_name || !['real', 'auto'].includes(guess))
      return res.status(400).json({ error: 'item_id, tester_name e guess (real|auto) obrigatórios' });
    const item = db.prepare('SELECT source FROM blind_test_items WHERE id=?').get(item_id);
    if (!item) return res.status(404).json({ error: 'Item não encontrado' });
    const correct = item.source === guess ? 1 : 0;
    db.prepare('INSERT INTO blind_test_guesses (item_id, tester_name, guess, correct, reason) VALUES (?,?,?,?,?)')
      .run(item_id, String(tester_name).trim(), guess, correct, (reason || '').toString().slice(0, 120));
    res.json({ ok: true, correct: !!correct });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  finally { db.close(); }
});

// Resultados agregados + por testador. success = taxa agregada < 0.5.
app.get('/api/blindtest/results', (req, res) => {
  const db = getDb();
  try {
    const agg = db.prepare('SELECT COUNT(*) total, COALESCE(SUM(correct),0) hits FROM blind_test_guesses').get();
    const perTester = db.prepare(`SELECT tester_name, COUNT(*) total, COALESCE(SUM(correct),0) hits
      FROM blind_test_guesses GROUP BY tester_name ORDER BY tester_name`).all();
    const reasons = db.prepare("SELECT reason, COUNT(*) n FROM blind_test_guesses WHERE reason IS NOT NULL AND reason<>'' GROUP BY reason ORDER BY n DESC LIMIT 8").all();
    const rate = agg.total ? agg.hits / agg.total : 0;
    res.json({
      total: agg.total, hits: agg.hits, accuracy: rate,
      success: agg.total > 0 && rate < 0.5,
      testers: perTester.map(t => ({ ...t, accuracy: t.total ? t.hits / t.total : 0 })),
      reasons,
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  finally { db.close(); }
});

// Converte as mensagens da automação mais 'denunciadas' (alta taxa de detecção)
// em regras aprendidas negativas, fechando o loop com o RLHF existente (item 8).
app.post('/api/blindtest/harvest', (req, res) => {
  const db = getDb();
  try {
    const minGuesses = parseInt(req.body.min_guesses) || 2;
    const minRate = req.body.min_rate !== undefined ? Number(req.body.min_rate) : 0.6;
    const rows = db.prepare(`
      SELECT i.id, i.text, COUNT(g.id) total, COALESCE(SUM(g.correct),0) hits
      FROM blind_test_items i JOIN blind_test_guesses g ON g.item_id=i.id
      WHERE i.source='auto'
      GROUP BY i.id HAVING total >= ? AND (CAST(hits AS REAL)/total) >= ?`).all(minGuesses, minRate);
    const ins = db.prepare(`INSERT INTO learned_patterns (channel, role, pattern, confidence, sample_size, scope, status, source_message_ids, updated_at)
      VALUES ('whatsapp', '', ?, 0.6, ?, 'channel', 'active', '[]', datetime('now'))`);
    let created = 0;
    for (const r of rows) {
      const marks = botWordScan(r.text);
      const detail = marks.length ? ` (evite: ${marks.join(', ')})` : '';
      const pattern = `Evite mensagens como esta, facilmente identificada como automação${detail}: "${(r.text || '').slice(0, 140)}"`;
      ins.run(pattern, r.total);
      created++;
    }
    res.json({ ok: true, harvested: created, candidates: rows.length });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  finally { db.close(); }
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
  broadcastInboxUpdate();
  const hour = new Date().getHours();
  const delayMs = humanDelayMs(msg.content || '', { hour });
  const bubbles = splitBubbles(msg.content || '');
  res.json({ ok: true, delay_ms: delayMs, delay_label: `${Math.round(delayMs / 1000)}s`, off_hours: offHours(hour), bubbles: bubbles.length, note: 'Delay humano variável aplicado' });
});

// Documents
app.get('/api/documents', (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT id,name,source_type,created_at,length(content) as size FROM documents ORDER BY created_at DESC').all());
  db.close();
});

// Retorna um documento completo (com conteúdo) para visualização.
app.get('/api/documents/:id', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT id,name,content,source_type,created_at FROM documents WHERE id=?').get(req.params.id);
  db.close();
  if (!doc) return res.status(404).json({ error: 'Documento não encontrado' });
  res.json(doc);
});

// Edita um documento existente (nome e/ou conteúdo). Recalcula o hash de dedup (#3).
app.put('/api/documents/:id', (req, res) => {
  const { name, content } = req.body || {};
  if (!name || !content) return res.status(400).json({ error: 'name e content são obrigatórios' });
  const db = getDb();
  const doc = db.prepare('SELECT id FROM documents WHERE id=?').get(req.params.id);
  if (!doc) { db.close(); return res.status(404).json({ error: 'Documento não encontrado' }); }
  const hash = sha256(content);
  const clash = db.prepare('SELECT id,name FROM documents WHERE content_hash=? AND id<>?').get(hash, req.params.id);
  if (clash) { db.close(); return res.status(409).json({ duplicate: true, id: clash.id, name: clash.name, error: `Outro documento idêntico já existe: "${clash.name}"` }); }
  db.prepare('UPDATE documents SET name=?, content=?, content_hash=? WHERE id=?').run(name, content, hash, req.params.id);
  db.close();
  res.json({ ok: true, id: Number(req.params.id) });
});

// Salva documento (texto manual OU conteúdo já extraído no preview #6).
// Dedup por hash de conteúdo (#3): se já existir, retorna duplicate a menos que replace=true.
app.post('/api/documents', (req, res) => {
  const { name, content, source_type, replace } = req.body;
  if (!name || !content) return res.status(400).json({ error: 'name e content são obrigatórios' });
  const hash = sha256(content);
  const db = getDb();
  const existing = db.prepare('SELECT id,name FROM documents WHERE content_hash=?').get(hash);
  if (existing && !replace) {
    db.close();
    return res.status(409).json({ duplicate: true, id: existing.id, name: existing.name, error: `Documento idêntico já existe: "${existing.name}"` });
  }
  let id;
  if (existing && replace) {
    db.prepare('UPDATE documents SET name=?, content=?, source_type=? WHERE id=?').run(name, content, source_type || 'text', existing.id);
    id = existing.id;
  } else {
    const r = db.prepare('INSERT INTO documents (name,content,content_hash,source_type) VALUES (?,?,?,?)').run(name, content, hash, source_type || 'text');
    id = r.lastInsertRowid;
  }
  db.close();
  res.json({ id });
});

app.delete('/api/documents/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM documents WHERE id=?').run(req.params.id);
  db.close();
  res.json({ ok: true });
});

// (#6) Preview: extrai o arquivo (PDF/DOCX/TXT/MD) e devolve o Markdown SEM salvar,
// para o usuário revisar/editar antes de gravar. Informa se já existe duplicado (#3).
app.post('/api/documents/extract', uploadPdf.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  let parsed;
  try {
    parsed = await extractFileToMarkdown(req.file.buffer, req.file.originalname || 'arquivo');
  } catch (e) {
    return res.status(400).json({ error: extractErrorMessage(e.code) });
  }
  const hash = sha256(parsed.markdown);
  const db = getDb();
  const dup = db.prepare('SELECT id,name FROM documents WHERE content_hash=?').get(hash);
  db.close();
  res.json({
    name: parsed.title, markdown: parsed.markdown, source_type: parsed.source_type,
    size: parsed.markdown.length,
    duplicate: dup ? { id: dup.id, name: dup.name } : null,
  });
});

// Upload em um passo (extrai + salva). Mantido por conveniência; dedup aplicado.
app.post('/api/documents/upload', uploadPdf.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  let parsed;
  try {
    parsed = await extractFileToMarkdown(req.file.buffer, req.file.originalname || 'arquivo');
  } catch (e) {
    return res.status(400).json({ error: extractErrorMessage(e.code) });
  }
  const hash = sha256(parsed.markdown);
  const db = getDb();
  const existing = db.prepare('SELECT id,name FROM documents WHERE content_hash=?').get(hash);
  if (existing && req.body.replace !== 'true') {
    db.close();
    return res.status(409).json({ duplicate: true, id: existing.id, name: existing.name, error: `Documento idêntico já existe: "${existing.name}"` });
  }
  let id;
  if (existing) {
    db.prepare('UPDATE documents SET name=?, content=?, source_type=? WHERE id=?').run(parsed.title, parsed.markdown, parsed.source_type, existing.id);
    id = existing.id;
  } else {
    const r = db.prepare('INSERT INTO documents (name,content,content_hash,source_type) VALUES (?,?,?,?)').run(parsed.title, parsed.markdown, hash, parsed.source_type);
    id = r.lastInsertRowid;
  }
  db.close();
  res.json({ id, name: parsed.title, size: parsed.markdown.length, source_type: parsed.source_type });
});

// RAG
app.post('/api/rag/query', async (req, res) => {
  const { query, storytelling } = req.body;
  const db = getDb();
  const allDocs = db.prepare('SELECT name,content FROM documents').all();
  db.close();
  if (!allDocs.length) return res.json({ answer: 'Nenhum documento carregado.' });

  // (#10) Ranqueia os documentos por relevância à pergunta e usa só os melhores,
  // dando mais orçamento de contexto a cada um (em vez de dividir entre todos).
  const rankTerms = String(query || '').toLowerCase().split(/\s+/).filter(t => t.length >= 4);
  const scoredDocs = allDocs.map(d => {
    const low = String(d.content || '').toLowerCase();
    let score = 0;
    for (const t of rankTerms) { let idx = low.indexOf(t); while (idx !== -1) { score++; idx = low.indexOf(t, idx + t.length); } }
    return { ...d, score };
  });
  const relevant = scoredDocs.filter(d => d.score > 0).sort((a, b) => b.score - a.score);
  const TOP_K = 5;
  const docs = (relevant.length ? relevant : scoredDocs).slice(0, TOP_K);

  // (#2) seleciona os trechos relevantes por documento (em vez de cortar em 2000).
  const terms = String(query || '').split(/\s+/);
  const perDoc = Math.floor(MAX_PROMPT_CHARS / Math.max(docs.length, 1));
  const docsText = docs.map(d => `[${d.name}]\n${extractRelevantChunk(d.content, terms, perDoc)}`).join('\n\n---\n\n');
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

// Biblioteca de Ganchos — arquétipos de 1ª mensagem (situação real → produto)
app.get('/api/hook-library', (req, res) => {
  const db = getDb();
  const where = [];
  const params = [];
  if (req.query.call_type) { where.push('call_type=?'); params.push(req.query.call_type); }
  if (req.query.category)  { where.push('category=?');  params.push(req.query.category); }
  if (req.query.active !== undefined) { where.push('active=?'); params.push(req.query.active ? 1 : 0); }
  const sql = 'SELECT * FROM hook_library' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY score DESC, id DESC';
  res.json(db.prepare(sql).all(...params));
  db.close();
});

// (#7) Métricas de naturalidade/eficácia: para cada arquétipo e por categoria,
// quantas 1ªs mensagens gerou, taxa de aprovação e nota média — responde
// objetivamente "o gancho está funcionando bem?".
app.get('/api/hook-library/stats', (req, res) => {
  const db = getDb();
  const perHook = db.prepare(`
    SELECT h.id, h.situation, h.category, h.call_type, h.score AS current_score,
           COUNT(m.id)                                   AS uses,
           SUM(CASE WHEN m.approved=1 THEN 1 ELSE 0 END) AS approved,
           ROUND(AVG(m.score), 2)                        AS avg_score,
           SUM(CASE WHEN m.style_score IS NOT NULL THEN 1 ELSE 0 END) AS style_rated,
           ROUND(AVG(m.style_score), 2)                  AS avg_style_score
    FROM hook_library h
    LEFT JOIN messages m ON m.hook_id = h.id
    GROUP BY h.id
    ORDER BY uses DESC, current_score DESC
  `).all().map(r => ({
    ...r,
    approval_rate: r.uses ? Math.round((r.approved / r.uses) * 100) : null,
  }));
  const perCategory = db.prepare(`
    SELECT hook_category AS category,
           COUNT(*)                                      AS uses,
           SUM(CASE WHEN approved=1 THEN 1 ELSE 0 END)   AS approved,
           ROUND(AVG(score), 2)                          AS avg_score,
           ROUND(AVG(style_score), 2)                    AS avg_style_score
    FROM messages
    WHERE hook_category IS NOT NULL AND hook_category != ''
    GROUP BY hook_category
    ORDER BY uses DESC
  `).all().map(r => ({
    ...r,
    approval_rate: r.uses ? Math.round((r.approved / r.uses) * 100) : null,
  }));
  db.close();
  res.json({ per_hook: perHook, per_category: perCategory });
});

app.post('/api/hook-library', (req, res) => {
  const b = req.body || {};
  if (!b.situation || !b.example_text) return res.status(400).json({ error: 'situation e example_text são obrigatórios' });
  const db = getDb();
  const r = db.prepare(
    'INSERT INTO hook_library (situation,product_link,example_text,category,call_type,tags,score,active) VALUES (?,?,?,?,?,?,?,?)'
  ).run(b.situation, b.product_link || '', b.example_text, b.category || 'geral', b.call_type || 'cold', b.tags || '', b.score || 5, b.active === undefined ? 1 : (b.active ? 1 : 0));
  db.close();
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/hook-library/:id', (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM hook_library WHERE id=?').get(req.params.id);
  if (!cur) { db.close(); return res.status(404).json({ error: 'Gancho não encontrado' }); }
  const b = req.body || {};
  const merged = {
    situation:    b.situation    ?? cur.situation,
    product_link: b.product_link ?? cur.product_link,
    example_text: b.example_text ?? cur.example_text,
    category:     b.category     ?? cur.category,
    call_type:    b.call_type    ?? cur.call_type,
    tags:         b.tags         ?? cur.tags,
    score:        b.score        ?? cur.score,
    active:       b.active === undefined ? cur.active : (b.active ? 1 : 0),
  };
  db.prepare('UPDATE hook_library SET situation=?,product_link=?,example_text=?,category=?,call_type=?,tags=?,score=?,active=? WHERE id=?')
    .run(merged.situation, merged.product_link, merged.example_text, merged.category, merged.call_type, merged.tags, merged.score, merged.active, req.params.id);
  db.close();
  res.json({ ok: true });
});

app.delete('/api/hook-library/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM hook_library WHERE id=?').run(req.params.id);
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
      broadcastInboxUpdate();
    } catch (e) {
      console.error('[Agenda] Erro ao enviar confirmação WhatsApp:', e.message);
    }
  }

  if (booked) audit(req, 'meeting_booked', `Reunião ${date_time}`, { company_id: company_id || null, contact_id: contact_id || null });
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
// Stream SSE: o frontend abre esta conexão e recebe um evento sempre que o inbox muda.
app.get('/api/whatsapp/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write('event: connected\ndata: {"ok":true}\n\n');
  inboxSseClients.add(res);
  // Ping periódico para manter a conexão viva através de proxies
  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { /* ignore */ }
  }, 25_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    inboxSseClients.delete(res);
  });
});

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
    LEFT JOIN contacts ct ON ct.id = (
      SELECT c2.id FROM contacts c2
      WHERE c2.company_id = co.id
      ORDER BY c2.is_primary DESC, c2.id ASC
      LIMIT 1
    )
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

// DELETE /api/whatsapp/:companyId/messages — apaga o histórico de conversa WhatsApp da empresa
app.delete('/api/whatsapp/:companyId/messages', (req, res) => {
  const db = getDb();
  const r = db.prepare("DELETE FROM messages WHERE company_id=? AND channel='whatsapp'").run(req.params.companyId);
  db.close();
  broadcastInboxUpdate();
  res.json({ ok: true, deleted: r.changes });
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
    broadcastInboxUpdate();
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
  // filter: 'unrated' (não avaliadas — sem 👍/👎) | 'rated' (já avaliadas)
  // Considera apenas mensagens geradas pela IA (saída), nunca as recebidas do prospect.
  const filter = req.query.filter === 'rated' ? 'rated' : 'unrated';
  const scoreCond = filter === 'rated' ? 'm.score IS NOT NULL' : 'm.score IS NULL';
  const db = getDb();
  res.json(db.prepare(`
    SELECT m.*, co.name as company_name, co.sector as company_sector, ct.name as contact_name, ct.role as contact_role
    FROM messages m
    LEFT JOIN companies co ON m.company_id = co.id
    LEFT JOIN contacts ct ON m.contact_id = ct.id
    WHERE m.status != 'received' AND m.channel = 'whatsapp' AND ${scoreCond}
    ORDER BY COALESCE(m.created_at, '') DESC, m.id DESC
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
    const userPrompt = buildSequenceUserPrompt({
      companyName: m.company_name || '—', sector: m.company_sector, contactName: m.contact_name || '—',
      role: m.contact_role || 'other', hook: m.hook || `Olá ${m.contact_name || ''},`,
      productValue: '(produto informado na geração)', day: m.day, channel: m.channel, socialProof,
      rules: buildRules(db, m.channel, m.contact_role),
      posExamples: buildPositiveExamples(db, m.channel),
      negExamples: buildNegativeExamples(db, m.channel),
      threadHistory: buildThreadHistory(db, m.thread_id, m.seq_no),
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
    const rules = buildRules(db, channel, role);
    const posExamples = buildPositiveExamples(db, channel);
    const negExamples = buildNegativeExamples(db, channel);
    const userPromptTemplate = buildSequenceUserPrompt({
      companyName: '{empresa}', sector: '{setor}', contactName: '{contato}', role,
      hook: '{gancho de pesquisa}', productValue: '{produto}',
      day: (SEQUENCE_CHANNELS.find(c => c.channel === channel) || {}).day || 1,
      channel, socialProof, rules, posExamples, negExamples,
      threadHistory: '{histórico da thread — enviadas + respostas do lead}',
      sender: getSessionUser(db, req),
    });
    const hasLearned = !!(rules.global.length || rules.channel.length || posExamples || negExamples);
    db.close();
    res.json({ systemPrompt: SEQ_SYSTEM, userPromptTemplate, hasLearned, channel, role });
  } catch (e) {
    db.close();
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Gerenciamento de usuários
const VALID_USER_TYPES = ['vendas', 'marketing'];

app.get('/api/users', (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT id, username, name, user_type, company_name, signature_name, created_at FROM users ORDER BY created_at DESC').all());
  db.close();
});

app.post('/api/users', (req, res) => {
  const { username, password, name } = req.body;
  const userType = VALID_USER_TYPES.includes(req.body.user_type) ? req.body.user_type : 'vendas';
  const companyName = (req.body.company_name || '').trim();
  const signatureName = (req.body.signature_name || '').trim();
  if (!username || !password) return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  if (userType === 'marketing' && !companyName) {
    return res.status(400).json({ error: 'Perfil marketing exige o nome da empresa/marca' });
  }
  if (userType === 'vendas' && !(name || '').trim()) {
    return res.status(400).json({ error: 'Perfil vendas exige o nome do vendedor' });
  }
  const db = getDb();
  const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (exists) { db.close(); return res.status(409).json({ error: 'Usuário já existe' }); }
  const hash = bcrypt.hashSync(password, 10);
  const r = db.prepare('INSERT INTO users (username, password, name, user_type, company_name, signature_name) VALUES (?,?,?,?,?,?)')
    .run(username, hash, name || '', userType, companyName, signatureName);
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
  // NOTA: `quality_score` é a antiga "response_rate" (média de score×20) — renomeada para não
  // confundir com taxa de resposta de verdade. Mantida para compatibilidade do painel.
  const by_channel = db.prepare("SELECT channel, COUNT(*) as total, SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) as sent, ROUND(AVG(CASE WHEN score IS NOT NULL THEN score * 20 ELSE 0 END), 0) as quality_score, ROUND(AVG(CASE WHEN score IS NOT NULL THEN score * 20 ELSE 0 END), 0) as response_rate FROM messages GROUP BY channel").all();
  const by_role = db.prepare("SELECT role, COUNT(*) as total FROM contacts GROUP BY role").all();
  const funnel = db.prepare("SELECT status, COUNT(*) as total FROM companies GROUP BY status").all();

  // (#4) TAXA DE RESPOSTA REAL (funil): dos contatos abordados, quantos responderam ao menos 1x.
  // "abordado" = existe mensagem outbound/enviada para o contato; "respondeu" = existe inbound (status='received').
  const contacted = db.prepare(
    "SELECT COUNT(DISTINCT contact_id) AS n FROM messages WHERE contact_id IS NOT NULL AND (direction='outbound' OR status IN ('sent','approved'))"
  ).get().n || 0;
  const responded = db.prepare(
    "SELECT COUNT(DISTINCT contact_id) AS n FROM messages WHERE contact_id IS NOT NULL AND status='received'"
  ).get().n || 0;
  // (#4) TAXA DE CONVERSÃO PARA REUNIÃO: empresas em meeting_set sobre empresas abordadas.
  const companiesContacted = db.prepare(
    "SELECT COUNT(*) AS n FROM companies WHERE status IN ('contacted','hot_lead','needs_followup','meeting_set','rejected')"
  ).get().n || 0;
  const meetingsSet = db.prepare("SELECT COUNT(*) AS n FROM companies WHERE status='meeting_set'").get().n || 0;

  const engagement = {
    contacts_contacted: contacted,
    contacts_responded: responded,
    response_rate_pct: contacted ? Math.round((responded / contacted) * 100) : 0,
    companies_contacted: companiesContacted,
    meetings_set: meetingsSet,
    meeting_conversion_pct: companiesContacted ? Math.round((meetingsSet / companiesContacted) * 100) : 0,
  };
  db.close();
  res.json({ by_channel, by_role, funnel, engagement, ab_stats: { decided: 0, b_won: 0 } });
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

// (#6) Gera um follow-up REAL (IA + contexto da conversa) como rascunho pendente para aprovação.
async function generateFollowupDraft(contactId, channel = 'whatsapp') {
  const db = getDb();
  const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(contactId);
  if (!contact) { db.close(); return { error: 'Contato não encontrado' }; }
  const company = db.prepare('SELECT * FROM companies WHERE id=?').get(contact.company_id);
  // Evita duplicar: se já existe um follow-up pendente recente para este contato, não gera outro.
  const dupe = db.prepare(
    "SELECT id FROM messages WHERE contact_id=? AND msg_type='follow_up' AND status='pending'"
  ).get(contactId);
  if (dupe) { db.close(); return { skipped: 'já existe follow-up pendente', id: dupe.id }; }
  const priorTurns = buildSimTurns(db, contact.company_id, contactId, 'vendor');
  db.close();

  const roleInfo = ROLE_PROFILES[contact?.role] || ROLE_PROFILES.other;
  const prompt = `Escreva uma mensagem de FOLLOW-UP curta e educada via ${channel} para reengajar o contato
${contact.name} (${company?.name || 'empresa'}), que não respondeu à última abordagem.
Tom: ${roleInfo.tone}. Foco: ${roleInfo.focus}.
Regras:
- NÃO soe insistente nem repita a mensagem anterior literalmente
- Traga um novo ângulo de valor ou uma pergunta leve que facilite a resposta
- Máx 60 palavras, CTA suave (ex.: "faz sentido um papo rápido?")
- Escreva APENAS o texto da mensagem`;
  const content = await callClaude('Você é SDR especialista em follow-ups B2B que reengajam sem pressionar.', prompt, 200, priorTurns);
  if (isAiError(content)) return { error: 'IA indisponível', detail: content };

  const db2 = getDb();
  const threadId = latestThreadForContact(db2, contactId) || nextThreadId(db2);
  const seqNo = (db2.prepare('SELECT COALESCE(MAX(seq_no),0)+1 AS n FROM messages WHERE thread_id=?').get(threadId).n) || 1;
  const r = db2.prepare(
    "INSERT INTO messages (contact_id, company_id, channel, day, msg_type, content, ai_original, status, approved, direction, thread_id, seq_no, created_at) VALUES (?,?,?,?, 'follow_up', ?, ?, 'pending', 0, 'outbound', ?, ?, datetime('now'))"
  ).run(contactId, contact.company_id, channel, 5, content.trim(), content.trim(), threadId, seqNo);
  db2.close();
  return { id: r.lastInsertRowid, content: content.trim() };
}

app.post('/api/followup/:id/generate', async (req, res) => {
  const channel = req.body.channel || 'whatsapp';
  const out = await generateFollowupDraft(parseInt(req.params.id), channel);
  if (out.error) return res.status(out.error === 'Contato não encontrado' ? 404 : 502).json(out);
  broadcastInboxUpdate();
  res.json({ ok: true, ...out });
});

// (#6) Agendador: a cada intervalo, gera rascunhos de follow-up para leads parados há >= N dias.
// Rascunhos ficam PENDENTES (aprovação humana). Desligado por padrão; habilite via env.
const FOLLOWUP_ENABLED = process.env.FOLLOWUP_SCHEDULER === 'on';
const FOLLOWUP_DAYS = parseInt(process.env.FOLLOWUP_DAYS || '3');
const FOLLOWUP_INTERVAL_MS = parseInt(process.env.FOLLOWUP_INTERVAL_MS || String(6 * 60 * 60 * 1000)); // 6h
async function runFollowupSweep() {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT ct.id FROM contacts ct JOIN companies c ON c.id = ct.company_id
      WHERE c.status NOT IN ('hot_lead','meeting_set','opted_out','rejected')
        AND (ct.opted_out IS NULL OR ct.opted_out=0)
        AND CAST(julianday('now') - julianday(c.created_at) AS INTEGER) >= ?
      LIMIT 25
    `).all(FOLLOWUP_DAYS).map(r => r.id);
    db.close();
    let created = 0;
    for (const id of rows) {
      const out = await generateFollowupDraft(id, 'whatsapp');
      if (out && out.id && !out.skipped) created++;
    }
    if (created) { console.log(`[followup] ${created} rascunho(s) de follow-up gerados`); broadcastInboxUpdate(); }
  } catch (e) { console.warn('[followup] sweep falhou:', e.message); }
}
if (FOLLOWUP_ENABLED) {
  console.log(`[followup] agendador ligado: a cada ${FOLLOWUP_INTERVAL_MS}ms, leads parados >= ${FOLLOWUP_DAYS}d`);
  setInterval(runFollowupSweep, FOLLOWUP_INTERVAL_MS).unref?.();
}
// Gatilho manual da varredura (útil para testes e para operador acionar sob demanda).
app.post('/api/followup/sweep', async (req, res) => { await runFollowupSweep(); res.json({ ok: true }); });

// (#9) Leitura do audit log (mais recentes primeiro), com filtros opcionais.
app.get('/api/audit', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit || '100'), 500);
  const rows = req.query.company_id
    ? db.prepare('SELECT * FROM audit_logs WHERE company_id=? ORDER BY id DESC LIMIT ?').all(parseInt(req.query.company_id), limit)
    : db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit);
  db.close();
  res.json(rows);
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

// Normaliza texto de regra para comparação (acumulação de confiança / dedup).
function normRule(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const MAX_RULES_PER_GROUP = 8;

// Núcleo da destilação de feedback → regras acionáveis. Reutilizado pelo endpoint manual
// e pelo gatilho automático (#7). Faz acumulação de confiança em vez de reescrita destrutiva (#5)
// e promove regras que aparecem em ≥2 canais a escopo global (#8).
async function runDistillation(db) {
  // Fonte 1: reescritas (human_correction) — mostram o "antes → depois".
  const corrections = db.prepare(
    `SELECT m.id AS id, m.channel AS channel, ct.role AS role, m.ai_original AS ai_original, m.human_correction AS human_correction
     FROM messages m LEFT JOIN contacts ct ON ct.id = m.contact_id
     WHERE m.human_correction IS NOT NULL AND m.human_correction != ''
       AND m.ai_original IS NOT NULL
       AND (m.feedback_kind IS NULL OR m.feedback_kind != 'ephemeral')
       AND ABS(LENGTH(m.human_correction) - LENGTH(m.ai_original)) > 10`
  ).all();

  // Fonte 2: comentários puros (score_comment) de mensagens mal avaliadas, SEM reescrita.
  // Antes esses sinais nunca viravam regra — só apareciam como negativos ancorados a cada geração.
  const comments = db.prepare(
    `SELECT m.id AS id, m.channel AS channel, ct.role AS role, m.ai_original AS ai_original, m.content AS content, m.score_comment AS score_comment
     FROM messages m LEFT JOIN contacts ct ON ct.id = m.contact_id
     WHERE m.score_comment IS NOT NULL AND m.score_comment != ''
       AND (m.human_correction IS NULL OR m.human_correction = '')
       AND (m.feedback_kind IS NULL OR m.feedback_kind != 'ephemeral')
       AND m.score IS NOT NULL AND m.score <= 2`
  ).all();

  const totalSignals = corrections.length + comments.length;
  if (totalSignals < 2) {
    return { ok: false, message: 'Sem feedback suficiente ainda. Continue avaliando!' };
  }

  const groups = {};
  const push = (c, kind) => {
    const key = `${c.channel || 'geral'}|${c.role || 'other'}`;
    (groups[key] = groups[key] || []).push({ ...c, kind });
  };
  corrections.forEach(c => push(c, 'rewrite'));
  comments.forEach(c => push(c, 'comment'));

  const analyzed = [];
  for (const [key, items] of Object.entries(groups)) {
    const [channel, role] = key.split('|');
    const examples = items.slice(0, 10).map((c, i) =>
      c.kind === 'rewrite'
        ? `Exemplo ${i + 1} (reescrita):\nORIGINAL (IA): ${c.ai_original}\nCORRIGIDO (humano): ${c.human_correction}`
        : `Exemplo ${i + 1} (crítica direta):\nMENSAGEM (IA): ${c.ai_original || c.content}\nCRÍTICA DO AVALIADOR: ${c.score_comment}`
    ).join('\n\n');

    const prompt =
      `Analise o feedback humano abaixo (canal: ${channel}, cargo: ${role}) — inclui reescritas e críticas diretas — ` +
      `e destile de 2 a 4 REGRAS ACIONÁVEIS escritas como INSTRUÇÕES IMPERATIVAS (não transcreva a reclamação; diga o que fazer/evitar). ` +
      `Responda APENAS com um array JSON de strings curtas, ` +
      `ex: ["Não abra a mensagem com o nome do contato depois da primeira", "Nunca use asteriscos de markdown (**) — não parece humano"].\n\n${examples}`;

    let rules = [];
    try {
      const raw = await callClaude('Você é analista de estilo de escrita comercial. Responda só com JSON.', prompt, 400);
      const match = String(raw).match(/\[[\s\S]*\]/);
      rules = match ? JSON.parse(match[0]) : [];
    } catch (_) { rules = []; }
    rules = (rules || []).filter(r => typeof r === 'string' && r.trim()).slice(0, 4);
    if (!rules.length) { analyzed.push({ channel, role, rules_extracted: 0 }); continue; }

    const sourceIds = JSON.stringify(items.map(c => c.id).filter(Boolean));
    const sample = items.length;
    const bump = db.prepare(
      `UPDATE learned_patterns SET confidence=?, sample_size=?, source_message_ids=?, updated_at=datetime('now') WHERE id=?`
    );
    const ins = db.prepare(
      `INSERT INTO learned_patterns (channel, role, pattern, confidence, sample_size, scope, status, source_message_ids, updated_at)
       VALUES (?,?,?,?,?,?,?,?,datetime('now'))`
    );

    // Acumulação: regra que já existe (mesmo texto normalizado) sobe confiança; nova é inserida.
    const existing = db.prepare(
      `SELECT id, pattern, confidence FROM learned_patterns
       WHERE channel=? AND role=? AND (status IS NULL OR status='active')`
    ).all(channel, role);
    const byNorm = new Map(existing.map(e => [normRule(e.pattern), e]));

    for (const r of rules) {
      const prev = byNorm.get(normRule(r));
      if (prev) {
        const conf = Math.min(0.98, (prev.confidence || 0.5) + 0.1); // concordância repetida → sobe
        bump.run(conf, sample, sourceIds, prev.id);
      } else {
        const conf = Math.min(0.9, 0.5 + sample * 0.1);
        ins.run(channel, role, r, conf, sample, 'channel', 'active', sourceIds);
      }
    }

    // Detecção de contradição semântica (#3): pede ao modelo os pares de regras opostas;
    // aposenta a mais ANTIGA de cada par (recência vence).
    await retireContradictions(db, channel, role);

    // Anti-crescimento: mantém só as MAX_RULES_PER_GROUP mais confiantes; aposenta o resto.
    const overflow = db.prepare(
      `SELECT id FROM learned_patterns
       WHERE channel=? AND role=? AND (status IS NULL OR status='active')
       ORDER BY confidence DESC, id DESC LIMIT -1 OFFSET ?`
    ).all(channel, role, MAX_RULES_PER_GROUP);
    for (const o of overflow) {
      db.prepare(`UPDATE learned_patterns SET status='retired', updated_at=datetime('now') WHERE id=?`).run(o.id);
    }

    analyzed.push({ channel, role, rules_extracted: rules.length });
  }

  // Escopo global (#8): regra (texto normalizado) ativa em ≥2 canais vira 'global'; se cair
  // para <2 canais, é rebaixada de volta para 'channel' (demotion).
  try {
    const active = db.prepare(`SELECT id, pattern, channel, scope FROM learned_patterns WHERE status IS NULL OR status='active'`).all();
    const chansByNorm = new Map();
    for (const a of active) {
      const n = normRule(a.pattern);
      if (!chansByNorm.has(n)) chansByNorm.set(n, new Set());
      chansByNorm.get(n).add(a.channel);
    }
    for (const a of active) {
      const spread = chansByNorm.get(normRule(a.pattern)).size;
      const target = spread >= 2 ? 'global' : 'channel';
      if ((a.scope || 'channel') !== target) {
        db.prepare(`UPDATE learned_patterns SET scope=?, updated_at=datetime('now') WHERE id=?`).run(target, a.id);
      }
    }
  } catch (_) { /* best-effort */ }

  return { ok: true, analyzed };
}

// Pergunta ao modelo quais regras ativas de um grupo se contradizem e aposenta a mais antiga do par.
async function retireContradictions(db, channel, role) {
  try {
    const active = db.prepare(
      `SELECT id, pattern FROM learned_patterns
       WHERE channel=? AND role=? AND (status IS NULL OR status='active') ORDER BY id ASC`
    ).all(channel, role);
    if (active.length < 2) return;
    const list = active.map(r => `${r.id}: ${r.pattern}`).join('\n');
    const prompt =
      `Abaixo há regras de estilo (id: texto). Identifique pares que se CONTRADIZEM diretamente ` +
      `(uma manda fazer X, outra manda não fazer X). Responda APENAS um array JSON de pares de ids, ` +
      `ex: [[3,7],[5,9]]. Se não houver contradição, responda [].\n\n${list}`;
    const raw = await callClaude('Você detecta contradições lógicas entre regras. Responda só com JSON.', prompt, 200);
    const m = String(raw).match(/\[[\s\S]*\]/);
    const pairs = m ? JSON.parse(m[0]) : [];
    const valid = new Set(active.map(r => r.id));
    for (const pair of (Array.isArray(pairs) ? pairs : [])) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [a, b] = pair.map(Number);
      if (!valid.has(a) || !valid.has(b)) continue;
      const older = Math.min(a, b); // id menor = mais antigo → aposenta
      db.prepare(`UPDATE learned_patterns SET status='superseded', updated_at=datetime('now') WHERE id=?`).run(older);
      valid.delete(older);
    }
  } catch (_) { /* best-effort — contradição é refinamento, não pode quebrar a destilação */ }
}

// Dispara a destilação em segundo plano (não bloqueia a resposta) quando há correções novas (#7).
// Debounce (#7): evita rodar várias destilações concorrentes se o avaliador dá vários feedbacks seguidos.
let _distilling = false;
function maybeAutoDistill() {
  if (_distilling) return; // já há uma destilação em andamento
  try {
    const db = getDb();
    // Conta correções ainda não incorporadas em nenhuma regra ativa (heurística por data).
    const lastRule = db.prepare(`SELECT MAX(updated_at) AS t FROM learned_patterns WHERE status IS NULL OR status='active'`).get().t;
    const newCorr = db.prepare(
      `SELECT COUNT(*) AS n FROM messages
       WHERE (feedback_kind IS NULL OR feedback_kind != 'ephemeral')
         AND (
           (human_correction IS NOT NULL AND human_correction != '')
           OR (score_comment IS NOT NULL AND score_comment != '' AND score IS NOT NULL AND score <= 2)
         )
         AND (? IS NULL OR COALESCE(created_at,'') > ?)`
    ).get(lastRule, lastRule).n;
    db.close();
    if (newCorr >= 3) {
      _distilling = true;
      const db2 = getDb();
      runDistillation(db2).catch(() => {}).finally(() => { db2.close(); _distilling = false; });
    }
  } catch (_) { _distilling = false; /* best-effort */ }
}

// Analisa correções humanas e extrai regras de estilo (padrões aprendidos)
app.post('/api/learn/analyze', async (req, res) => {
  const db = getDb();
  try {
    const out = await runDistillation(db);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    db.close();
  }
});

// Gestão de regras aprendidas (#9): listar, editar, aposentar/remover manualmente.
app.get('/api/learn/rules', (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(
      `SELECT id, channel, role, pattern, confidence, sample_size, scope, status, updated_at, created_at
       FROM learned_patterns ORDER BY (status='active') DESC, confidence DESC, id DESC`
    ).all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  finally { db.close(); }
});

app.patch('/api/learn/rules/:id', (req, res) => {
  const sets = [], vals = [];
  if (req.body.pattern !== undefined) { sets.push('pattern=?'); vals.push(String(req.body.pattern)); }
  if (req.body.status  !== undefined && ['active','retired','superseded'].includes(req.body.status)) { sets.push('status=?'); vals.push(req.body.status); }
  if (req.body.scope   !== undefined && ['global','channel'].includes(req.body.scope)) { sets.push('scope=?'); vals.push(req.body.scope); }
  if (req.body.confidence !== undefined) { const c = Math.max(0, Math.min(1, Number(req.body.confidence))); if (!Number.isNaN(c)) { sets.push('confidence=?'); vals.push(c); } }
  if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar' });
  sets.push("updated_at=datetime('now')");
  const db = getDb();
  try {
    vals.push(req.params.id);
    const r = db.prepare(`UPDATE learned_patterns SET ${sets.join(',')} WHERE id=?`).run(...vals);
    if (!r.changes) return res.status(404).json({ error: 'Regra não encontrada' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  finally { db.close(); }
});

app.delete('/api/learn/rules/:id', (req, res) => {
  const db = getDb();
  try {
    const r = db.prepare('DELETE FROM learned_patterns WHERE id=?').run(req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'Regra não encontrada' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  finally { db.close(); }
});

// Impacto das regras (#4): compara o score médio das mensagens do canal ANTES e DEPOIS de
// cada regra passar a existir (learned_patterns.updated_at). Fecha o loop mostrando se aprender
// a regra melhorou a qualidade. Sem mudança de schema — usa messages.created_at + score.
app.get('/api/learn/rule-impact', (req, res) => {
  const db = getDb();
  try {
    const rules = db.prepare(
      `SELECT id, channel, role, pattern, scope, status, updated_at, created_at FROM learned_patterns
       ORDER BY (status='active') DESC, confidence DESC`
    ).all();
    const out = rules.map(r => {
      const ref = r.updated_at || r.created_at;
      const before = db.prepare(
        `SELECT ROUND(AVG(score),2) AS avg, COUNT(*) AS n FROM messages
         WHERE channel=? AND score IS NOT NULL AND COALESCE(created_at,'') < ?`
      ).get(r.channel, ref);
      const after = db.prepare(
        `SELECT ROUND(AVG(score),2) AS avg, COUNT(*) AS n FROM messages
         WHERE channel=? AND score IS NOT NULL AND COALESCE(created_at,'') >= ?`
      ).get(r.channel, ref);
      const delta = (before.avg != null && after.avg != null) ? Math.round((after.avg - before.avg) * 100) / 100 : null;
      return {
        id: r.id, channel: r.channel, role: r.role, pattern: r.pattern, scope: r.scope, status: r.status,
        avg_before: before.avg, n_before: before.n, avg_after: after.avg, n_after: after.n, delta,
      };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  finally { db.close(); }
});

// Catch-all route to serve React frontend for non-API requests
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Sales AI Agent rodando em http://localhost:${PORT}`);
  console.log(`Login: admin / admin123`);
});
