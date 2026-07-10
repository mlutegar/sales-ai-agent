'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const h = require('../lib/humanize');

test('findUnresolvedPlaceholders detecta [colchetes], {chaves} e <angulares>', () => {
  assert.deepStrictEqual(h.findUnresolvedPlaceholders('Oi, aqui é [seu nome]'), ['[seu nome]']);
  assert.ok(h.findUnresolvedPlaceholders('manda pro {empresa} no <link>').length === 2);
  assert.deepStrictEqual(h.findUnresolvedPlaceholders('mensagem limpa sem campos'), []);
  // [123] sem letras não é placeholder de nome/campo
  assert.deepStrictEqual(h.findUnresolvedPlaceholders('desconto de [50]% hoje'), []);
});

test('stripPlaceholders remove auto-apresentação com placeholder e limpa pontuação', () => {
  const out = h.stripPlaceholders('Oi, Beltrano! Aqui é [seu nome]... Boa aquela conversa ontem.');
  assert.ok(!/\[/.test(out), 'não deve sobrar colchete');
  assert.ok(!/seu nome/i.test(out), 'não deve sobrar o texto do placeholder');
  assert.ok(out.startsWith('Oi, Beltrano!'), 'mantém o resto da mensagem');
  assert.ok(!/\s{2,}/.test(out), 'não deve haver espaço duplo');
});

test('stripPlaceholders é no-op quando não há placeholder', () => {
  const s = 'oi joao, vale 15 min essa semana?';
  assert.strictEqual(h.stripPlaceholders(s), s);
});

test('stripPlaceholders remove placeholder solto do meio da frase', () => {
  const out = h.stripPlaceholders('manda no {empresa} que eu te retorno');
  assert.ok(!/\{/.test(out));
  assert.ok(!/\s{2,}/.test(out));
});

test('humanizeWhatsapp troca travessão por vírgula', () => {
  const out = h.humanizeWhatsapp('velocidade virou KPI — a TI acompanha?', {});
  assert.ok(!out.includes('—'), 'não deve conter travessão');
  assert.ok(out.includes('KPI, a TI') || out.includes('KPI ,'), 'travessão vira vírgula');
});

test('sanitizeOutbound encadeia humanização + remoção de placeholder', () => {
  const out = h.sanitizeOutbound('Aqui é [seu nome] — bora marcar?', {});
  assert.ok(!out.includes('—'), 'sem travessão');
  assert.ok(!/\[/.test(out), 'sem placeholder');
});

test('productMentioned: detecta termo forte do produto e ignora stopwords', () => {
  assert.strictEqual(h.productMentioned('quero te mostrar os processadores Intel', 'Processadores Intel com IA'), true);
  assert.strictEqual(h.productMentioned('a Bayer roda equipes enxutas em TI', 'Processadores Intel com IA'), false);
  // produto sem termo forte (só stopwords/curto): não força, retorna true
  assert.strictEqual(h.productMentioned('qualquer texto', 'IA'), true);
});
