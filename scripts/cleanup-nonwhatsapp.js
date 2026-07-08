// Uso único (manutenção): remove mensagens antigas de canais que não são WhatsApp
// (linkedin/email) — o produto passou a ser 100% WhatsApp.
// Rodar: node --experimental-sqlite scripts/cleanup-nonwhatsapp.js
const { DatabaseSync } = require('node:sqlite');
const DB_PATH = process.env.DB_PATH || 'prototype.db';
const db = new DatabaseSync(DB_PATH);
const before = db.prepare("SELECT COUNT(*) c FROM messages WHERE channel IN ('linkedin','email')").get();
const r = db.prepare("DELETE FROM messages WHERE channel IN ('linkedin','email')").run();
console.log(`DB=${DB_PATH} | linkedin/email antes=${before.c} | removidas=${r.changes}`);
