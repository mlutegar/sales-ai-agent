"""
import_excel.py — Importa as listas Excel do cliente para o banco do CRM.

Uso:
    python import_excel.py

O script:
1. Limpa os dados mock (leads, companies, contacts) preservando documents e users.
2. Importa "Lista de clientes 1.xlsx" — dados completos.
3. Importa "lista de leads com dados faltando.xlsx" — dados incompletos (sem email/telefone).
4. Grava import_source em cada empresa/contato para exibir badge na interface.
"""

import os
import re
import sqlite3

try:
    import openpyxl
except ImportError:
    print("❌  Instale openpyxl: pip install openpyxl")
    raise

# ── Configuração ──────────────────────────────────────────────────────────────

DATABASE = os.path.join(os.path.dirname(__file__), 'prototype.db')

EXCEL_DIR = r'C:\Users\mlute\OneDrive\trabalho\emme\crm_ia'
FILE_COMPLETO  = os.path.join(EXCEL_DIR, 'Lista de clientes 1.xlsx')
FILE_FALTANDO  = os.path.join(EXCEL_DIR, 'lista de leads com dados faltando.xlsx')

# ── Helpers ───────────────────────────────────────────────────────────────────

ROLE_KEYWORDS = {
    'c_level': ['ceo', 'cto', 'cio', 'cfo', 'coo', 'cso', 'cdo', 'diretor', 'director',
                'vp ', 'vice-president', 'vice president', 'chief', 'founder', 'president',
                'presidente', 'superintendente'],
    'manager': ['manager', 'gerente', 'head of', 'head ', 'coordenador', 'coordinator',
                'supervisor', 'lead ', 'lider'],
    'engineer': ['engineer', 'engenheiro', 'developer', 'desenvolvedor', 'analista',
                 'architect', 'arquiteto', 'tech', 'devops', 'sre', 'dev '],
}


def infer_role(title: str) -> str:
    if not title:
        return 'other'
    t = title.lower()
    for role, keywords in ROLE_KEYWORDS.items():
        if any(k in t for k in keywords):
            return role
    return 'other'


def extract_email(raw: str) -> str:
    """Extrai apenas o endereço de e-mail de strings como 'Nome <email>' ou 'email'."""
    if not raw:
        return ''
    raw = str(raw).strip()
    # Formato: Name <email@domain>
    m = re.search(r'<([^>]+)>', raw)
    if m:
        return m.group(1).strip().lower()
    # Já é um email puro
    if '@' in raw:
        return raw.strip().lower()
    return ''


def is_role_keyword(text: str) -> bool:
    """Retorna True se o texto parece um cargo (e não um sobrenome)."""
    if not text:
        return False
    t = text.lower()
    all_keywords = []
    for kws in ROLE_KEYWORDS.values():
        all_keywords.extend(kws)
    # Também títulos como CTO/CIO, Superintendente etc.
    extra = ['cto', 'cio', 'ceo', 'cfo', 'coo', 'superintendente', 'diretor', 'gerente']
    return any(k in t for k in all_keywords + extra)


def clean(val) -> str:
    if val is None:
        return ''
    return str(val).strip()


# ── Limpeza do banco ──────────────────────────────────────────────────────────

def clear_mock_data(db: sqlite3.Connection):
    print("🗑  Limpando dados mock...")
    db.execute("DELETE FROM consent_logs WHERE lead_id IN (SELECT id FROM leads)")
    db.execute("DELETE FROM messages WHERE lead_id IN (SELECT id FROM leads)")
    db.execute("DELETE FROM sentiment_logs WHERE lead_id IN (SELECT id FROM leads)")
    db.execute("DELETE FROM lead_interactions WHERE lead_id IN (SELECT id FROM leads)")
    db.execute("DELETE FROM leads")
    # Limpa companies/contacts (preserva documents, users, opportunities criadas manualmente)
    db.execute("DELETE FROM contacts")
    db.execute("DELETE FROM companies")
    db.commit()
    print("   ✓ Dados mock removidos.")


# ── Importação Excel 1 — Lista completa ───────────────────────────────────────

def import_completo(db: sqlite3.Connection):
    source = 'Lista de clientes 1.xlsx'
    print(f"\n📄  Importando '{source}'...")

    wb = openpyxl.load_workbook(FILE_COMPLETO)
    ws = wb.active
    rows = list(ws.rows)

    # Linha 0 = vazia, linha 1 = cabeçalho, dados a partir da linha 2
    imported = 0
    skipped  = 0

    for row in rows[2:]:
        vals = [cell.value for cell in row]
        # Ignora linhas completamente vazias
        if all(v is None for v in vals):
            continue

        col1 = clean(vals[1])  # Nome ou Primeiro Nome
        col2 = clean(vals[2])  # Cargo ou Sobrenome
        col3 = clean(vals[3])  # Empresa
        col4 = clean(vals[4])  # Email (pode ter "Nome <email>")
        col5 = clean(vals[5])  # Account Executive
        col6 = clean(vals[6])  # Convidado
        col7 = clean(vals[7])  # Confirmado

        if not col3:
            skipped += 1
            continue

        # Resolve nome vs cargo
        if is_role_keyword(col2):
            name  = col1
            cargo = col2
        else:
            # col2 é sobrenome
            name  = f"{col1} {col2}".strip()
            cargo = ''

        if not name:
            skipped += 1
            continue

        email = extract_email(col4)
        role  = infer_role(cargo)

        # Monta notas adicionais
        notes_parts = []
        if col5:
            notes_parts.append(f"AE: {col5}")
        if col6 and col6.lower() not in ('', 'não', 'no'):
            notes_parts.append(f"Convidado: {col6}")
        if col7 and col7.lower() not in ('', 'não', 'no'):
            notes_parts.append(f"Confirmado: {col7}")
        import_notes = ' | '.join(notes_parts) if notes_parts else None

        # Cria ou recupera empresa
        comp = db.execute('SELECT id FROM companies WHERE name=?', (col3,)).fetchone()
        if not comp:
            cur = db.execute(
                'INSERT INTO companies (name, import_source) VALUES (?,?)',
                (col3, source)
            )
            comp_id = cur.lastrowid
        else:
            comp_id = comp[0]

        # Dedup por email ou nome+empresa
        dup = db.execute(
            '''SELECT id FROM contacts WHERE company_id=? AND (
               (email != "" AND email=?) OR name=?
            )''',
            (comp_id, email, name)
        ).fetchone()
        if dup:
            skipped += 1
            continue

        db.execute(
            '''INSERT INTO contacts
               (company_id, name, role, email, country, import_source, import_notes, is_primary)
               VALUES (?,?,?,?,?,?,?,1)''',
            (comp_id, name, role, email, 'BR', source, import_notes)
        )
        imported += 1

    db.commit()
    print(f"   ✓ {imported} contatos importados, {skipped} ignorados.")
    return imported


# ── Importação Excel 2 — Lista com dados faltando ────────────────────────────

def import_faltando(db: sqlite3.Connection):
    source = 'lista de leads com dados faltando.xlsx'
    print(f"\n📄  Importando '{source}'...")

    wb = openpyxl.load_workbook(FILE_FALTANDO)
    ws = wb.active
    rows = list(ws.rows)

    # Linha 0 = cabeçalho (EMPRESA, NOME, Email, celular)
    imported = 0
    skipped  = 0

    for row in rows[1:]:
        vals = [cell.value for cell in row]
        if all(v is None for v in vals):
            continue

        empresa = clean(vals[0])
        nome    = clean(vals[1])
        email   = extract_email(clean(vals[2])) if vals[2] else ''
        celular = clean(vals[3]) if vals[3] else ''

        if not empresa:
            skipped += 1
            continue

        # Empresa pode existir (ex: TIM BRASIL também está na lista completa)
        comp = db.execute('SELECT id, import_source FROM companies WHERE name=?', (empresa,)).fetchone()
        if not comp:
            cur = db.execute(
                'INSERT INTO companies (name, import_source) VALUES (?,?)',
                (empresa, source)
            )
            comp_id = cur.lastrowid
        else:
            comp_id = comp[0]
            # Atualiza source para indicar que está em ambas as listas
            existing_src = comp[1] or ''
            if source not in existing_src:
                new_src = f"{existing_src} + {source}".strip(' + ') if existing_src else source
                db.execute('UPDATE companies SET import_source=? WHERE id=?', (new_src, comp_id))

        # Se não tem nome, insere apenas a empresa (sem contato)
        if not nome:
            skipped += 1
            continue

        # Dedup
        dup = db.execute(
            '''SELECT id FROM contacts WHERE company_id=? AND (
               (email != "" AND email=?) OR name=?
            )''',
            (comp_id, email or '__no_email__', nome)
        ).fetchone()
        if dup:
            skipped += 1
            continue

        # is_primary=1 se for o único/primeiro contato da empresa
        existing_ct = db.execute(
            'SELECT COUNT(*) FROM contacts WHERE company_id=?', (comp_id,)
        ).fetchone()[0]

        db.execute(
            '''INSERT INTO contacts
               (company_id, name, role, email, whatsapp, country, import_source, is_primary)
               VALUES (?,?,?,?,?,?,?,?)''',
            (comp_id, nome, 'other', email, celular, 'BR', source, 1 if existing_ct == 0 else 0)
        )
        imported += 1

    db.commit()
    print(f"   ✓ {imported} contatos importados, {skipped} ignorados.")
    return imported


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("  CRM Import — Listas Excel do Cliente")
    print("=" * 60)

    if not os.path.exists(FILE_COMPLETO):
        print(f"❌  Arquivo não encontrado: {FILE_COMPLETO}")
        return
    if not os.path.exists(FILE_FALTANDO):
        print(f"❌  Arquivo não encontrado: {FILE_FALTANDO}")
        return

    db = sqlite3.connect(DATABASE)
    db.row_factory = sqlite3.Row

    try:
        # Garante que as colunas novas existam (migração segura)
        for sql in [
            "ALTER TABLE companies ADD COLUMN import_source TEXT DEFAULT NULL",
            "ALTER TABLE contacts ADD COLUMN import_source TEXT DEFAULT NULL",
            "ALTER TABLE contacts ADD COLUMN import_notes TEXT DEFAULT NULL",
        ]:
            try:
                db.execute(sql)
                db.commit()
            except Exception:
                pass  # coluna já existe

        clear_mock_data(db)
        n1 = import_completo(db)
        n2 = import_faltando(db)

        # Resumo
        total_comp = db.execute('SELECT COUNT(*) FROM companies').fetchone()[0]
        total_ct   = db.execute('SELECT COUNT(*) FROM contacts').fetchone()[0]
        sem_email  = db.execute(
            "SELECT COUNT(*) FROM contacts WHERE email='' OR email IS NULL"
        ).fetchone()[0]

        print("\n" + "=" * 60)
        print(f"  ✅  Importação concluída!")
        print(f"  📊  {total_comp} empresas  |  {total_ct} contatos")
        print(f"  ⚠️   {sem_email} contatos sem e-mail (badge vermelho na plataforma)")
        print("=" * 60)

    finally:
        db.close()


if __name__ == '__main__':
    main()
