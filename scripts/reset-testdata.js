// Uso único (manutenção): limpa a poluição dos testes, MANTENDO empresas, contatos
// (com contexto), golden_cases, documents e usuários.
// Rodar: node --experimental-sqlite scripts/reset-testdata.js
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.DB_PATH || 'prototype.db');
const report = {};
function run(sql, label) {
  try { report[label] = db.prepare(sql).run().changes; }
  catch (e) { report[label] = 'skip: ' + String(e.message || e).slice(0, 50); }
}
// Apaga conversas/artefatos de teste
run("DELETE FROM messages", 'messages');
run("DELETE FROM sentiment_logs", 'sentiment_logs');
run("DELETE FROM notifications", 'notifications');
run("DELETE FROM schedule_slots", 'schedule_slots');
run("DELETE FROM consent_logs", 'consent_logs');
run("DELETE FROM opportunities", 'opportunities');
run("DELETE FROM learned_patterns", 'learned_patterns');
// Reseta o estado das empresas gerado nos testes (mantém as empresas e contatos)
run("UPDATE companies SET status='new', interest_score=0, research_hook='', research_context='', research_history='[]', sequence_history='[]', auto_reply_mode='off'", 'companies_reset');
console.log('LIMPEZA:', JSON.stringify(report));
