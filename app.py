import os
import json
import sqlite3
from flask import Flask, render_template, request, jsonify, g
from dotenv import load_dotenv

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
    ''')
    db.commit()
    db.close()


# ── Claude helper ────────────────────────────────────────────────────────────

def call_claude(system_prompt, user_prompt, max_tokens=800):
    api_key = os.getenv('ANTHROPIC_API_KEY')
    if not api_key:
        return '[ERRO: Configure ANTHROPIC_API_KEY no arquivo .env]'
    try:
        from anthropic import Anthropic
        client = Anthropic(api_key=api_key)
        msg = client.messages.create(
            model='claude-sonnet-4-6',
            max_tokens=max_tokens,
            system=system_prompt,
            messages=[{'role': 'user', 'content': user_prompt}],
        )
        return msg.content[0].text
    except Exception as e:
        return f'[ERRO API: {e}]'


# ── Routes ───────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


# Stats
@app.route('/api/stats')
def stats():
    db = get_db()
    return jsonify({
        'total_leads':       db.execute('SELECT COUNT(*) FROM leads').fetchone()[0],
        'opted_out':         db.execute('SELECT COUNT(*) FROM leads WHERE opted_out=1').fetchone()[0],
        'hot_leads':         db.execute("SELECT COUNT(*) FROM leads WHERE status='hot_lead'").fetchone()[0],
        'meetings':          db.execute("SELECT COUNT(*) FROM leads WHERE status='meeting_set'").fetchone()[0],
        'pending_review':    db.execute("SELECT COUNT(*) FROM messages WHERE approved=0 AND status='pending'").fetchone()[0],
        'docs_count':        db.execute('SELECT COUNT(*) FROM documents').fetchone()[0],
        'golden_cases':      db.execute('SELECT COUNT(*) FROM golden_cases').fetchone()[0],
        'avg_score':         db.execute('SELECT ROUND(AVG(score),1) FROM messages WHERE score IS NOT NULL').fetchone()[0],
    })


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
        'INSERT INTO leads (name,company,role,email,linkedin,whatsapp,sector) VALUES (?,?,?,?,?,?,?)',
        (data['name'], data['company'], data.get('role', 'other'),
         data.get('email', ''), data.get('linkedin', ''), data.get('whatsapp', ''), data.get('sector', ''))
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


# ── Research & Hook ──────────────────────────────────────────────────────────

@app.route('/api/leads/<int:lid>/research', methods=['POST'])
def research_lead(lid):
    db = get_db()
    lead = db.execute('SELECT * FROM leads WHERE id=?', (lid,)).fetchone()
    if not lead:
        return jsonify({'error': 'Não encontrado'}), 404

    role_info = ROLE_PROFILES.get(lead['role'], ROLE_PROFILES['other'])
    product_value = request.json.get('product_value', 'solução de automação de vendas com IA')

    golden = db.execute('SELECT content FROM golden_cases ORDER BY score DESC LIMIT 2').fetchall()
    golden_ctx = '\n'.join(g['content'] for g in golden) if golden else ''

    prompt = f"""
Lead: {lead['name']} ({lead['role']}) na empresa {lead['company']} (setor: {lead['sector'] or 'não informado'})
Produto sendo vendido: {product_value}
Perfil do cargo: foco em {role_info['focus']}, tom {role_info['tone']}
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
        ctx = json.dumps(parsed, ensure_ascii=False)
    except Exception:
        hook = result
        ctx = result

    db.execute('UPDATE leads SET research_hook=?,research_context=?,status=? WHERE id=?',
               (hook, ctx, 'researched', lid))
    db.commit()
    return jsonify({'hook': hook, 'context': ctx})


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

    golden = db.execute('SELECT title, content FROM golden_cases WHERE score>=4 LIMIT 3').fetchall()
    social_proof = '\n'.join(f'- {g["title"]}: {g["content"][:80]}...' for g in golden) if golden else ''

    results = []
    for tpl in SEQUENCE_CHANNELS:
        channel_desc = {
            'linkedin': 'mensagem de conexão no LinkedIn (máx 300 chars, tom informal)',
            'email':    'email de prospecção (inclua assunto na 1ª linha como "Assunto: ...", corpo máx 150 palavras)',
            'whatsapp': 'mensagem WhatsApp (casual, máx 100 palavras)',
        }[tpl['channel']]

        prompt = f"""
Lead: {lead['name']}, {lead['role']} na {lead['company']} (setor: {lead['sector'] or 'não definido'})
Gancho de pesquisa: {hook}
Produto: {product_value}
Tom: {role_info['tone']} | Foco: {role_info['focus']}
Canal / Dia {tpl['day']}: {channel_desc}
{'Casos de sucesso:\\n' + social_proof if social_proof else ''}

Escreva APENAS o texto da mensagem, sem explicações.
CTA progressivo: convide para uma "conversa de 15 minutos" ou "demo rápida". NÃO tente vender diretamente.
"""
        content = call_claude(
            'Você é copywriter B2B especialista em sequências multicanal de prospecção.',
            prompt, max_tokens=400
        )

        cur = db.execute(
            'INSERT INTO messages (lead_id,channel,day,msg_type,content,ai_original,status) VALUES (?,?,?,?,?,?,?)',
            (lid, tpl['channel'], tpl['day'], tpl['type'], content, content, 'pending')
        )
        db.commit()
        results.append({'id': cur.lastrowid, 'channel': tpl['channel'],
                        'day': tpl['day'], 'content': content, 'status': 'pending', 'approved': 0})

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
    db = get_db()
    db.execute('UPDATE messages SET score=? WHERE id=?', (score, mid))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/messages/<int:mid>/correct', methods=['POST'])
def correct_msg(mid):
    correction = request.json.get('correction', '')
    db = get_db()
    msg = db.execute('SELECT * FROM messages WHERE id=?', (mid,)).fetchone()
    if not msg:
        return jsonify({'error': 'Não encontrada'}), 404
    db.execute('UPDATE messages SET human_correction=?,content=? WHERE id=?', (correction, correction, mid))
    db.commit()
    return jsonify({'ok': True, 'original': msg['ai_original'], 'correction': correction})


@app.route('/api/messages/<int:mid>/send', methods=['POST'])
def send_msg(mid):
    db = get_db()
    msg = db.execute('SELECT * FROM messages WHERE id=?', (mid,)).fetchone()
    if not msg:
        return jsonify({'error': 'Não encontrada'}), 404
    db.execute("UPDATE messages SET status='sent' WHERE id=?", (mid,))
    db.execute("UPDATE leads SET status='contacted' WHERE id=? AND status NOT IN ('hot_lead','meeting_set')", (msg['lead_id'],))
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


init_db()
seed_db()

if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    app.run(debug=False, host='0.0.0.0', port=port)
