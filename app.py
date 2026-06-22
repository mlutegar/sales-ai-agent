import os
import json
import sqlite3
import io
import csv
import logging
import threading
import time
from datetime import datetime
from flask import Flask, render_template, request, jsonify, g, Response
from dotenv import load_dotenv

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(funcName)s — %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
)
log = logging.getLogger(__name__)

load_dotenv()

app = Flask(__name__)
DATABASE = 'prototype.db'

ROLE_PROFILES = {
    'c_level': {'focus': 'ROI, estratégia e impacto no negócio', 'tone': 'executivo e direto'},
    'manager': {'focus': 'performance, eficiência operacional e resultados da equipe', 'tone': 'consultivo e orientado a dados'},
    'engineer': {'focus': 'especificações técnicas, integração e performance', 'tone': 'técnico e detalhado'},
    'other': {'focus': 'benefícios gerais e facilidade de uso', 'tone': 'amigável e claro'},
}

SEQUENCE_CHANNELS = [
    {'day': 1, 'channel': 'linkedin', 'type': 'connection_request'},
    {'day': 3, 'channel': 'email',    'type': 'first_outreach'},
    {'day': 5, 'channel': 'whatsapp', 'type': 'follow_up'},
]


# ── DB ──────────────────────────────────────────────────────────────────────

def get_db():
    db = getattr(g, '_db', None)
    if db is None:
        db = g._db = sqlite3.connect(DATABASE)
        db.row_factory = sqlite3.Row
    return db


@app.teardown_appcontext
def close_db(exc):
    db = getattr(g, '_db', None)
    if db:
        db.close()


def init_db():
    db = sqlite3.connect(DATABASE)
    db.executescript('''
        CREATE TABLE IF NOT EXISTS leads (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            name          TEXT    NOT NULL,
            company       TEXT    NOT NULL,
            role          TEXT    NOT NULL DEFAULT 'other',
            email         TEXT    DEFAULT '',
            linkedin      TEXT    DEFAULT '',
            whatsapp      TEXT    DEFAULT '',
            sector        TEXT    DEFAULT '',
            status        TEXT    DEFAULT 'new',
            interest_score INTEGER DEFAULT 0,
            research_hook TEXT,
            research_context TEXT,
            opted_out     INTEGER DEFAULT 0,
            created_at    TEXT    DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS messages (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            lead_id          INTEGER NOT NULL,
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
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            lead_id       INTEGER,
            response_text TEXT,
            sentiment     TEXT,
            reasoning     TEXT,
            interest_score INTEGER,
            created_at    TEXT DEFAULT (datetime('now'))
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
        CREATE TABLE IF NOT EXISTS learned_patterns (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            channel     TEXT    NOT NULL,
            role        TEXT    NOT NULL,
            pattern     TEXT    NOT NULL,
            confidence  REAL    DEFAULT 0.5,
            sample_size INTEGER DEFAULT 0,
            created_at  TEXT    DEFAULT (datetime('now')),
            updated_at  TEXT    DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS ab_variants (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            lead_id    INTEGER NOT NULL,
            channel    TEXT    NOT NULL,
            msg_id_a   INTEGER,
            variant_b  TEXT    NOT NULL,
            winner     TEXT    DEFAULT NULL,
            created_at TEXT    DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS lead_interactions (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            lead_id          INTEGER NOT NULL,
            channel          TEXT,
            interaction_type TEXT    NOT NULL,
            notes            TEXT,
            created_at       TEXT    DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS timing_analytics (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            lead_id      INTEGER,
            channel      TEXT,
            sector       TEXT,
            role         TEXT,
            day_of_week  INTEGER,
            hour_of_day  INTEGER,
            got_response INTEGER DEFAULT 0,
            created_at   TEXT    DEFAULT (datetime('now'))
        );
    ''')
    # Adiciona tabelas CRM (companies, contacts, opportunities) se não existirem
    db.executescript('''
        CREATE TABLE IF NOT EXISTS companies (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL UNIQUE,
            sector     TEXT    DEFAULT '',
            website    TEXT    DEFAULT '',
            notes      TEXT    DEFAULT '',
            created_at TEXT    DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS contacts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id  INTEGER NOT NULL,
            name        TEXT    NOT NULL,
            role        TEXT    NOT NULL DEFAULT 'other',
            email       TEXT    DEFAULT '',
            linkedin    TEXT    DEFAULT '',
            whatsapp    TEXT    DEFAULT '',
            country     TEXT    DEFAULT 'BR',
            status      TEXT    DEFAULT 'new',
            interest_score INTEGER DEFAULT 0,
            research_hook    TEXT,
            research_context TEXT,
            opted_out   INTEGER DEFAULT 0,
            is_primary  INTEGER DEFAULT 0,
            created_at  TEXT    DEFAULT (datetime('now')),
            FOREIGN KEY (company_id) REFERENCES companies(id)
        );
        CREATE TABLE IF NOT EXISTS opportunities (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id  INTEGER NOT NULL,
            name        TEXT    NOT NULL,
            stage       TEXT    DEFAULT 'prospecting',
            value       REAL    DEFAULT 0,
            notes       TEXT    DEFAULT '',
            created_at  TEXT    DEFAULT (datetime('now')),
            FOREIGN KEY (company_id) REFERENCES companies(id)
        );
    ''')
    # Índices para performance (idempotentes — IF NOT EXISTS)
    db.executescript('''
        CREATE INDEX IF NOT EXISTS idx_leads_status    ON leads(status);
        CREATE INDEX IF NOT EXISTS idx_leads_company   ON leads(company);
        CREATE INDEX IF NOT EXISTS idx_contacts_cid    ON contacts(company_id);
        CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
        CREATE INDEX IF NOT EXISTS idx_messages_lead   ON messages(lead_id);
        CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
        CREATE INDEX IF NOT EXISTS idx_sentiments_lead ON sentiment_logs(lead_id);
        CREATE INDEX IF NOT EXISTS idx_interactions_lead ON lead_interactions(lead_id);
        CREATE INDEX IF NOT EXISTS idx_patterns_ch_role ON learned_patterns(channel, role);
    ''')
    db.commit()

    # Migrations seguras: adicionar colunas se não existirem
    for sql in [
        "ALTER TABLE leads ADD COLUMN country TEXT DEFAULT 'BR'",
        "ALTER TABLE messages ADD COLUMN contact_id INTEGER",
    ]:
        try:
            db.execute(sql)
            db.commit()
        except Exception:
            pass
    db.commit()
    db.close()
    # Migra leads existentes para o modelo companies/contacts (executa uma vez)
    _migrate_leads_to_contacts()


# ── Aprendizado de máquina (feedback loop) ───────────────────────────────────

def get_learned_context(db, channel, role):
    """
    Retorna um bloco de texto com:
    - até 3 exemplos aprovados/bem avaliados para este canal+perfil
    - até 3 padrões de estilo aprendidos das correções humanas
    Esse bloco é injetado no prompt de geração como few-shot context.
    """
    # Exemplos reais aprovados e bem avaliados (score >= 4 OU aprovado sem correção)
    examples = db.execute(
        '''SELECT m.content, m.score, l.role, l.sector
           FROM messages m
           JOIN leads l ON l.id = m.lead_id
           WHERE m.channel = ?
             AND l.role = ?
             AND m.approved = 1
             AND (m.score >= 4 OR (m.human_correction IS NULL AND m.score IS NOT NULL))
           ORDER BY m.score DESC, m.id DESC
           LIMIT 3''',
        (channel, role)
    ).fetchall()

    # Padrões extraídos de correções anteriores
    patterns = db.execute(
        '''SELECT pattern FROM learned_patterns
           WHERE channel = ? AND role = ?
           ORDER BY confidence DESC, updated_at DESC
           LIMIT 3''',
        (channel, role)
    ).fetchall()

    block = ''
    if examples:
        block += '\n--- EXEMPLOS APROVADOS (imite este estilo) ---\n'
        for i, ex in enumerate(examples, 1):
            block += f'Exemplo {i}: {ex["content"]}\n'

    if patterns:
        block += '\n--- REGRAS DE ESTILO APRENDIDAS ---\n'
        for p in patterns:
            block += f'• {p["pattern"]}\n'

    return block


# ── Migração: leads → companies/contacts ─────────────────────────────────────

def _migrate_leads_to_contacts():
    """Migra leads existentes para o modelo companies/contacts (idempotente)."""
    db = sqlite3.connect(DATABASE)
    db.row_factory = sqlite3.Row
    try:
        leads = db.execute('SELECT * FROM leads').fetchall()
        for l in leads:
            # Cria ou busca empresa
            comp = db.execute('SELECT id FROM companies WHERE name=?', (l['company'],)).fetchone()
            if not comp:
                cur = db.execute(
                    'INSERT INTO companies (name, sector) VALUES (?,?)',
                    (l['company'], l['sector'] or '')
                )
                comp_id = cur.lastrowid
            else:
                comp_id = comp['id']
            # Cria ou busca contato
            ct = db.execute('SELECT id FROM contacts WHERE company_id=? AND name=?', (comp_id, l['name'])).fetchone()
            if not ct:
                country = 'BR'
                try:
                    country = l['country'] or 'BR'
                except Exception:
                    pass
                db.execute(
                    '''INSERT INTO contacts
                       (company_id,name,role,email,linkedin,whatsapp,country,status,
                        interest_score,research_hook,research_context,opted_out,is_primary)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)''',
                    (comp_id, l['name'], l['role'], l['email'], l['linkedin'], l['whatsapp'],
                     country, l['status'], l['interest_score'],
                     l['research_hook'], l['research_context'], l['opted_out'])
                )
        db.commit()
    except Exception:
        pass
    finally:
        db.close()


# ── Compliance footer por país ──────────────────────────────────────────────

COMPLIANCE_TEXTS = {
    'BR': '\n\n---\n📋 Em conformidade com a LGPD (Lei 13.709/18): você pode solicitar a remoção dos seus dados da nossa base a qualquer momento respondendo SAIR.',
    'EU': '\n\n---\n📋 Under GDPR (EU 2016/679): you have the right to erasure and data portability. Reply UNSUBSCRIBE to opt out at any time.',
    'US': '\n\n---\n📋 CAN-SPAM Act compliance: This is a commercial message. To unsubscribe from future emails, reply STOP or click the unsubscribe link.',
}

def get_compliance_footer(country):
    country = (country or 'BR').upper()
    # Países da EU
    eu_countries = {'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR',
                    'HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK',
                    'SI','ES','SE','EU'}
    if country in eu_countries:
        return COMPLIANCE_TEXTS['EU']
    if country == 'US':
        return COMPLIANCE_TEXTS['US']
    return COMPLIANCE_TEXTS.get(country, COMPLIANCE_TEXTS['BR'])


# ── Claude helper ────────────────────────────────────────────────────────────

def call_claude(system_prompt, user_prompt, max_tokens=800):
    """
    Chama a API da Anthropic com retry automático (3 tentativas, backoff exponencial).
    Trata rate-limits (429) e erros de conexão com espera progressiva de 1s/2s/4s.
    """
    api_key = os.getenv('ANTHROPIC_API_KEY')
    if not api_key:
        log.error('ANTHROPIC_API_KEY não configurada')
        return '[ERRO: Configure ANTHROPIC_API_KEY no arquivo .env]'

    from anthropic import Anthropic, RateLimitError, APIConnectionError, APIStatusError

    client = Anthropic(api_key=api_key, timeout=35.0)
    max_attempts = 3

    for attempt in range(1, max_attempts + 1):
        try:
            msg = client.messages.create(
                model='claude-sonnet-4-6',
                max_tokens=max_tokens,
                system=system_prompt,
                messages=[{'role': 'user', 'content': user_prompt}],
            )
            if attempt > 1:
                log.info(f'Claude respondeu na tentativa {attempt}')
            return msg.content[0].text

        except RateLimitError as e:
            wait = 2 ** attempt  # 2s, 4s, 8s
            log.warning(f'Rate limit atingido (tentativa {attempt}/{max_attempts}). Aguardando {wait}s... [{e}]')
            if attempt < max_attempts:
                time.sleep(wait)
            else:
                log.error('Rate limit: todas as tentativas esgotadas')
                return '[ERRO: Limite de requisições atingido. Tente novamente em alguns segundos.]'

        except APIConnectionError as e:
            wait = 2 ** (attempt - 1)  # 1s, 2s, 4s
            log.warning(f'Erro de conexão (tentativa {attempt}/{max_attempts}). Aguardando {wait}s... [{e}]')
            if attempt < max_attempts:
                time.sleep(wait)
            else:
                log.error('Erro de conexão: todas as tentativas esgotadas')
                return '[ERRO: Falha de conexão com a API. Verifique sua internet.]'

        except APIStatusError as e:
            log.error(f'Erro de status da API: {e.status_code} — {e.message}')
            return f'[ERRO API {e.status_code}: {e.message}]'

        except Exception as e:
            log.error(f'Erro inesperado na API Claude: {type(e).__name__}: {e}')
            return f'[ERRO inesperado: {type(e).__name__}]'

    return '[ERRO: Não foi possível completar a requisição]'


# ── Routes ───────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


# Stats
@app.route('/api/stats')
def stats():
    db = get_db()
    pipeline = db.execute(
        "SELECT COALESCE(SUM(value),0) FROM opportunities WHERE stage NOT IN ('lost')"
    ).fetchone()[0]
    enriched = db.execute("SELECT COUNT(*) FROM contacts WHERE email != ''").fetchone()[0]
    total_contacts = db.execute('SELECT COUNT(*) FROM contacts').fetchone()[0]
    return jsonify({
        'total_leads':       db.execute('SELECT COUNT(*) FROM leads').fetchone()[0],
        'total_companies':   db.execute('SELECT COUNT(*) FROM companies').fetchone()[0],
        'total_contacts':    total_contacts,
        'opted_out':         db.execute('SELECT COUNT(*) FROM contacts WHERE opted_out=1').fetchone()[0],
        'hot_leads':         db.execute("SELECT COUNT(*) FROM contacts WHERE status='hot_lead'").fetchone()[0],
        'meetings':          db.execute("SELECT COUNT(*) FROM contacts WHERE status='meeting_set'").fetchone()[0],
        'pending_review':    db.execute("SELECT COUNT(*) FROM messages WHERE approved=0 AND status='pending'").fetchone()[0],
        'docs_count':        db.execute('SELECT COUNT(*) FROM documents').fetchone()[0],
        'golden_cases':      db.execute('SELECT COUNT(*) FROM golden_cases').fetchone()[0],
        'avg_score':         db.execute('SELECT ROUND(AVG(score),1) FROM messages WHERE score IS NOT NULL').fetchone()[0],
        'pipeline_value':    pipeline,
        'enriched_contacts': enriched,
    })


# ── Companies ─────────────────────────────────────────────────────────────────

@app.route('/api/companies', methods=['GET'])
def list_companies():
    db = get_db()
    rows = db.execute(
        '''SELECT c.*,
                  COUNT(DISTINCT ct.id) as contact_count,
                  MAX(ct.status) as status,
                  MAX(ct.interest_score) as interest_score
           FROM companies c
           LEFT JOIN contacts ct ON ct.company_id=c.id
           GROUP BY c.id ORDER BY c.created_at DESC'''
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/companies', methods=['POST'])
def create_company():
    data = request.json or {}
    name = data.get('name', '').strip()
    if not name:
        return jsonify({'error': 'Nome obrigatório'}), 400
    db = get_db()
    dup = db.execute('SELECT id FROM companies WHERE name=?', (name,)).fetchone()
    if dup:
        return jsonify({'id': dup['id'], 'existing': True})
    cur = db.execute('INSERT INTO companies (name,sector,website,notes) VALUES (?,?,?,?)',
                     (name, data.get('sector',''), data.get('website',''), data.get('notes','')))
    db.commit()
    return jsonify({'id': cur.lastrowid})


@app.route('/api/companies/<int:cid>', methods=['GET'])
def get_company(cid):
    db = get_db()
    comp = db.execute('SELECT * FROM companies WHERE id=?', (cid,)).fetchone()
    if not comp:
        return jsonify({'error': 'Não encontrada'}), 404
    contacts = db.execute('SELECT * FROM contacts WHERE company_id=? ORDER BY is_primary DESC, id', (cid,)).fetchall()
    # Busca mensagens de todos os contatos
    contact_ids = [c['id'] for c in contacts]
    msgs = []
    if contact_ids:
        placeholders = ','.join('?' * len(contact_ids))
        msgs = db.execute(
            f'SELECT m.*, ct.name as contact_name FROM messages m JOIN contacts ct ON ct.id=m.contact_id WHERE m.contact_id IN ({placeholders}) ORDER BY m.day',
            contact_ids
        ).fetchall()
        # fallback: busca por lead_id mapeado pelo nome+empresa
        if not msgs:
            for ct in contacts:
                lead = db.execute(
                    'SELECT id FROM leads WHERE name=? AND company=?', (ct['name'], comp['name'])
                ).fetchone()
                if lead:
                    lead_msgs = db.execute(
                        'SELECT m.*, ? as contact_name FROM messages m WHERE m.lead_id=? ORDER BY m.day',
                        (ct['name'], lead['id'])
                    ).fetchall()
                    msgs.extend(lead_msgs)
    slots = db.execute(
        '''SELECT s.* FROM schedule_slots s
           WHERE s.lead_id IN (
               SELECT l.id FROM leads l WHERE l.company=?
           )''', (comp['name'],)
    ).fetchall()
    logs = db.execute(
        '''SELECT cl.*, ct.name as contact_name
           FROM consent_logs cl LEFT JOIN contacts ct ON cl.lead_id=ct.id
           WHERE cl.lead_id IN (SELECT id FROM contacts WHERE company_id=?)
           ORDER BY cl.created_at DESC LIMIT 50''', (cid,)
    ).fetchall()
    sents = db.execute(
        '''SELECT sl.* FROM sentiment_logs sl
           WHERE sl.lead_id IN (SELECT id FROM contacts WHERE company_id=?)
           ORDER BY sl.created_at DESC LIMIT 10''', (cid,)
    ).fetchall()
    timeline = db.execute(
        '''SELECT li.* FROM lead_interactions li
           WHERE li.lead_id IN (SELECT id FROM contacts WHERE company_id=?)
           ORDER BY li.created_at DESC LIMIT 30''', (cid,)
    ).fetchall()
    return jsonify({
        'company': dict(comp),
        'contacts': [dict(c) for c in contacts],
        'messages': [dict(m) for m in msgs],
        'slots': [dict(s) for s in slots],
        'consent_logs': [dict(l) for l in logs],
        'sentiments': [dict(s) for s in sents],
        'timeline': [dict(t) for t in timeline],
    })


@app.route('/api/companies/<int:cid>', methods=['PUT'])
def update_company(cid):
    data = request.json or {}
    db = get_db()
    db.execute('UPDATE companies SET name=?, sector=?, website=?, notes=? WHERE id=?',
               (data.get('name',''), data.get('sector',''), data.get('website',''), data.get('notes',''), cid))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/companies/<int:cid>', methods=['DELETE'])
def delete_company(cid):
    db = get_db()
    comp = db.execute('SELECT name FROM companies WHERE id=?', (cid,)).fetchone()
    if comp:
        # Remove leads associados
        db.execute('DELETE FROM leads WHERE company=?', (comp['name'],))
        db.execute('DELETE FROM contacts WHERE company_id=?', (cid,))
        db.execute('DELETE FROM opportunities WHERE company_id=?', (cid,))
    db.execute('DELETE FROM companies WHERE id=?', (cid,))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/companies/<int:cid>/timeline', methods=['GET'])
def company_timeline(cid):
    db = get_db()
    rows = db.execute(
        '''SELECT li.* FROM lead_interactions li
           WHERE li.lead_id IN (SELECT id FROM contacts WHERE company_id=?)
           ORDER BY li.created_at DESC LIMIT 50''', (cid,)
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/companies/<int:cid>/optout', methods=['POST'])
def company_optout(cid):
    db = get_db()
    db.execute("UPDATE contacts SET opted_out=1, status='opted_out' WHERE company_id=?", (cid,))
    # Também atualiza leads legados
    comp = db.execute('SELECT name FROM companies WHERE id=?', (cid,)).fetchone()
    if comp:
        db.execute("UPDATE leads SET opted_out=1, status='opted_out' WHERE company=?", (comp['name'],))
        db.execute(
            "UPDATE messages SET status='cancelled' WHERE lead_id IN (SELECT id FROM leads WHERE company=?) AND status IN ('pending','approved')",
            (comp['name'],)
        )
    db.execute('INSERT INTO consent_logs (lead_id, action, details) VALUES (?,?,?)',
               (cid, 'opted_out', 'Opt-out LGPD — empresa removida de todas as cadências'))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/companies/<int:cid>/research', methods=['POST'])
def company_research(cid):
    db = get_db()
    comp = db.execute('SELECT * FROM companies WHERE id=?', (cid,)).fetchone()
    if not comp:
        return jsonify({'error': 'Não encontrada'}), 404
    contact_id = request.json.get('contact_id')
    contact = None
    if contact_id:
        contact = db.execute('SELECT * FROM contacts WHERE id=?', (contact_id,)).fetchone()
    if not contact:
        contact = db.execute('SELECT * FROM contacts WHERE company_id=? ORDER BY is_primary DESC LIMIT 1', (cid,)).fetchone()
    if not contact:
        return jsonify({'error': 'Adicione um contato primeiro'}), 400
    # Redireciona para lógica existente usando lead mapeado
    lead = db.execute('SELECT id FROM leads WHERE name=? AND company=?', (contact['name'], comp['name'])).fetchone()
    if not lead:
        # Cria lead temporário mapeado
        cur = db.execute(
            'INSERT INTO leads (name,company,role,email,linkedin,whatsapp,sector,country) VALUES (?,?,?,?,?,?,?,?)',
            (contact['name'], comp['name'], contact['role'], contact['email'],
             contact['linkedin'], contact['whatsapp'], comp['sector'], contact['country'])
        )
        db.commit()
        lid = cur.lastrowid
    else:
        lid = lead['id']
    # Chama lógica de pesquisa existente
    from flask import current_app
    with current_app.test_request_context(
        f'/api/leads/{lid}/research',
        method='POST',
        json=request.json
    ):
        result = research_lead(lid)
        data = result.get_json()
    # Atualiza contato com hook
    db.execute('UPDATE contacts SET research_hook=?, research_context=?, status=? WHERE id=?',
               (data.get('hook',''), data.get('context',''), 'researched', contact['id']))
    db.commit()
    return jsonify(data)


@app.route('/api/companies/<int:cid>/sequence', methods=['POST'])
def company_sequence(cid):
    db = get_db()
    comp = db.execute('SELECT * FROM companies WHERE id=?', (cid,)).fetchone()
    if not comp:
        return jsonify({'error': 'Não encontrada'}), 404
    contact_id = request.json.get('contact_id')
    contact = None
    if contact_id:
        contact = db.execute('SELECT * FROM contacts WHERE id=? AND company_id=?', (contact_id, cid)).fetchone()
    if not contact:
        contact = db.execute('SELECT * FROM contacts WHERE company_id=? ORDER BY is_primary DESC LIMIT 1', (cid,)).fetchone()
    if not contact:
        return jsonify({'error': 'Adicione um contato primeiro'}), 400
    # Garante lead mapeado
    lead = db.execute('SELECT id FROM leads WHERE name=? AND company=?', (contact['name'], comp['name'])).fetchone()
    if not lead:
        cur = db.execute(
            'INSERT INTO leads (name,company,role,email,linkedin,whatsapp,sector,country,research_hook,research_context) VALUES (?,?,?,?,?,?,?,?,?,?)',
            (contact['name'], comp['name'], contact['role'], contact['email'],
             contact['linkedin'], contact['whatsapp'], comp['sector'], contact['country'],
             contact.get('research_hook',''), contact.get('research_context',''))
        )
        db.commit()
        lid = cur.lastrowid
    else:
        lid = lead['id']
        # Sync research hook
        if contact['research_hook']:
            db.execute('UPDATE leads SET research_hook=?, research_context=? WHERE id=?',
                       (contact['research_hook'], contact['research_context'], lid))
            db.commit()
    # Chama generate_sequence existente — precisa de contexto de requisição
    from flask import current_app
    with current_app.test_request_context(
        f'/api/leads/{lid}/sequence',
        method='POST',
        json=request.json
    ):
        result = generate_sequence(lid)
        data = result.get_json()
    # Atualiza status do contato
    db.execute("UPDATE contacts SET status='sequence_created' WHERE id=?", (contact['id'],))
    db.commit()
    return jsonify(data)


@app.route('/api/companies/<int:cid>/response', methods=['POST'])
def company_response(cid):
    db = get_db()
    comp = db.execute('SELECT * FROM companies WHERE id=?', (cid,)).fetchone()
    if not comp:
        return jsonify({'error': 'Não encontrada'}), 404
    contact_id = request.json.get('contact_id')
    contact = None
    if contact_id:
        contact = db.execute('SELECT * FROM contacts WHERE id=?', (contact_id,)).fetchone()
    if not contact:
        contact = db.execute('SELECT * FROM contacts WHERE company_id=? ORDER BY is_primary DESC LIMIT 1', (cid,)).fetchone()
    if not contact:
        return jsonify({'error': 'Contato não encontrado'}), 400
    lead = db.execute('SELECT id FROM leads WHERE name=? AND company=?', (contact['name'], comp['name'])).fetchone()
    if not lead:
        return jsonify({'error': 'Sequência não encontrada para este contato'}), 400
    from flask import current_app
    with current_app.test_request_context(
        f'/api/leads/{lead["id"]}/response',
        method='POST',
        json=request.json
    ):
        result = record_response(lead['id'])
        data = result.get_json()
    # Sync status back to contact
    db.execute('UPDATE contacts SET status=?, interest_score=? WHERE id=?',
               (data.get('sentiment','contacted'), data.get('interest_score', 5), contact['id']))
    db.commit()
    return jsonify(data)


# ── Contacts ──────────────────────────────────────────────────────────────────

@app.route('/api/contacts', methods=['GET'])
def search_contacts():
    q = request.args.get('q', '')
    db = get_db()
    if q:
        rows = db.execute(
            '''SELECT ct.*, c.name as company_name, c.id as company_id
               FROM contacts ct JOIN companies c ON c.id=ct.company_id
               WHERE ct.name LIKE ? OR ct.email LIKE ? OR c.name LIKE ?
               LIMIT 20''',
            (f'%{q}%', f'%{q}%', f'%{q}%')
        ).fetchall()
    else:
        rows = db.execute(
            '''SELECT ct.*, c.name as company_name, c.id as company_id
               FROM contacts ct JOIN companies c ON c.id=ct.company_id
               ORDER BY ct.created_at DESC LIMIT 100'''
        ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/companies/<int:cid>/contacts', methods=['GET'])
def list_contacts(cid):
    db = get_db()
    rows = db.execute('SELECT * FROM contacts WHERE company_id=? ORDER BY is_primary DESC, id', (cid,)).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/companies/<int:cid>/contacts', methods=['POST'])
def create_contact(cid):
    data = request.json or {}
    db = get_db()
    comp = db.execute('SELECT * FROM companies WHERE id=?', (cid,)).fetchone()
    if not comp:
        return jsonify({'error': 'Empresa não encontrada'}), 404
    email = data.get('email', '')
    # Blacklist check
    if email:
        bl = db.execute('SELECT id FROM contacts WHERE opted_out=1 AND email=?', (email,)).fetchone()
        if bl:
            return jsonify({'error': 'Contato está na blacklist (opt-out LGPD)'}), 403
    # Dedup
    dup = db.execute(
        'SELECT id FROM contacts WHERE company_id=? AND (name=? OR (email!=? AND email=?))',
        (cid, data.get('name',''), '', email)
    ).fetchone()
    if dup:
        return jsonify({'error': 'Contato duplicado', 'existing_id': dup['id']}), 409
    is_first = db.execute('SELECT COUNT(*) FROM contacts WHERE company_id=?', (cid,)).fetchone()[0] == 0
    cur = db.execute(
        '''INSERT INTO contacts (company_id,name,role,email,linkedin,whatsapp,country,is_primary)
           VALUES (?,?,?,?,?,?,?,?)''',
        (cid, data['name'], data.get('role','other'), email,
         data.get('linkedin',''), data.get('whatsapp',''), data.get('country','BR'),
         1 if is_first else 0)
    )
    db.commit()
    ctid = cur.lastrowid
    db.execute('INSERT INTO consent_logs (lead_id,action,details) VALUES (?,?,?)',
               (ctid, 'added', f'Contato adicionado à empresa {comp["name"]}'))
    db.commit()
    return jsonify({'id': ctid})


@app.route('/api/companies/<int:cid>/contacts/<int:ctid>', methods=['PUT'])
def update_contact(cid, ctid):
    data = request.json or {}
    db = get_db()
    db.execute(
        'UPDATE contacts SET name=?,role=?,email=?,linkedin=?,whatsapp=?,country=? WHERE id=? AND company_id=?',
        (data.get('name',''), data.get('role','other'), data.get('email',''),
         data.get('linkedin',''), data.get('whatsapp',''), data.get('country','BR'), ctid, cid)
    )
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/companies/<int:cid>/contacts/<int:ctid>', methods=['DELETE'])
def delete_contact(cid, ctid):
    db = get_db()
    db.execute('DELETE FROM contacts WHERE id=? AND company_id=?', (ctid, cid))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/companies/<int:cid>/contacts/<int:ctid>/set-primary', methods=['POST'])
def set_primary_contact(cid, ctid):
    db = get_db()
    db.execute('UPDATE contacts SET is_primary=0 WHERE company_id=?', (cid,))
    db.execute('UPDATE contacts SET is_primary=1 WHERE id=? AND company_id=?', (ctid, cid))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/contacts/enrich', methods=['POST'])
def enrich_contact():
    data = request.json or {}
    db = get_db()
    ctid = data.get('contact_id')
    if not ctid:
        return jsonify({'error': 'contact_id obrigatório'}), 400
    ct = db.execute('SELECT ct.*, c.name as company_name FROM contacts ct JOIN companies c ON c.id=ct.company_id WHERE ct.id=?', (ctid,)).fetchone()
    if not ct:
        return jsonify({'error': 'Contato não encontrado'}), 404
    # Enriquecimento simulado via Claude
    prompt = f"""Simule o enriquecimento de dados para: {ct['name']} na empresa {ct['company_name']}.
Retorne JSON: {{"email": "email@provável.com", "linkedin": "https://linkedin.com/in/slug", "phone": "+55119XXXXXXXX"}}
Use formato plausível baseado no nome e empresa. Responda APENAS com JSON válido."""
    result = call_claude('Você é um sistema de enriquecimento de dados B2B.', prompt, max_tokens=150)
    try:
        enriched = json.loads(result)
        if enriched.get('email') and not ct['email']:
            db.execute('UPDATE contacts SET email=? WHERE id=?', (enriched['email'], ctid))
        if enriched.get('phone') and not ct['whatsapp']:
            db.execute('UPDATE contacts SET whatsapp=? WHERE id=?', (enriched['phone'], ctid))
        if enriched.get('linkedin') and not ct['linkedin']:
            db.execute('UPDATE contacts SET linkedin=? WHERE id=?', (enriched['linkedin'], ctid))
        db.commit()
    except Exception:
        enriched = {}
    return jsonify({'ok': True, 'enriched': enriched})


@app.route('/api/contacts/bulk-enrich', methods=['POST'])
def bulk_enrich():
    db = get_db()
    missing = db.execute("SELECT id FROM contacts WHERE email='' OR email IS NULL LIMIT 20").fetchall()
    enriched_count = 0
    for ct in missing:
        try:
            enrich_contact.__wrapped__ if hasattr(enrich_contact, '__wrapped__') else None
            # Enriquece via lógica inline simplificada
            c = db.execute(
                'SELECT ct.*, c.name as company_name FROM contacts ct JOIN companies c ON c.id=ct.company_id WHERE ct.id=?',
                (ct['id'],)
            ).fetchone()
            if not c:
                continue
            prompt = f'Simule email plausível para {c["name"]} na {c["company_name"]}. Retorne apenas: {{"email":"..."}}'
            result = call_claude('Você é sistema de enriquecimento.', prompt, max_tokens=60)
            data = json.loads(result)
            if data.get('email'):
                db.execute('UPDATE contacts SET email=? WHERE id=?', (data['email'], ct['id']))
                enriched_count += 1
        except Exception:
            pass
    db.commit()
    return jsonify({'enriched': enriched_count})


@app.route('/api/contacts/import-and-enrich', methods=['POST'])
def import_and_enrich():
    rows = request.json or []
    db = get_db()
    imported = 0
    for row in rows:
        name = row.get('nome') or row.get('name', '')
        company_name = row.get('empresa') or row.get('company', '')
        if not name or not company_name:
            continue
        # Cria/busca empresa
        comp = db.execute('SELECT id FROM companies WHERE name=?', (company_name,)).fetchone()
        if not comp:
            cur = db.execute('INSERT INTO companies (name) VALUES (?)', (company_name,))
            db.commit()
            comp_id = cur.lastrowid
        else:
            comp_id = comp['id']
        # Cria contato se não existir
        ct = db.execute('SELECT id FROM contacts WHERE company_id=? AND name=?', (comp_id, name)).fetchone()
        if not ct:
            cur = db.execute(
                'INSERT INTO contacts (company_id,name,role,email,whatsapp,country,is_primary) VALUES (?,?,?,?,?,?,1)',
                (comp_id, name, row.get('cargo','other'), row.get('email',''), row.get('whatsapp',''), row.get('country','BR'))
            )
            db.commit()
            imported += 1
    return jsonify({'imported': imported})


# ── Opportunities ─────────────────────────────────────────────────────────────

STAGE_LABELS = {
    'prospecting': 'Prospecção', 'qualified': 'Qualificado',
    'proposal': 'Proposta', 'negotiation': 'Negociação',
    'won': 'Ganho', 'lost': 'Perdido'
}

@app.route('/api/opportunities', methods=['GET'])
def list_opportunities():
    db = get_db()
    rows = db.execute(
        '''SELECT o.*, c.name as company_name, c.sector as company_sector
           FROM opportunities o JOIN companies c ON c.id=o.company_id
           ORDER BY o.created_at DESC'''
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/opportunities', methods=['POST'])
def create_opportunity():
    data = request.json or {}
    db = get_db()
    cur = db.execute(
        'INSERT INTO opportunities (company_id,name,stage,value,notes) VALUES (?,?,?,?,?)',
        (data['company_id'], data['name'], data.get('stage','prospecting'),
         float(data.get('value', 0) or 0), data.get('notes',''))
    )
    db.commit()
    return jsonify({'id': cur.lastrowid})


@app.route('/api/opportunities/<int:oid>', methods=['PUT'])
def update_opportunity(oid):
    data = request.json or {}
    db = get_db()
    db.execute(
        'UPDATE opportunities SET name=?,stage=?,value=?,notes=? WHERE id=?',
        (data.get('name',''), data.get('stage','prospecting'),
         float(data.get('value',0) or 0), data.get('notes',''), oid)
    )
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/opportunities/<int:oid>', methods=['DELETE'])
def delete_opportunity(oid):
    db = get_db()
    db.execute('DELETE FROM opportunities WHERE id=?', (oid,))
    db.commit()
    return jsonify({'ok': True})


# ── Leads ────────────────────────────────────────────────────────────────────

@app.route('/api/leads', methods=['GET'])
def list_leads():
    db = get_db()
    rows = db.execute('SELECT * FROM leads ORDER BY created_at DESC').fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/leads', methods=['POST'])
def create_lead():
    data = request.json
    db = get_db()

    # Dedup check
    dup = db.execute(
        '''SELECT id FROM leads WHERE
           (email != "" AND email = ?)
        OR (linkedin != "" AND linkedin = ?)
        OR (name = ? AND company = ?)''',
        (data.get('email', ''), data.get('linkedin', ''), data['name'], data['company'])
    ).fetchone()
    if dup:
        return jsonify({'error': 'Lead duplicado detectado', 'existing_id': dup['id']}), 409

    # Blacklist check
    bl = db.execute(
        'SELECT id FROM leads WHERE opted_out=1 AND (email=? OR linkedin=?)',
        (data.get('email', ''), data.get('linkedin', ''))
    ).fetchone()
    if bl:
        return jsonify({'error': 'Lead está na blacklist (opt-out LGPD)'}), 403

    cur = db.execute(
        'INSERT INTO leads (name,company,role,email,linkedin,whatsapp,sector,country) VALUES (?,?,?,?,?,?,?,?)',
        (data['name'], data['company'], data.get('role', 'other'),
         data.get('email', ''), data.get('linkedin', ''), data.get('whatsapp', ''),
         data.get('sector', ''), data.get('country', 'BR'))
    )
    db.commit()
    lid = cur.lastrowid
    db.execute('INSERT INTO consent_logs (lead_id,action,details) VALUES (?,?,?)',
               (lid, 'added', 'Lead adicionado ao sistema'))
    db.commit()
    return jsonify({'id': lid})


@app.route('/api/leads/<int:lid>', methods=['GET'])
def get_lead(lid):
    db = get_db()
    lead = db.execute('SELECT * FROM leads WHERE id=?', (lid,)).fetchone()
    if not lead:
        return jsonify({'error': 'Não encontrado'}), 404
    msgs = db.execute('SELECT * FROM messages WHERE lead_id=? ORDER BY day', (lid,)).fetchall()
    sents = db.execute('SELECT * FROM sentiment_logs WHERE lead_id=? ORDER BY created_at DESC LIMIT 5', (lid,)).fetchall()
    logs = db.execute('SELECT * FROM consent_logs WHERE lead_id=? ORDER BY created_at DESC', (lid,)).fetchall()
    slots = db.execute('SELECT * FROM schedule_slots WHERE lead_id=?', (lid,)).fetchall()
    return jsonify({
        'lead': dict(lead),
        'messages': [dict(m) for m in msgs],
        'sentiments': [dict(s) for s in sents],
        'consent_logs': [dict(l) for l in logs],
        'slots': [dict(s) for s in slots],
    })


# ── RAG interno: busca contexto de produto para injetar no prompt ─────────────

def _get_rag_product_context(db, query, max_chars=800):
    """
    Busca documentos carregados no RAG e retorna um bloco de texto relevante
    para enriquecer os prompts de research e geração de sequência.
    Retorna string vazia se não houver documentos.
    """
    docs = db.execute('SELECT name, content FROM documents LIMIT 5').fetchall()
    if not docs:
        return ''

    # Concatena conteúdo dos docs (limitado para não estourar o contexto)
    docs_text = '\n\n---\n\n'.join(
        f'[{d["name"]}]\n{d["content"][:600]}' for d in docs
    )

    summary_prompt = f"""Contexto do produto/serviço sendo vendido (extraído da base de conhecimento):

{docs_text}

Com base nesses documentos, extraia em 3-5 bullet points os diferenciais e benefícios mais relevantes
para um lead do perfil: {query}

Responda de forma direta e objetiva, sem markdown, apenas os bullets."""

    result = call_claude(
        'Você é especialista em síntese de materiais de vendas B2B.',
        summary_prompt,
        max_tokens=300
    )

    if result.startswith('[ERRO'):
        log.warning(f'RAG interno falhou ao buscar contexto: {result}')
        return ''

    return f'\n--- CONTEXTO DO PRODUTO (base de conhecimento) ---\n{result}\n'


# ── Research & Hook ──────────────────────────────────────────────────────────

@app.route('/api/leads/<int:lid>/research', methods=['POST'])
def research_lead(lid):
    db = get_db()
    lead = db.execute('SELECT * FROM leads WHERE id=?', (lid,)).fetchone()
    if not lead:
        return jsonify({'error': 'Não encontrado'}), 404

    role_info = ROLE_PROFILES.get(lead['role'], ROLE_PROFILES['other'])
    product_value = request.json.get('product_value', 'solução de automação de vendas com IA')

    # Golden cases filtrados por setor do lead (fallback para qualquer setor)
    golden = db.execute(
        '''SELECT content FROM golden_cases
           WHERE context LIKE ? OR context = '' OR context IS NULL
           ORDER BY score DESC LIMIT 2''',
        (f'%{lead["sector"]}%',)
    ).fetchall()
    if not golden:
        golden = db.execute('SELECT content FROM golden_cases ORDER BY score DESC LIMIT 2').fetchall()
    golden_ctx = '\n'.join(g['content'] for g in golden) if golden else ''

    # Contexto do produto via RAG (documentos carregados)
    rag_ctx = _get_rag_product_context(
        db, f'{lead["role"]} no setor {lead["sector"] or "empresarial"}'
    )

    prompt = f"""
Lead: {lead['name']} ({lead['role']}) na empresa {lead['company']} (setor: {lead['sector'] or 'não informado'})
Produto sendo vendido: {product_value}
Perfil do cargo: foco em {role_info['focus']}, tom {role_info['tone']}
{rag_ctx}
{'Exemplos de sucesso:\\n' + golden_ctx if golden_ctx else ''}

Gere um JSON com:
- "research_context": 2-3 ganchos plausíveis sobre a empresa (expansões, desafios do setor, tendências)
- "hook": frase de abertura hiperpersonalizada (máx 2 linhas), conectando um gancho ao produto, sem tom genérico
- "pain_points": lista de 3 dores específicas do cargo nesse tipo de empresa
- "value_proposition": proposta de valor adaptada ao perfil

Responda APENAS com JSON válido, sem markdown.
"""
    result = call_claude(
        'Você é um assistente de pesquisa de vendas B2B especializado em prospecção personalizada.',
        prompt, max_tokens=900
    )

    try:
        parsed = json.loads(result)
        hook = parsed.get('hook', result)
        pain_points = parsed.get('pain_points', [])
        ctx = json.dumps(parsed, ensure_ascii=False)
    except Exception:
        hook = result
        pain_points = []
        ctx = result

    db.execute('UPDATE leads SET research_hook=?,research_context=?,status=? WHERE id=?',
               (hook, ctx, 'researched', lid))
    db.commit()
    return jsonify({'hook': hook, 'context': ctx, 'pain_points': pain_points})


# ── Sequence ─────────────────────────────────────────────────────────────────

@app.route('/api/leads/<int:lid>/sequence', methods=['POST'])
def generate_sequence(lid):
    db = get_db()
    lead = db.execute('SELECT * FROM leads WHERE id=?', (lid,)).fetchone()
    if not lead:
        return jsonify({'error': 'Não encontrado'}), 404
    if lead['opted_out']:
        return jsonify({'error': 'Lead está na blacklist'}), 403

    db.execute('DELETE FROM messages WHERE lead_id=?', (lid,))

    role_info = ROLE_PROFILES.get(lead['role'], ROLE_PROFILES['other'])
    hook = lead['research_hook'] or f'Olá {lead["name"]},'
    product_value = request.json.get('product_value', 'solução de automação de vendas com IA')
    selected_pain_point = request.json.get('selected_pain_point', '')  # Dor selecionada pelo usuário

    # Golden cases filtrados por setor (fallback para qualquer setor)
    golden = db.execute(
        '''SELECT title, content FROM golden_cases
           WHERE score>=4 AND (context LIKE ? OR context = '' OR context IS NULL)
           ORDER BY score DESC LIMIT 3''',
        (f'%{lead["sector"]}%',)
    ).fetchall()
    if not golden:
        golden = db.execute('SELECT title, content FROM golden_cases WHERE score>=4 LIMIT 3').fetchall()
    social_proof = '\n'.join(f'- {g["title"]}: {g["content"][:80]}...' for g in golden) if golden else ''

    # Contexto do produto via RAG (busca uma vez, reutiliza em todos os canais)
    rag_ctx = _get_rag_product_context(
        db, f'{lead["role"]} no setor {lead["sector"] or "empresarial"}'
    )

    results = []
    for tpl in SEQUENCE_CHANNELS:
        channel_desc = {
            'linkedin': 'mensagem de conexão no LinkedIn (máx 300 chars, tom informal)',
            'email':    'email de prospecção (inclua assunto na 1ª linha como "Assunto: ...", corpo máx 150 palavras)',
            'whatsapp': 'mensagem WhatsApp (casual, máx 100 palavras)',
        }[tpl['channel']]

        # Contexto de aprendizado: exemplos aprovados + padrões de estilo
        learned = get_learned_context(db, tpl['channel'], lead['role'])

        pain_line = f'Dor principal do lead: {selected_pain_point}' if selected_pain_point else ''
        prompt = f"""
Lead: {lead['name']}, {lead['role']} na {lead['company']} (setor: {lead['sector'] or 'não definido'})
Gancho de pesquisa: {hook}
{pain_line}
Produto: {product_value}
Tom: {role_info['tone']} | Foco: {role_info['focus']}
Canal / Dia {tpl['day']}: {channel_desc}
{rag_ctx}
{'Casos de sucesso:\\n' + social_proof if social_proof else ''}
{learned}
Escreva APENAS o texto da mensagem, sem explicações.
{'IMPORTANTE: A mensagem deve abordar diretamente a dor mencionada acima como ponto de entrada.' if selected_pain_point else ''}
CTA progressivo: convide para uma "conversa de 15 minutos" ou "demo rápida". NÃO tente vender diretamente.
"""
        content = call_claude(
            'Você é copywriter B2B especialista em sequências multicanal de prospecção.',
            prompt, max_tokens=400
        )

        # Injeta footer de compliance conforme país do lead
        compliance = get_compliance_footer(lead['country'] if 'country' in lead.keys() else 'BR')
        content_with_compliance = content + compliance

        cur = db.execute(
            'INSERT INTO messages (lead_id,channel,day,msg_type,content,ai_original,status) VALUES (?,?,?,?,?,?,?)',
            (lid, tpl['channel'], tpl['day'], tpl['type'], content_with_compliance, content_with_compliance, 'pending')
        )
        db.commit()
        results.append({'id': cur.lastrowid, 'channel': tpl['channel'],
                        'day': tpl['day'], 'content': content_with_compliance, 'status': 'pending', 'approved': 0})

    db.execute("UPDATE leads SET status='sequence_created' WHERE id=?", (lid,))
    db.commit()
    return jsonify({'sequence': results})


# ── Message actions ───────────────────────────────────────────────────────────

@app.route('/api/messages/<int:mid>/approve', methods=['POST'])
def approve_msg(mid):
    db = get_db()
    db.execute("UPDATE messages SET approved=1,status='approved' WHERE id=?", (mid,))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/messages/<int:mid>/score', methods=['POST'])
def score_msg(mid):
    score = request.json.get('score')
    if not score or not (1 <= int(score) <= 5):
        return jsonify({'error': 'Score 1–5'}), 400
    score = int(score)
    db = get_db()
    # Score >= 4 sem correção humana → marca como aprovado automaticamente
    # (vira exemplo para geração futura via get_learned_context)
    if score >= 4:
        db.execute(
            'UPDATE messages SET score=?, approved=1 WHERE id=?',
            (score, mid)
        )
    else:
        db.execute('UPDATE messages SET score=? WHERE id=?', (score, mid))
    db.commit()
    return jsonify({'ok': True, 'auto_approved': score >= 4})


def _maybe_trigger_learn_analyze(app_ctx):
    """
    Verifica se há correções suficientes acumuladas (>= 5 novas desde o último
    learn_analyze) e, em caso positivo, dispara a análise em background.
    Executado em thread daemon para não bloquear a requisição.
    """
    THRESHOLD = 5  # dispara a cada N correções novas
    try:
        with app_ctx:
            db = sqlite3.connect(DATABASE)
            db.row_factory = sqlite3.Row
            count = db.execute(
                '''SELECT COUNT(*) as cnt FROM messages
                   WHERE human_correction IS NOT NULL AND human_correction != ""'''
            ).fetchone()['cnt']
            db.close()

            if count > 0 and count % THRESHOLD == 0:
                log.info(f'Auto-RLHF: {count} correções → disparando learn_analyze em background')
                # Chama via contexto de request simulado para reutilizar lógica existente
                with app.test_request_context('/api/learn/analyze', method='POST', json={}):
                    with app.app_context():
                        result = learn_analyze()
                        data = result.get_json()
                        log.info(f'Auto-RLHF concluído: {data}')
    except Exception as e:
        log.error(f'Auto-RLHF falhou: {e}')


@app.route('/api/messages/<int:mid>/correct', methods=['POST'])
def correct_msg(mid):
    correction = request.json.get('correction', '')
    db = get_db()
    msg = db.execute('SELECT * FROM messages WHERE id=?', (mid,)).fetchone()
    if not msg:
        return jsonify({'error': 'Não encontrada'}), 404
    db.execute('UPDATE messages SET human_correction=?,content=? WHERE id=?', (correction, correction, mid))
    db.commit()

    # Dispara análise RLHF em background se atingir o limiar de correções
    try:
        ctx = app.app_context()
        t = threading.Thread(target=_maybe_trigger_learn_analyze, args=(ctx,), daemon=True)
        t.start()
    except Exception as e:
        log.warning(f'Não foi possível disparar auto-RLHF: {e}')

    return jsonify({'ok': True, 'original': msg['ai_original'], 'correction': correction})


# ── Aprendizado: análise de padrões e estatísticas ───────────────────────────

@app.route('/api/learn/analyze', methods=['POST'])
def learn_analyze():
    """
    Analisa as correções humanas acumuladas por canal+perfil e extrai padrões
    de estilo usando Claude. Os padrões ficam salvos em learned_patterns e são
    injetados nos próximos prompts de geração.

    Parâmetros opcionais no body JSON:
      channel: filtrar por canal específico (ex: "email")
      role:    filtrar por perfil específico  (ex: "c_level")
    """
    db = get_db()
    data = request.json or {}
    channel_filter = data.get('channel')
    role_filter = data.get('role')

    # Busca pares original→correção com pelo menos 20 chars de diferença
    query = '''
        SELECT m.channel, l.role, m.ai_original, m.human_correction
        FROM messages m
        JOIN leads l ON l.id = m.lead_id
        WHERE m.human_correction IS NOT NULL
          AND m.human_correction != ''
          AND m.ai_original IS NOT NULL
          AND ABS(LENGTH(m.human_correction) - LENGTH(m.ai_original)) > 10
    '''
    params = []
    if channel_filter:
        query += ' AND m.channel = ?'
        params.append(channel_filter)
    if role_filter:
        query += ' AND l.role = ?'
        params.append(role_filter)
    query += ' ORDER BY m.id DESC LIMIT 30'

    corrections = db.execute(query, params).fetchall()

    if not corrections:
        return jsonify({'ok': False, 'message': 'Sem correções suficientes para analisar ainda.'})

    # Agrupa por canal+perfil
    groups = {}
    for c in corrections:
        key = (c['channel'], c['role'])
        if key not in groups:
            groups[key] = []
        groups[key].append({'original': c['ai_original'], 'corrigido': c['human_correction']})

    results = []
    for (channel, role), pairs in groups.items():
        if len(pairs) < 2:  # mínimo 2 exemplos para extrair padrão
            continue

        pairs_text = '\n\n'.join(
            f'ORIGINAL: {p["original"][:300]}\nCORRIGIDO: {p["corrigido"][:300]}'
            for p in pairs[:8]
        )

        analysis_prompt = f"""Analise estas correções feitas por humanos em mensagens de vendas B2B.
Canal: {channel} | Perfil do lead: {role}

{pairs_text}

Extraia de 2 a 4 REGRAS DE ESTILO concretas que o humano parece preferir.
Seja específico e acionável (ex: "Evite abrir com o nome do lead", "Use perguntas ao invés de afirmações").
Responda em JSON: {{"rules": ["regra 1", "regra 2", ...]}}"""

        raw = call_claude(
            'Você é especialista em análise de copywriting B2B.',
            analysis_prompt,
            max_tokens=400
        )

        try:
            parsed = json.loads(raw)
            rules = parsed.get('rules', [])
        except Exception:
            # Fallback: tenta extrair JSON do texto
            import re
            m = re.search(r'\[.*?\]', raw, re.DOTALL)
            rules = json.loads(m.group()) if m else []

        for rule in rules:
            if not rule.strip():
                continue
            existing = db.execute(
                'SELECT id, sample_size FROM learned_patterns WHERE channel=? AND role=? AND pattern=?',
                (channel, role, rule)
            ).fetchone()
            if existing:
                db.execute(
                    'UPDATE learned_patterns SET sample_size=sample_size+?, confidence=MIN(1.0, confidence+0.1), updated_at=datetime("now") WHERE id=?',
                    (len(pairs), existing['id'])
                )
            else:
                db.execute(
                    'INSERT INTO learned_patterns (channel, role, pattern, confidence, sample_size) VALUES (?,?,?,?,?)',
                    (channel, role, rule, 0.5 + min(0.4, len(pairs) * 0.05), len(pairs))
                )
        db.commit()
        results.append({'channel': channel, 'role': role, 'rules_extracted': len(rules)})

    return jsonify({'ok': True, 'analyzed': results})


@app.route('/api/learn/stats', methods=['GET'])
def learn_stats():
    """Estatísticas do aprendizado acumulado."""
    db = get_db()

    approved_examples = db.execute(
        '''SELECT m.channel, l.role, COUNT(*) as total
           FROM messages m JOIN leads l ON l.id = m.lead_id
           WHERE m.approved=1 AND m.score >= 4
           GROUP BY m.channel, l.role'''
    ).fetchall()

    corrections_pending = db.execute(
        '''SELECT COUNT(*) FROM messages
           WHERE human_correction IS NOT NULL
             AND human_correction != ''
             AND ABS(LENGTH(human_correction) - LENGTH(ai_original)) > 10'''
    ).fetchone()[0]

    patterns = db.execute(
        'SELECT channel, role, pattern, confidence, sample_size FROM learned_patterns ORDER BY confidence DESC'
    ).fetchall()

    avg_score = db.execute(
        'SELECT ROUND(AVG(score),2) FROM messages WHERE score IS NOT NULL'
    ).fetchone()[0]

    return jsonify({
        'avg_score':           avg_score,
        'corrections_pending_analysis': corrections_pending,
        'approved_examples':   [dict(r) for r in approved_examples],
        'learned_patterns':    [dict(r) for r in patterns],
        'ready_to_analyze':    corrections_pending >= 2,
    })


@app.route('/api/messages/<int:mid>/send', methods=['POST'])
def send_msg(mid):
    db = get_db()
    msg = db.execute('SELECT m.*, l.sector, l.role FROM messages m JOIN leads l ON l.id=m.lead_id WHERE m.id=?', (mid,)).fetchone()
    if not msg:
        return jsonify({'error': 'Não encontrada'}), 404
    db.execute("UPDATE messages SET status='sent' WHERE id=?", (mid,))
    db.execute("UPDATE leads SET status='contacted' WHERE id=? AND status NOT IN ('hot_lead','meeting_set')", (msg['lead_id'],))
    # Loga interação e timing analytics
    now = datetime.now()
    db.execute(
        'INSERT INTO lead_interactions (lead_id,channel,interaction_type,notes) VALUES (?,?,?,?)',
        (msg['lead_id'], msg['channel'], 'sent', f'Mensagem dia {msg["day"]} enviada')
    )
    db.execute(
        'INSERT INTO timing_analytics (lead_id,channel,sector,role,day_of_week,hour_of_day) VALUES (?,?,?,?,?,?)',
        (msg['lead_id'], msg['channel'], msg['sector'], msg['role'], now.weekday(), now.hour)
    )
    db.commit()
    delays = {'linkedin': '2–4 min', 'email': '0–30 seg', 'whatsapp': '1–3 min'}
    return jsonify({'ok': True, 'simulated_delay': delays.get(msg['channel'], '1–2 min'),
                    'note': 'Delay simulado — integração real com LinkedIn/WhatsApp/Email requer APIs externas'})


# ── Prospect response → sentiment + pause sequence ───────────────────────────

@app.route('/api/leads/<int:lid>/response', methods=['POST'])
def record_response(lid):
    text = request.json.get('response_text', '')
    db = get_db()

    db.execute("UPDATE messages SET status='paused' WHERE lead_id=? AND status='pending'", (lid,))

    prompt = f"""
Mensagem recebida do prospect: "{text}"

Classifique em uma categoria e responda APENAS em JSON válido:
{{"sentiment": "interested"|"technical_question"|"negative"|"out_of_scope",
  "reasoning": "explicação em 1 frase",
  "interest_score": 1-10}}
"""
    result = call_claude('Você é classificador de intenção em vendas B2B.', prompt, max_tokens=200)

    try:
        parsed = json.loads(result)
        sentiment = parsed.get('sentiment', 'out_of_scope')
        reasoning = parsed.get('reasoning', '')
        iscore = int(parsed.get('interest_score', 5))
    except Exception:
        sentiment, reasoning, iscore = 'out_of_scope', result, 5

    db.execute('INSERT INTO sentiment_logs (lead_id,response_text,sentiment,reasoning,interest_score) VALUES (?,?,?,?,?)',
               (lid, text, sentiment, reasoning, iscore))

    status_map = {'interested': 'hot_lead', 'technical_question': 'needs_followup',
                  'negative': 'rejected', 'out_of_scope': 'contacted'}
    db.execute('UPDATE leads SET status=?,interest_score=? WHERE id=?',
               (status_map.get(sentiment, 'contacted'), iscore, lid))

    # Loga interação e marca timing como respondido
    db.execute(
        'INSERT INTO lead_interactions (lead_id,interaction_type,notes) VALUES (?,?,?)',
        (lid, 'response', f'Sentimento: {sentiment} (score {iscore})')
    )
    db.execute(
        '''UPDATE timing_analytics SET got_response=1
           WHERE id=(SELECT id FROM timing_analytics WHERE lead_id=? ORDER BY id DESC LIMIT 1)''',
        (lid,)
    )
    db.commit()

    return jsonify({
        'sentiment': sentiment, 'reasoning': reasoning, 'interest_score': iscore,
        'handon_required': (sentiment == 'interested' and iscore >= 7),
        'sequence_paused': True,
    })


# ── RAG ──────────────────────────────────────────────────────────────────────

@app.route('/api/documents', methods=['GET'])
def list_docs():
    db = get_db()
    rows = db.execute('SELECT id,name,created_at,length(content) as size FROM documents ORDER BY created_at DESC').fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/documents', methods=['POST'])
def add_doc():
    data = request.json
    db = get_db()
    cur = db.execute('INSERT INTO documents (name,content) VALUES (?,?)', (data['name'], data['content']))
    db.commit()
    return jsonify({'id': cur.lastrowid})


@app.route('/api/documents/<int:did>', methods=['DELETE'])
def del_doc(did):
    db = get_db()
    db.execute('DELETE FROM documents WHERE id=?', (did,))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/rag/query', methods=['POST'])
def rag_query():
    data = request.json
    query = data.get('query', '')
    storytelling = data.get('storytelling', False)
    db = get_db()
    docs = db.execute('SELECT name,content FROM documents').fetchall()

    if not docs:
        return jsonify({'answer': 'Nenhum documento carregado. Adicione documentos técnicos primeiro.'})

    docs_text = '\n\n---\n\n'.join(f'[{d["name"]}]\n{d["content"][:2000]}' for d in docs)

    if storytelling:
        system = 'Você converte dados técnicos em benefícios de negócio (ROI, economia, produtividade). Use números e estimativas concretas.'
        prompt = f'Documentos:\n{docs_text}\n\nTema: {query}\n\nConverta em benefícios de negócio concretos.'
    else:
        system = 'Você é especialista técnico. Responda com precisão baseando-se APENAS nos documentos fornecidos.'
        prompt = f'Documentos:\n{docs_text}\n\nPergunta: {query}'

    answer = call_claude(system, prompt, max_tokens=600)
    return jsonify({'answer': answer, 'docs_used': [d['name'] for d in docs]})


# ── Golden Cases ─────────────────────────────────────────────────────────────

@app.route('/api/golden-cases', methods=['GET'])
def list_golden():
    db = get_db()
    rows = db.execute('SELECT * FROM golden_cases ORDER BY score DESC, created_at DESC').fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/golden-cases', methods=['POST'])
def add_golden():
    data = request.json
    db = get_db()
    cur = db.execute('INSERT INTO golden_cases (title,context,content,score) VALUES (?,?,?,?)',
                     (data['title'], data.get('context', ''), data['content'], data.get('score', 5)))
    db.commit()
    return jsonify({'id': cur.lastrowid})


@app.route('/api/golden-cases/<int:cid>', methods=['DELETE'])
def del_golden(cid):
    db = get_db()
    db.execute('DELETE FROM golden_cases WHERE id=?', (cid,))
    db.commit()
    return jsonify({'ok': True})


# ── Schedule ─────────────────────────────────────────────────────────────────

@app.route('/api/schedule/slots', methods=['GET'])
def list_slots():
    db = get_db()
    rows = db.execute('''
        SELECT s.*, l.name as lead_name, l.company as lead_company
        FROM schedule_slots s LEFT JOIN leads l ON s.lead_id=l.id
        ORDER BY s.date_time
    ''').fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/schedule/slots', methods=['POST'])
def add_slot():
    data = request.json
    db = get_db()
    cur = db.execute('INSERT INTO schedule_slots (date_time,duration_min,meeting_link) VALUES (?,?,?)',
                     (data['date_time'], data.get('duration_min', 15), data.get('meeting_link', '')))
    db.commit()
    return jsonify({'id': cur.lastrowid})


@app.route('/api/schedule/slots/<int:sid>/book', methods=['POST'])
def book_slot(sid):
    data = request.json
    lead_id = data.get('lead_id')
    db = get_db()
    slot = db.execute('SELECT * FROM schedule_slots WHERE id=?', (sid,)).fetchone()
    if not slot:
        return jsonify({'error': 'Slot não encontrado'}), 404
    if slot['booked']:
        return jsonify({'error': 'Slot já reservado'}), 409
    db.execute('UPDATE schedule_slots SET booked=1,lead_id=? WHERE id=?', (lead_id, sid))
    if lead_id:
        db.execute("UPDATE leads SET status='meeting_set' WHERE id=?", (lead_id,))
        db.execute('INSERT INTO consent_logs (lead_id,action,details) VALUES (?,?,?)',
                   (lead_id, 'meeting_booked', f'Reunião: {slot["date_time"]}'))
    db.commit()
    return jsonify({'ok': True, 'date_time': slot['date_time'], 'meeting_link': slot['meeting_link']})


@app.route('/api/schedule/slots/<int:sid>', methods=['DELETE'])
def del_slot(sid):
    db = get_db()
    db.execute('DELETE FROM schedule_slots WHERE id=?', (sid,))
    db.commit()
    return jsonify({'ok': True})


# ── LGPD / Opt-out ───────────────────────────────────────────────────────────

@app.route('/api/leads/<int:lid>/optout', methods=['POST'])
def optout(lid):
    db = get_db()
    db.execute("UPDATE leads SET opted_out=1,status='opted_out' WHERE id=?", (lid,))
    db.execute("UPDATE messages SET status='cancelled' WHERE lead_id=? AND status IN ('pending','approved')", (lid,))
    db.execute('INSERT INTO consent_logs (lead_id,action,details) VALUES (?,?,?)',
               (lid, 'opted_out', 'Opt-out solicitado — removido de todas as cadências (LGPD)'))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/consent-logs', methods=['GET'])
def consent_logs():
    db = get_db()
    rows = db.execute('''
        SELECT cl.*, l.name, l.company
        FROM consent_logs cl LEFT JOIN leads l ON cl.lead_id=l.id
        ORDER BY cl.created_at DESC LIMIT 200
    ''').fetchall()
    return jsonify([dict(r) for r in rows])


# ── RLHF queue ───────────────────────────────────────────────────────────────

@app.route('/api/rlhf/queue', methods=['GET'])
def rlhf_queue():
    db = get_db()
    rows = db.execute('''
        SELECT m.*, l.name as lead_name, l.company as lead_company, l.role as lead_role
        FROM messages m JOIN leads l ON m.lead_id=l.id
        WHERE m.approved=0 AND m.status='pending'
        ORDER BY m.id DESC
    ''').fetchall()
    return jsonify([dict(r) for r in rows])


# ── A/B Variants ─────────────────────────────────────────────────────────────

@app.route('/api/leads/<int:lid>/variants', methods=['GET'])
def list_variants(lid):
    db = get_db()
    rows = db.execute(
        '''SELECT v.*, m.content as variant_a_content
           FROM ab_variants v LEFT JOIN messages m ON m.id=v.msg_id_a
           WHERE v.lead_id=? ORDER BY v.created_at DESC''',
        (lid,)
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/leads/<int:lid>/variants/generate', methods=['POST'])
def generate_ab_variants(lid):
    db = get_db()
    lead = db.execute('SELECT * FROM leads WHERE id=?', (lid,)).fetchone()
    if not lead:
        return jsonify({'error': 'Não encontrado'}), 404

    messages = db.execute(
        "SELECT * FROM messages WHERE lead_id=? AND status IN ('pending','approved') ORDER BY day",
        (lid,)
    ).fetchall()
    if not messages:
        return jsonify({'error': 'Gere a sequência principal primeiro'}), 400

    role_info = ROLE_PROFILES.get(lead['role'], ROLE_PROFILES['other'])
    hook = lead['research_hook'] or f'Olá {lead["name"]},'
    results = []

    for msg in messages:
        channel_desc = {
            'linkedin': 'mensagem de conexão no LinkedIn (máx 300 chars, tom informal)',
            'email':    'email de prospecção (inclua assunto na 1ª linha como "Assunto: ...", corpo máx 150 palavras)',
            'whatsapp': 'mensagem WhatsApp (casual, máx 100 palavras)',
        }.get(msg['channel'], 'mensagem de prospecção')

        prompt = f"""
Lead: {lead['name']}, {lead['role']} na {lead['company']} (setor: {lead['sector'] or 'não definido'})
Gancho: {hook}
Canal / Dia {msg['day']}: {channel_desc}
Tom: {role_info['tone']} | Foco: {role_info['focus']}

A mensagem original (Variante A) já foi gerada. Crie uma VARIANTE B completamente diferente:
- Use uma abordagem diferente (ex: se A usou dado de mercado, B use pergunta reflexiva)
- Mesmo objetivo, estilo totalmente distinto
- Não mencione "variante" no texto

Escreva APENAS o texto da mensagem variante B, sem explicações.
"""
        variant_b = call_claude(
            'Você é copywriter B2B especialista em testes A/B de mensagens de prospecção.',
            prompt, max_tokens=400
        )

        compliance = get_compliance_footer(lead['country'] if 'country' in lead.keys() else 'BR')
        variant_b_full = variant_b + compliance

        # Remove variante anterior do mesmo canal se existir
        db.execute('DELETE FROM ab_variants WHERE lead_id=? AND channel=?', (lid, msg['channel']))
        cur = db.execute(
            'INSERT INTO ab_variants (lead_id,channel,msg_id_a,variant_b) VALUES (?,?,?,?)',
            (lid, msg['channel'], msg['id'], variant_b_full)
        )
        db.commit()
        results.append({
            'id': cur.lastrowid,
            'channel': msg['channel'],
            'msg_id_a': msg['id'],
            'variant_a': msg['content'],
            'variant_b': variant_b_full,
        })

    return jsonify({'variants': results})


@app.route('/api/ab-variants/<int:vid>/winner', methods=['POST'])
def set_ab_winner(vid):
    winner = request.json.get('winner')
    if winner not in ('a', 'b'):
        return jsonify({'error': 'winner deve ser "a" ou "b"'}), 400
    db = get_db()
    variant = db.execute('SELECT * FROM ab_variants WHERE id=?', (vid,)).fetchone()
    if not variant:
        return jsonify({'error': 'Não encontrado'}), 404
    db.execute('UPDATE ab_variants SET winner=? WHERE id=?', (winner, vid))
    # Se B ganhou, atualiza o conteúdo da mensagem original com o texto de B
    if winner == 'b' and variant['msg_id_a']:
        db.execute(
            "UPDATE messages SET content=?, approved=1, status='approved' WHERE id=?",
            (variant['variant_b'], variant['msg_id_a'])
        )
        db.execute(
            'INSERT INTO lead_interactions (lead_id,channel,interaction_type,notes) VALUES (?,?,?,?)',
            (variant['lead_id'], variant['channel'], 'ab_winner', 'Variante B selecionada como vencedora')
        )
    db.commit()
    return jsonify({'ok': True, 'winner': winner})


# ── Lead Interactions (histórico) ────────────────────────────────────────────

@app.route('/api/leads/<int:lid>/interactions', methods=['GET'])
def list_interactions(lid):
    db = get_db()
    rows = db.execute(
        'SELECT * FROM lead_interactions WHERE lead_id=? ORDER BY created_at DESC',
        (lid,)
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/leads/<int:lid>/interactions', methods=['POST'])
def add_interaction(lid):
    data = request.json or {}
    db = get_db()
    cur = db.execute(
        'INSERT INTO lead_interactions (lead_id,channel,interaction_type,notes) VALUES (?,?,?,?)',
        (lid, data.get('channel', ''), data.get('interaction_type', 'note'), data.get('notes', ''))
    )
    db.commit()
    return jsonify({'id': cur.lastrowid})


# ── Follow-up automático ──────────────────────────────────────────────────────

@app.route('/api/followup/pending', methods=['GET'])
def followup_pending():
    days = int(request.args.get('days', 5))
    db = get_db()
    rows = db.execute(
        f'''SELECT l.id, l.name, l.company, l.sector, l.role, l.status,
                   MAX(ta.created_at) as last_sent,
                   CAST(julianday('now') - julianday(MAX(ta.created_at)) AS INTEGER) as days_since
            FROM leads l
            LEFT JOIN timing_analytics ta ON ta.lead_id = l.id
            WHERE l.opted_out = 0
              AND l.status NOT IN ('meeting_set','opted_out','rejected','hot_lead')
            GROUP BY l.id
            HAVING last_sent IS NOT NULL AND days_since >= ?
            ORDER BY days_since DESC''',
        (days,)
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/followup/<int:lid>/generate', methods=['POST'])
def generate_followup(lid):
    db = get_db()
    lead = db.execute('SELECT * FROM leads WHERE id=?', (lid,)).fetchone()
    if not lead:
        return jsonify({'error': 'Não encontrado'}), 404

    # Busca última mensagem enviada
    last_msg = db.execute(
        "SELECT * FROM messages WHERE lead_id=? AND status='sent' ORDER BY day DESC LIMIT 1",
        (lid,)
    ).fetchone()
    last_content = last_msg['content'][:400] if last_msg else 'Mensagem de prospecção anterior'
    channel = request.json.get('channel', last_msg['channel'] if last_msg else 'email')

    role_info = ROLE_PROFILES.get(lead['role'], ROLE_PROFILES['other'])
    channel_desc = {
        'linkedin': 'mensagem de follow-up no LinkedIn (máx 200 chars)',
        'email':    'email de follow-up (assunto na 1ª linha, corpo máx 80 palavras)',
        'whatsapp': 'follow-up WhatsApp (casual, máx 60 palavras)',
    }.get(channel, 'mensagem de follow-up')

    prompt = f"""
Lead: {lead['name']}, {lead['role']} na {lead['company']}
Última mensagem enviada (sem resposta): "{last_content}"
Canal: {channel_desc}
Tom: {role_info['tone']}

Crie um follow-up curto e diferente da mensagem anterior:
- Reconheça que enviou antes, sem ser invasivo
- Ofereça novo ângulo de valor ou pergunta diferente
- Mantenha leve e humano

Escreva APENAS o texto do follow-up, sem explicações.
"""
    content = call_claude(
        'Você é especialista em follow-up B2B não-invasivo.',
        prompt, max_tokens=300
    )

    compliance = get_compliance_footer(lead['country'] if 'country' in lead.keys() else 'BR')
    content_full = content + compliance

    next_day = (last_msg['day'] + 2) if last_msg else 7
    cur = db.execute(
        'INSERT INTO messages (lead_id,channel,day,msg_type,content,ai_original,status) VALUES (?,?,?,?,?,?,?)',
        (lid, channel, next_day, 'follow_up', content_full, content_full, 'pending')
    )
    db.execute(
        'INSERT INTO lead_interactions (lead_id,channel,interaction_type,notes) VALUES (?,?,?,?)',
        (lid, channel, 'followup', f'Follow-up automático gerado para dia {next_day}')
    )
    db.commit()
    return jsonify({'id': cur.lastrowid, 'channel': channel, 'content': content_full})


# ── Métricas ──────────────────────────────────────────────────────────────────

@app.route('/api/metrics/overview', methods=['GET'])
def metrics_overview():
    db = get_db()

    # Taxa de resposta por canal
    by_channel = db.execute(
        '''SELECT channel,
                  COUNT(*) as sent,
                  SUM(got_response) as responded,
                  ROUND(100.0*SUM(got_response)/COUNT(*), 1) as response_rate
           FROM timing_analytics
           GROUP BY channel'''
    ).fetchall()

    # Score médio por setor
    by_sector = db.execute(
        '''SELECT sector, COUNT(*) as total, ROUND(AVG(interest_score),1) as avg_score
           FROM leads
           WHERE sector != '' AND interest_score > 0
           GROUP BY sector ORDER BY avg_score DESC LIMIT 10'''
    ).fetchall()

    # Distribuição por cargo
    by_role = db.execute(
        '''SELECT role, COUNT(*) as total, ROUND(AVG(interest_score),1) as avg_score
           FROM leads GROUP BY role'''
    ).fetchall()

    # Funil de status
    funnel = db.execute(
        '''SELECT status, COUNT(*) as total FROM leads GROUP BY status ORDER BY total DESC'''
    ).fetchall()

    # A/B: % variante B venceu
    ab_stats = db.execute(
        '''SELECT
             COUNT(*) as total,
             SUM(CASE WHEN winner='b' THEN 1 ELSE 0 END) as b_won,
             SUM(CASE WHEN winner IS NOT NULL THEN 1 ELSE 0 END) as decided
           FROM ab_variants'''
    ).fetchone()

    return jsonify({
        'by_channel': [dict(r) for r in by_channel],
        'by_sector':  [dict(r) for r in by_sector],
        'by_role':    [dict(r) for r in by_role],
        'funnel':     [dict(r) for r in funnel],
        'ab_stats':   dict(ab_stats) if ab_stats else {},
    })


@app.route('/api/metrics/timing', methods=['GET'])
def metrics_timing():
    db = get_db()
    rows = db.execute(
        '''SELECT channel, day_of_week, hour_of_day,
                  COUNT(*) as sent,
                  SUM(got_response) as responded,
                  ROUND(100.0*SUM(got_response)/COUNT(*), 1) as response_rate
           FROM timing_analytics
           GROUP BY channel, day_of_week, hour_of_day
           ORDER BY response_rate DESC'''
    ).fetchall()
    return jsonify([dict(r) for r in rows])


# ── CRM Import / Export ───────────────────────────────────────────────────────

CRM_COLUMN_MAP = {
    'hubspot': {
        'name': ['First Name', 'Last Name'],  # concatenar
        'company': ['Company'],
        'email': ['Email'],
        'linkedin': ['LinkedIn Bio URL'],
        'whatsapp': ['Phone Number'],
        'sector': ['Industry'],
        'role_title': ['Job Title'],
    },
    'salesforce': {
        'name': ['FirstName', 'LastName'],
        'company': ['Company'],
        'email': ['Email'],
        'linkedin': ['Website'],
        'whatsapp': ['Phone'],
        'sector': ['Industry'],
        'role_title': ['Title'],
    },
    'linkedin': {
        'name': ['First Name', 'Last Name'],
        'company': ['Company'],
        'email': ['Email Address'],
        'linkedin': ['Profile URL'],
        'whatsapp': [],
        'sector': [],
        'role_title': ['Job Title'],
    },
}

def infer_role(title):
    if not title:
        return 'other'
    t = title.lower()
    if any(w in t for w in ['ceo','cto','cfo','coo','diretor','vp ','vice president','chief','founder','president']):
        return 'c_level'
    if any(w in t for w in ['manager','gerente','head of','coordenador','supervisor','lead ']):
        return 'manager'
    if any(w in t for w in ['engineer','developer','dev ','analista','architect','tech','devops','sre']):
        return 'engineer'
    return 'other'


@app.route('/api/crm/export', methods=['GET'])
def crm_export():
    fmt = request.args.get('format', 'hubspot').lower()
    db = get_db()
    leads = db.execute(
        '''SELECT l.*, COUNT(m.id) as msg_count,
                  SUM(CASE WHEN ta.got_response=1 THEN 1 ELSE 0 END) as responses
           FROM leads l
           LEFT JOIN messages m ON m.lead_id=l.id
           LEFT JOIN timing_analytics ta ON ta.lead_id=l.id
           WHERE l.opted_out=0
           GROUP BY l.id ORDER BY l.created_at DESC'''
    ).fetchall()

    output = io.StringIO()
    writer = csv.writer(output)

    if fmt == 'hubspot':
        writer.writerow(['First Name','Last Name','Company','Email','Phone Number',
                         'LinkedIn Bio URL','Industry','Job Title','Lead Status','Interest Score','Country'])
        for l in leads:
            parts = l['name'].split(' ', 1)
            fn, ln = parts[0], parts[1] if len(parts) > 1 else ''
            writer.writerow([fn, ln, l['company'], l['email'], l['whatsapp'],
                             l['linkedin'], l['sector'], l['role'],
                             l['status'], l['interest_score'], (dict(l).get('country') or 'BR')])
    elif fmt == 'salesforce':
        writer.writerow(['FirstName','LastName','Company','Email','Phone',
                         'Website','Industry','Title','LeadStatus','Rating','Country'])
        for l in leads:
            parts = l['name'].split(' ', 1)
            fn, ln = parts[0], parts[1] if len(parts) > 1 else ''
            rating = 'Hot' if l['interest_score'] >= 7 else ('Warm' if l['interest_score'] >= 4 else 'Cold')
            writer.writerow([fn, ln, l['company'], l['email'], l['whatsapp'],
                             l['linkedin'], l['sector'], l['role'],
                             l['status'], rating, (dict(l).get('country') or 'BR')])
    else:  # linkedin
        writer.writerow(['First Name','Last Name','Company','Email Address',
                         'Profile URL','Job Title','Connected On'])
        for l in leads:
            parts = l['name'].split(' ', 1)
            fn, ln = parts[0], parts[1] if len(parts) > 1 else ''
            writer.writerow([fn, ln, l['company'], l['email'],
                             l['linkedin'], l['role'], l['created_at'][:10]])

    output.seek(0)
    return Response(
        output.getvalue(),
        mimetype='text/csv',
        headers={'Content-Disposition': f'attachment; filename=leads_{fmt}.csv'}
    )


@app.route('/api/crm/import', methods=['POST'])
def crm_import():
    data = request.json or {}
    fmt = data.get('format', 'generic').lower()
    rows = data.get('rows', [])
    if not rows:
        return jsonify({'error': 'Nenhum dado enviado'}), 400

    db = get_db()
    imported, skipped, errors = 0, 0, []

    col_map = CRM_COLUMN_MAP.get(fmt, {})

    for row in rows:
        try:
            # Extrai nome
            name_cols = col_map.get('name', ['name', 'Name'])
            if len(name_cols) == 2 and name_cols[0] in row and name_cols[1] in row:
                name = f"{row.get(name_cols[0],'')} {row.get(name_cols[1],'')}".strip()
            else:
                name = row.get(name_cols[0] if name_cols else 'name', row.get('name', ''))

            company_col = col_map.get('company', ['company'])[0] if col_map.get('company') else 'company'
            company = row.get(company_col, row.get('company', ''))
            if not name or not company:
                skipped += 1
                continue

            email_col = (col_map.get('email') or ['email'])[0]
            linkedin_col = (col_map.get('linkedin') or ['linkedin'])[0]
            phone_cols = col_map.get('whatsapp', [])
            sector_cols = col_map.get('sector', [])
            role_title_cols = col_map.get('role_title', [])

            email = row.get(email_col, row.get('email', ''))
            linkedin = row.get(linkedin_col, row.get('linkedin', ''))
            whatsapp = row.get(phone_cols[0], '') if phone_cols else row.get('whatsapp', '')
            sector = row.get(sector_cols[0], '') if sector_cols else row.get('sector', '')
            role_title = row.get(role_title_cols[0], '') if role_title_cols else ''
            role = infer_role(role_title) if role_title else row.get('role', 'other')
            country = row.get('country', row.get('Country', 'BR'))

            # Dedup check
            dup = db.execute(
                'SELECT id FROM leads WHERE (email != "" AND email=?) OR (name=? AND company=?)',
                (email, name, company)
            ).fetchone()
            if dup:
                skipped += 1
                continue

            # Blacklist
            bl = db.execute('SELECT id FROM leads WHERE opted_out=1 AND email=?', (email,)).fetchone()
            if bl:
                skipped += 1
                continue

            cur = db.execute(
                'INSERT INTO leads (name,company,role,email,linkedin,whatsapp,sector,country) VALUES (?,?,?,?,?,?,?,?)',
                (name, company, role, email, linkedin, whatsapp, sector, country)
            )
            db.execute('INSERT INTO consent_logs (lead_id,action,details) VALUES (?,?,?)',
                       (cur.lastrowid, 'imported', f'Importado via CRM ({fmt})'))
            db.commit()
            imported += 1
        except Exception as e:
            errors.append(str(e))

    return jsonify({'imported': imported, 'skipped': skipped, 'errors': errors[:5]})


# ─────────────────────────────────────────────────────────────────────────────

def seed_db():
    db = sqlite3.connect(DATABASE)
    count = db.execute('SELECT COUNT(*) FROM leads').fetchone()[0]
    if count > 0:
        db.close()
        return
    leads = [
        ('Rodrigo Mendes',      'Nubank',           'c_level', 'Fintech',               'rodrigo.mendes@nubank.com.br',         'linkedin.com/in/rodrigomendes',    '11999990001'),
        ('Ana Paula Ferreira',  'Totvs',            'manager', 'Software B2B',           'anapaula@totvs.com.br',                'linkedin.com/in/anapaulaferreira', '11999990002'),
        ('Carlos Eduardo Lima', 'Ambev',            'c_level', 'Bens de Consumo',        'carlos.lima@ambev.com.br',             'linkedin.com/in/carloslima',       '11999990003'),
        ('Juliana Rocha',       'iFood',            'manager', 'Marketplace / Logistica','juliana.rocha@ifood.com.br',           'linkedin.com/in/juliana-rocha',    '11999990004'),
        ('Thiago Barbosa',      'Embraer',          'engineer','Aeroespacial',           'thiago.barbosa@embraer.com.br',        'linkedin.com/in/thiagobarbosa',    '12999990005'),
        ('Fernanda Castro',     'Magazine Luiza',   'c_level', 'Varejo / E-commerce',    'fernanda.castro@magazineluiza.com.br', 'linkedin.com/in/fernandacastro',   '11999990006'),
        ('Rafael Souza',        'Stone',            'engineer','Fintech / Pagamentos',   'rafael.souza@stone.com.br',            'linkedin.com/in/rafaelsouza',      '11999990007'),
        ('Mariana Oliveira',    'Localiza',         'manager', 'Mobilidade / Locacao',   'mariana.oliveira@localiza.com.br',     'linkedin.com/in/marianaoliveira', '31999990008'),
        ('Bruno Alves',         'Bradesco',         'c_level', 'Banco / Financeiro',     'bruno.alves@bradesco.com.br',          'linkedin.com/in/brunoalves',       '11999990009'),
        ('Patricia Nunes',      'Raizen',           'engineer','Energia / Agronegocio',  'patricia.nunes@raizen.com.br',         'linkedin.com/in/patricianunes',    '11999990010'),
        ('Ricardo Nunes',       'Magazine Luiza',   'c_level', 'Varejo / E-commerce',    'ricardo.nunes@magazineluiza.com.br',   'linkedin.com/in/ricardohnunes',    '11999990011'),
        ('Camila Teixeira',     'Rappi',            'manager', 'Delivery / Marketplace', 'camila.teixeira@rappi.com',            'linkedin.com/in/camilateixeira',   '11999990012'),
        ('Diego Martins',       'Loggi',            'engineer','Logistica / Tech',       'diego.martins@loggi.com',              'linkedin.com/in/diegomartins',     '11999990013'),
        ('Luciana Barros',      'Itau Unibanco',    'c_level', 'Banco / Financeiro',     'luciana.barros@itau-unibanco.com.br',  'linkedin.com/in/lucianabarros',    '11999990014'),
        ('Felipe Cardoso',      'Vtex',             'engineer','E-commerce / SaaS',      'felipe.cardoso@vtex.com',              'linkedin.com/in/felipecardoso',    '11999990015'),
    ]
    db.executemany(
        'INSERT INTO leads (name,company,role,sector,email,linkedin,whatsapp) VALUES (?,?,?,?,?,?,?)',
        leads
    )
    for i, l in enumerate(leads, start=1):
        db.execute('INSERT INTO consent_logs (lead_id,action,details) VALUES (?,?,?)',
                   (i, 'added', 'Lead pré-configurado (seed)'))
    docs = [
        (
            'Manual do Produto — Sales AI Agent v2.1',
            '''VISÃO GERAL
O Sales AI Agent é uma plataforma de prospecção autônoma B2B que combina inteligência artificial generativa com automação multicanal para aumentar a taxa de conversão de leads em reuniões qualificadas.

MÓDULOS PRINCIPAIS
1. Motor de Pesquisa Contextual
   - Análise automática do perfil da empresa-alvo (setor, porte, momento de mercado)
   - Identificação de ganchos de abordagem: expansões recentes, contratações, publicações do executivo
   - Tempo médio de pesquisa: 8 segundos por lead
   - Precisão do gancho validada em 87% dos casos pelos usuários humanos

2. Geração de Mensagens Personalizadas
   - Adaptação automática por cargo: C-Level (foco em ROI), Gerentes (foco em eficiência), Engenheiros (foco técnico)
   - Modelos de linguagem treinados com +10.000 conversas de vendas B2B de alto desempenho
   - Taxa de resposta média: 34% (vs. 8% de templates genéricos)

3. Sequenciamento Multicanal
   - Cadência padrão: LinkedIn (Dia 1) → E-mail (Dia 3) → WhatsApp (Dia 5)
   - Pausa automática em todos os canais ao receber qualquer resposta
   - Integração nativa com LinkedIn Sales Navigator, Gmail e WhatsApp Business API

4. Módulo RAG (Retrieval-Augmented Generation)
   - Suporte a PDF, DOCX e TXT (até 50MB por arquivo)
   - Latência de resposta: < 2 segundos para consultas técnicas
   - Precisão técnica validada: 94% de acurácia em perguntas sobre manuais carregados

5. Painel RLHF (Reinforcement Learning from Human Feedback)
   - Interface de curadoria com aprovação/rejeição de mensagens
   - Sistema de scoring 1-5 estrelas
   - O modelo se adapta ao estilo do usuário após 50 correções

REQUISITOS TÉCNICOS
- API: REST JSON, autenticação via Bearer Token
- Uptime: 99.7% (SLA contratual)
- Ambientes: Cloud (AWS/GCP) ou On-Premise
- Conformidade: LGPD, GDPR, SOC 2 Type II

INTEGRAÇÕES DISPONÍVEIS
- CRM: Salesforce, HubSpot, Pipedrive, RD Station
- Calendário: Google Calendar, Outlook, Calendly
- Comunicação: Slack, Microsoft Teams (alertas de hand-off)
- Enriquecimento: Apollo.io, LinkedIn Sales Navigator, Clearbit'''
        ),
        (
            'White Paper — ROI e Casos de Uso (2025)',
            '''IMPACTO FINANCEIRO — DADOS DE CLIENTES REAIS (2024-2025)

RESUMO EXECUTIVO
Empresas que implementaram o Sales AI Agent reportaram, em média:
- Redução de 73% no tempo de prospecção manual
- Aumento de 4,2x no volume de leads abordados por SDR
- Crescimento de 28% na taxa de conversão lead → reunião
- Redução de 61% no custo por reunião qualificada (CPL)

CASO 1 — FINTECH (500 funcionários)
Contexto: Equipe de 8 SDRs prospecta empresas de médio porte para solução de crédito B2B
Antes: 40 abordagens/SDR/semana, taxa de resposta 9%, custo por reunião R$ 380
Depois: 180 abordagens/SDR/semana, taxa de resposta 31%, custo por reunião R$ 94
ROI em 6 meses: 340%

CASO 2 — SOFTWARE B2B / ERP (200 funcionários)
Contexto: Prospecção de gestores de TI e diretores financeiros em empresas do setor industrial
Desafio: Mensagens genéricas com taxa de abertura de email < 12%
Solução: Mensagens hiperpersonalizadas com gancho contextual por empresa
Resultado: Taxa de abertura subiu para 48%, reuniões agendadas aumentaram 3,1x em 90 dias

CASO 3 — LOGÍSTICA / SaaS (80 funcionários)
Contexto: Startup prospectando gerentes de operações em e-commerces
Antes: 1 reunião qualificada a cada 3 dias por SDR
Depois: 1 reunião qualificada por dia por SDR
Impacto no pipeline: +R$ 2,4M em oportunidades em 4 meses

MÉTRICAS DE REFERÊNCIA DO MERCADO
- SDR humano sem ferramenta: 60-80 abordagens/semana
- SDR com Sales AI Agent: 300-500 abordagens/semana
- Tempo médio para primeira resposta positiva: 4,2 dias (vs. 11,3 dias sem automação)
- Taxa de agendamento de demos: 18% dos interessados (benchmark setor: 11%)

ANÁLISE DE LATÊNCIA E PERFORMANCE TÉCNICA
- Tempo de geração de mensagem personalizada: 3-8 segundos
- Latência de classificação de sentimento: < 1 segundo
- Disponibilidade do sistema: 99.7% nos últimos 12 meses
- Processamento simultâneo: até 10.000 leads em paralelo'''
        ),
        (
            'Especificações Técnicas — API e Integrações',
            '''DOCUMENTAÇÃO TÉCNICA — SALES AI AGENT API v2.1

AUTENTICAÇÃO
Todas as requisições exigem Bearer Token no header:
Authorization: Bearer {seu_token_aqui}
Tokens expiram em 24h. Renovação via /auth/refresh.

ENDPOINTS PRINCIPAIS

POST /api/leads
Cria novo lead com verificação automática de duplicidade e blacklist LGPD.
Body: { name, company, role, email, linkedin, whatsapp, sector }
Response: { id, status: "created" | "duplicate" | "blacklisted" }

POST /api/leads/{id}/research
Executa pesquisa contextual e gera gancho personalizado.
Tempo de processamento: 5-15 segundos
Response: { hook, research_context, pain_points, value_proposition }

POST /api/leads/{id}/sequence
Gera sequência multicanal completa (LinkedIn + Email + WhatsApp).
Parâmetros opcionais: product_value (string), tone_override (formal|casual|technical)
Response: { sequence: [{ channel, day, content, id }] }

POST /api/rag/query
Consulta documentos carregados via RAG.
Body: { query, storytelling: boolean }
storytelling=true converte resposta técnica em benefícios de negócio
Latência: < 2 segundos

POST /api/leads/{id}/response
Registra resposta do prospect, classifica sentimento e pausa sequência.
Sentimentos: interested | technical_question | negative | out_of_scope
Response: { sentiment, reasoning, interest_score (1-10), handon_required: boolean }

WEBHOOKS (disponíveis no plano Professional+)
O sistema dispara webhooks para:
- lead.interested: quando interesse_score >= 7
- meeting.booked: quando reunião é confirmada
- sequence.completed: quando toda cadência é executada sem resposta
- optout.received: quando lead solicita remoção (LGPD)

LIMITES DE RATE
- Free: 100 req/hora
- Professional: 2.000 req/hora
- Enterprise: sem limite (dedicado)

SEGURANÇA E COMPLIANCE
- Todos os dados trafegam via TLS 1.3
- Dados armazenados com AES-256
- Logs de acesso retidos por 90 dias
- Certificação SOC 2 Type II (válida até Dez/2025)
- Conformidade LGPD: opt-out processado em < 24h, dados deletados em 30 dias após solicitação
- GDPR: Data Processing Agreement (DPA) disponível para clientes europeus

SIMULAÇÃO DE COMPORTAMENTO HUMANO
Para proteger contas de LinkedIn e WhatsApp:
- Delays variáveis entre mensagens: 2-8 minutos (LinkedIn), 1-4 minutos (WhatsApp)
- Variação na velocidade de digitação: 40-120 WPM simulados
- Horários de envio restritos: 8h-19h no fuso do destinatário
- Limite diário por conta: 80 conexões LinkedIn, 150 mensagens WhatsApp'''
        ),
    ]
    db.executemany('INSERT INTO documents (name, content) VALUES (?,?)', docs)
    db.commit()
    db.close()


# ── Histórico de pesquisa e sequências por empresa ────────────────────────────

@app.route('/api/companies/<int:cid>/history', methods=['GET'])
def company_history(cid):
    """
    Retorna histórico de pesquisas e sequências anteriores de uma empresa.
    Usado pelo modal para exibir as seções 'Histórico de pesquisas' e 'Sequências anteriores'.
    """
    db = get_db()
    comp = db.execute('SELECT * FROM companies WHERE id=?', (cid,)).fetchone()
    if not comp:
        return jsonify({'error': 'Não encontrada'}), 404

    # Histórico de pesquisa: todos os contatos com research_context preenchido
    contacts_with_research = db.execute(
        '''SELECT c.name, c.research_hook, c.research_context, c.status,
                  i.created_at as researched_at
           FROM contacts c
           LEFT JOIN lead_interactions i ON (
               i.lead_id = (SELECT id FROM leads WHERE name=c.name AND company=? LIMIT 1)
               AND i.interaction_type = 'researched'
           )
           WHERE c.company_id=? AND c.research_hook IS NOT NULL AND c.research_hook != ''
           ORDER BY i.created_at DESC
           LIMIT 5''',
        (comp['name'], cid)
    ).fetchall()

    research_history = []
    for c in contacts_with_research:
        entry = {
            'contact_name': c['name'],
            'hook': c['research_hook'],
            'created_at': c['researched_at'] or '',
        }
        # Extrai pain_points do contexto se disponível
        try:
            ctx = json.loads(c['research_context'] or '{}')
            entry['pain_points'] = ctx.get('pain_points', [])
        except Exception:
            entry['pain_points'] = []
        research_history.append(entry)

    # Histórico de sequências: mensagens agrupadas por data de criação
    leads_of_company = db.execute(
        'SELECT id, name FROM leads WHERE company=?', (comp['name'],)
    ).fetchall()
    lead_ids = [l['id'] for l in leads_of_company]
    lead_name_map = {l['id']: l['name'] for l in leads_of_company}

    sequence_history = []
    if lead_ids:
        placeholders = ','.join('?' * len(lead_ids))
        # Agrupa por data (primeiros 10 chars do rowid proxy = dia)
        msgs = db.execute(
            f'''SELECT lead_id, channel, day, content, status, approved,
                       substr(rowid, 1, 1) as grp
                FROM messages
                WHERE lead_id IN ({placeholders})
                ORDER BY id DESC
                LIMIT 30''',
            lead_ids
        ).fetchall()

        # Agrupa por lead_id (cada lead_id = uma "sequência")
        seq_map = {}
        for m in msgs:
            lid = m['lead_id']
            if lid not in seq_map:
                seq_map[lid] = {
                    'contact_name': lead_name_map.get(lid, '?'),
                    'messages': []
                }
            seq_map[lid]['messages'].append({
                'channel': m['channel'],
                'day': m['day'],
                'content': m['content'],
                'status': m['status'],
                'approved': m['approved'],
            })

        sequence_history = list(seq_map.values())[:5]

    return jsonify({
        'research_history': research_history,
        'sequence_history': sequence_history,
    })


# ── Propensity Scoring (batch) ────────────────────────────────────────────────

@app.route('/api/companies/propensity', methods=['POST'])
def companies_propensity():
    """Pontua um conjunto de empresas pela propensão a comprar um produto específico."""
    db = get_db()
    data = request.json or {}
    company_ids = data.get('company_ids', [])
    product = data.get('product', 'solução de automação de vendas com IA')
    if not company_ids:
        return jsonify({'error': 'Nenhuma empresa selecionada'}), 400

    companies_info = []
    for cid in company_ids:
        comp = db.execute('SELECT * FROM companies WHERE id=?', (cid,)).fetchone()
        if not comp:
            continue
        contact = db.execute(
            'SELECT * FROM contacts WHERE company_id=? ORDER BY is_primary DESC LIMIT 1', (cid,)
        ).fetchone()
        companies_info.append({
            'id': cid,
            'name': comp['name'],
            'sector': comp['sector'] or 'não informado',
            'notes': comp['notes'] or '',
            'contact_role': contact['role'] if contact else 'não informado',
            'contact_name': contact['name'] if contact else '',
        })

    if not companies_info:
        return jsonify({'error': 'Empresas não encontradas'}), 404

    companies_block = '\n'.join(
        f"ID {c['id']}: {c['name']} | Setor: {c['sector']} | Cargo do contato: {c['contact_role']} | Notas: {c['notes'][:100]}"
        for c in companies_info
    )

    prompt = f"""Produto sendo vendido: {product}

Avalie as seguintes empresas pela propensão de compra desse produto. Para cada empresa, considere:
- Alinhamento do setor com o produto
- Cargo do tomador de decisão
- Contexto/notas disponíveis

Empresas:
{companies_block}

Responda APENAS com JSON válido neste formato:
{{
  "rankings": [
    {{
      "company_id": <id>,
      "propensity_score": <1-10>,
      "reason": "<frase curta explicando por que esse lead é propício>",
      "pain_points": ["<dor 1>", "<dor 2>", "<dor 3>"]
    }}
  ]
}}

Ordene do maior para o menor score. Inclua TODAS as {len(companies_info)} empresas. Responda APENAS com JSON.
"""
    result = call_claude(
        'Você é um especialista em qualificação de leads B2B com foco em identificar propensão de compra.',
        prompt, max_tokens=1200
    )

    try:
        parsed = json.loads(result)
        rankings = parsed.get('rankings', [])
    except Exception:
        return jsonify({'error': 'Erro ao processar resposta do LLM', 'raw': result}), 500

    # Enriquecer com nome da empresa
    id_to_info = {c['id']: c for c in companies_info}
    for item in rankings:
        info = id_to_info.get(item.get('company_id'))
        if info:
            item['company_name'] = info['name']
            item['contact_name'] = info['contact_name']
            item['sector'] = info['sector']

    return jsonify({'product': product, 'rankings': rankings})


# ── Bulk Sequence Generation ──────────────────────────────────────────────────

@app.route('/api/companies/bulk-sequence', methods=['POST'])
def companies_bulk_sequence():
    """Gera sequências de mensagens para múltiplas empresas com dores personalizadas."""
    db = get_db()
    data = request.json or {}
    targets = data.get('targets', [])  # [{company_id, selected_pain_point}]
    product_value = data.get('product_value', 'solução de automação de vendas com IA')

    if not targets:
        return jsonify({'error': 'Nenhum target selecionado'}), 400

    results = []
    errors = []

    for target in targets:
        cid = target.get('company_id')
        selected_pain_point = target.get('selected_pain_point', '')

        comp = db.execute('SELECT * FROM companies WHERE id=?', (cid,)).fetchone()
        if not comp:
            errors.append({'company_id': cid, 'error': 'Empresa não encontrada'})
            continue

        contact = db.execute(
            'SELECT * FROM contacts WHERE company_id=? ORDER BY is_primary DESC LIMIT 1', (cid,)
        ).fetchone()
        if not contact:
            errors.append({'company_id': cid, 'company_name': comp['name'], 'error': 'Sem contato cadastrado'})
            continue

        if contact.get('opted_out'):
            errors.append({'company_id': cid, 'company_name': comp['name'], 'error': 'Empresa na blacklist'})
            continue

        # Garante lead mapeado
        lead_row = db.execute('SELECT id FROM leads WHERE name=? AND company=?',
                              (contact['name'], comp['name'])).fetchone()
        if not lead_row:
            cur = db.execute(
                'INSERT INTO leads (name,company,role,email,linkedin,whatsapp,sector,country,research_hook,research_context) VALUES (?,?,?,?,?,?,?,?,?,?)',
                (contact['name'], comp['name'], contact['role'], contact['email'],
                 contact['linkedin'], contact['whatsapp'], comp['sector'], contact['country'],
                 contact.get('research_hook', ''), contact.get('research_context', ''))
            )
            db.commit()
            lid = cur.lastrowid
        else:
            lid = lead_row['id']
            if contact.get('research_hook'):
                db.execute('UPDATE leads SET research_hook=?, research_context=? WHERE id=?',
                           (contact['research_hook'], contact['research_context'], lid))
                db.commit()

        # Gera sequência via lógica existente
        from flask import current_app
        with current_app.test_request_context(
            f'/api/leads/{lid}/sequence',
            method='POST',
            json={'product_value': product_value, 'selected_pain_point': selected_pain_point}
        ):
            seq_result = generate_sequence(lid)
            seq_data = seq_result.get_json()

        db.execute("UPDATE contacts SET status='sequence_created' WHERE id=?", (contact['id'],))
        db.commit()

        results.append({
            'company_id': cid,
            'company_name': comp['name'],
            'contact_name': contact['name'],
            'selected_pain_point': selected_pain_point,
            'sequence': seq_data.get('sequence', []),
        })

    return jsonify({'results': results, 'errors': errors, 'total': len(results)})


init_db()
seed_db()

if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    app.run(debug=False, host='0.0.0.0', port=port)
