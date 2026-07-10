'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const rel = require('../lib/relationships');

// Banco em memória com o subconjunto de tabelas que as funções consultam.
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE companies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, name TEXT,
      email TEXT DEFAULT '', whatsapp TEXT DEFAULT '', linkedin TEXT DEFAULT '',
      call_type TEXT DEFAULT 'cold'
    );
    CREATE TABLE company_flags (company_id INTEGER, flag TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER);
    CREATE TABLE call_events (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, call_type TEXT);
  `);
  return db;
}
const newCompany = (db, name) => db.prepare('INSERT INTO companies (name) VALUES (?)').run(name).lastInsertRowid;
const addContact = (db, companyId, c = {}) =>
  db.prepare('INSERT INTO contacts (company_id, name, email, whatsapp, linkedin, call_type) VALUES (?,?,?,?,?,?)')
    .run(companyId, c.name || 'Contato', c.email || '', c.whatsapp || '', c.linkedin || '', c.call_type || 'cold').lastInsertRowid;

test('empresa nova, sem sinais → sem relacionamento prévio', () => {
  const db = makeDb();
  const id = newCompany(db, 'Nova');
  const info = rel.priorRelationshipInfo(db, id);
  assert.strictEqual(info.has, false);
  assert.deepStrictEqual(info.reasons, []);
});

test('etiqueta ja_contato marca relacionamento prévio', () => {
  const db = makeDb();
  const id = newCompany(db, 'Marcada');
  db.prepare('INSERT INTO company_flags (company_id, flag) VALUES (?,?)').run(id, 'ja_contato');
  assert.strictEqual(rel.companyHasPriorRelationship(db, id), true);
});

test('etiquetas legadas (empresa_ja_atendida/cliente_ativo) continuam válidas', () => {
  const db = makeDb();
  for (const flag of ['empresa_ja_atendida', 'cliente_ativo']) {
    const id = newCompany(db, 'C-' + flag);
    db.prepare('INSERT INTO company_flags (company_id, flag) VALUES (?,?)').run(id, flag);
    assert.strictEqual(rel.companyHasPriorRelationship(db, id), true, flag);
  }
});

test('detecção automática: contato warm/frozen, mensagem ou call_event dispara sinal sem etiqueta', () => {
  const db = makeDb();
  const warm = newCompany(db, 'ComWarm');
  addContact(db, warm, { call_type: 'warm' });
  assert.strictEqual(rel.companyHasPriorRelationship(db, warm), true);

  const msg = newCompany(db, 'ComMsg');
  db.prepare('INSERT INTO messages (company_id) VALUES (?)').run(msg);
  assert.strictEqual(rel.companyHasPriorRelationship(db, msg), true);

  const ev = newCompany(db, 'ComEvento');
  db.prepare('INSERT INTO call_events (company_id, call_type) VALUES (?,?)').run(ev, 'cold');
  assert.strictEqual(rel.companyHasPriorRelationship(db, ev), true);

  // contato apenas cold, nada mais → sem sinal
  const cold = newCompany(db, 'SoCold');
  addContact(db, cold, { call_type: 'cold' });
  assert.strictEqual(rel.companyHasPriorRelationship(db, cold), false);
});

test('duplicidade entre empresas por e-mail, whatsapp e linkedin (ignora a própria empresa)', () => {
  const db = makeDb();
  const a = newCompany(db, 'Empresa A');
  const b = newCompany(db, 'Empresa B');
  addContact(db, a, { name: 'João', email: 'joao@x.com', whatsapp: '+5511999', linkedin: 'in/joao' });

  const byEmail = rel.findCrossCompanyDuplicates(db, { email: 'JOAO@X.com', excludeCompanyId: b });
  assert.strictEqual(byEmail.length, 1);
  assert.strictEqual(byEmail[0].company_name, 'Empresa A');
  assert.strictEqual(byEmail[0].matched_on, 'e-mail');

  assert.strictEqual(rel.findCrossCompanyDuplicates(db, { whatsapp: '+5511999', excludeCompanyId: b }).length, 1);
  assert.strictEqual(rel.findCrossCompanyDuplicates(db, { linkedin: 'IN/JOAO', excludeCompanyId: b }).length, 1);

  // Buscando dentro da própria empresa A → não conta como duplicata.
  assert.strictEqual(rel.findCrossCompanyDuplicates(db, { email: 'joao@x.com', excludeCompanyId: a }).length, 0);
});

test('contactCreationWarnings: cold em empresa marcada gera warning + sugere warm', () => {
  const db = makeDb();
  const id = newCompany(db, 'Marcada');
  db.prepare('INSERT INTO company_flags (company_id, flag) VALUES (?,?)').run(id, 'ja_contato');

  const cold = rel.contactCreationWarnings(db, id, 'cold', { email: 'novo@x.com' });
  assert.ok(cold.warning && cold.warning.includes('relacionamento prévio'));
  assert.strictEqual(cold.suggested_call_type, 'warm');

  // warm na mesma empresa → sem warning de relacionamento e sem sugestão.
  const warm = rel.contactCreationWarnings(db, id, 'warm', { email: 'novo@x.com' });
  assert.strictEqual(warm.suggested_call_type, null);
  assert.strictEqual(warm.warning, null);
});

test('contactCreationWarnings: duplicata entre empresas entra no warning', () => {
  const db = makeDb();
  const a = newCompany(db, 'Empresa A');
  const b = newCompany(db, 'Empresa B');
  addContact(db, a, { email: 'dup@x.com' });

  const notice = rel.contactCreationWarnings(db, b, 'warm', { email: 'dup@x.com' });
  assert.ok(notice.warning && notice.warning.includes('Empresa A'));
  assert.strictEqual(notice.duplicate_contacts.length, 1);
});
