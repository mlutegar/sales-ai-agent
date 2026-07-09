// Uso único (manutenção): preenche o cargo (title) dos contatos que têm cargo real na
// planilha "Lista de clientes 1 (1).xlsx". Só atualiza quem está sem título; não duplica.
// Rodar: node --experimental-sqlite scripts/fill-cargos.js
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.DB_PATH || 'prototype.db');
const ups = [
  ['rodrigo oliveira',  'Cirion Diretor Comercial'],
  ['gustavo salviano',  'CTO/CIO'],
  ['cleyton ferreira',  'CTO'],
  ['christian reis',    'CEO'],
  ['vitor garcia',      'CIO'],
  ['fabio napoli',      'CTO/CIO'],
  ['cintia barcelos',   'CTO/CIO'],
  ['americo coltacci',  'CTO/CIO'],
  ['augusto stracieri', 'Superintendente'],
  ['rafael cavalcanti', 'Superintendente'],
];
const stmt = db.prepare("UPDATE contacts SET title=? WHERE LOWER(TRIM(name))=? AND (title IS NULL OR LENGTH(TRIM(title))=0)");
let n = 0;
for (const [nome, cargo] of ups) n += stmt.run(cargo, nome).changes;
console.log('CARGOS preenchidos:', n);
