'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Detecção de "relacionamento prévio" e de contatos duplicados entre empresas.
//
// Objetivo (spec): marcar se uma empresa já é um contato existente na base ou um
// contato novo, e sinalizar quando um lead COLD é criado para uma empresa já
// contatada — evitando abordagens duplicadas ou desalinhadas.
//
// Todas as funções recebem um handle de banco (node:sqlite DatabaseSync) para
// serem testáveis isoladamente com um banco em memória.
// ─────────────────────────────────────────────────────────────────────────────

// Etiquetas que, quando presentes, indicam relacionamento prévio com a empresa.
// `ja_contato` é a etiqueta dedicada de primeira classe (empresa é um contato
// existente); as outras duas são retrocompatíveis com o catálogo anterior.
const RELATIONSHIP_FLAG_KEYS = new Set(['ja_contato', 'empresa_ja_atendida', 'cliente_ativo']);

const PRIOR_RELATIONSHIP_WARNING =
  'Esta empresa já possui relacionamento prévio (contato existente na base). '
  + 'Considere usar "warm" ou "frozen" em vez de "cold" para evitar abordagem duplicada ou desalinhada.';

function companyFlagKeys(db, companyId) {
  return new Set(db.prepare('SELECT flag FROM company_flags WHERE company_id=?').all(companyId).map((r) => r.flag));
}

// Conta linhas de forma tolerante: se a tabela/coluna não existir (ex.: em um
// banco de teste minimalista), retorna 0 em vez de lançar.
function safeCount(db, sql, param) {
  try { return db.prepare(sql).get(param).c; } catch { return 0; }
}

// Deriva o indicador de relacionamento prévio a partir de VÁRIOS sinais — não só
// da etiqueta manual (que é fácil esquecer):
//   1. etiqueta de relacionamento aplicada;
//   2. já existem contatos qualificados (warm/frozen) na empresa;
//   3. já houve mensagens registradas para a empresa;
//   4. já houve abordagens anteriores (call_events).
function priorRelationshipInfo(db, companyId) {
  const reasons = [];
  const flags = companyFlagKeys(db, companyId);
  if ([...RELATIONSHIP_FLAG_KEYS].some((k) => flags.has(k))) {
    reasons.push('empresa marcada com etiqueta de relacionamento');
  }
  const qualified = safeCount(db, "SELECT COUNT(*) AS c FROM contacts WHERE company_id=? AND call_type IN ('warm','frozen')", companyId);
  if (qualified > 0) reasons.push(`${qualified} contato(s) qualificado(s) (warm/frozen) já cadastrado(s)`);
  const msgs = safeCount(db, 'SELECT COUNT(*) AS c FROM messages WHERE company_id=?', companyId);
  if (msgs > 0) reasons.push(`${msgs} mensagem(ns) já registrada(s)`);
  const calls = safeCount(db, 'SELECT COUNT(*) AS c FROM call_events WHERE company_id=?', companyId);
  if (calls > 0) reasons.push(`${calls} abordagem(ns) anterior(es) registrada(s)`);
  return { has: reasons.length > 0, reasons };
}

function companyHasPriorRelationship(db, companyId) {
  return priorRelationshipInfo(db, companyId).has;
}

// Procura o mesmo contato (por e-mail, whatsapp ou linkedin) em OUTRAS empresas,
// para alertar contra abordagem duplicada da mesma pessoa em cadastros distintos.
function findCrossCompanyDuplicates(db, { email, whatsapp, linkedin, excludeCompanyId }) {
  const out = [];
  const seen = new Set();
  const push = (rows, field) => {
    for (const r of rows) {
      if (String(r.company_id) === String(excludeCompanyId)) continue;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ id: r.id, name: r.name, company_id: r.company_id, company_name: r.company_name, matched_on: field });
    }
  };
  const base = 'SELECT ct.id, ct.name, ct.company_id, co.name AS company_name '
    + 'FROM contacts ct JOIN companies co ON co.id = ct.company_id ';
  const em = (email || '').trim().toLowerCase();
  if (em) push(db.prepare(base + "WHERE ct.email <> '' AND LOWER(ct.email) = ?").all(em), 'e-mail');
  const wa = (whatsapp || '').trim();
  if (wa) push(db.prepare(base + "WHERE ct.whatsapp <> '' AND ct.whatsapp = ?").all(wa), 'whatsapp');
  const li = (linkedin || '').trim().toLowerCase();
  if (li) push(db.prepare(base + "WHERE ct.linkedin <> '' AND LOWER(ct.linkedin) = ?").all(li), 'linkedin');
  return out;
}

// Monta o pacote de avisos para a criação/atualização de um contato: junta o
// alerta de relacionamento prévio (só para cold) e o de duplicidade entre empresas
// em uma única string `warning` (consumida pela UI), além dos dados estruturados.
function contactCreationWarnings(db, companyId, callType, contactData) {
  const parts = [];
  const prior = priorRelationshipInfo(db, companyId);
  const coldOnPrior = callType === 'cold' && prior.has;
  if (coldOnPrior) parts.push(PRIOR_RELATIONSHIP_WARNING);

  const dups = findCrossCompanyDuplicates(db, { ...contactData, excludeCompanyId: companyId });
  if (dups.length) {
    const companies = [...new Set(dups.map((d) => d.company_name).filter(Boolean))];
    const shown = companies.slice(0, 3).join(', ');
    const extra = companies.length > 3 ? ` (+${companies.length - 3})` : '';
    parts.push(`Este contato já existe na base em outra(s) empresa(s): ${shown}${extra}. Verifique para evitar abordagem duplicada.`);
  }

  return {
    warning: parts.length ? parts.join(' ') : null,
    prior_relationship: prior,
    duplicate_contacts: dups,
    suggested_call_type: coldOnPrior ? 'warm' : null,
  };
}

module.exports = {
  RELATIONSHIP_FLAG_KEYS,
  PRIOR_RELATIONSHIP_WARNING,
  companyFlagKeys,
  priorRelationshipInfo,
  companyHasPriorRelationship,
  findCrossCompanyDuplicates,
  contactCreationWarnings,
};
