'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const h = require('../lib/humanize');

test('botWordScan detecta jargão de marketing e marcas de IA', () => {
  const hits = h.botWordScan('Nossa solução vai otimizar seus resultados — veja:\n1. primeiro');
  assert.ok(hits.includes('solução'));
  assert.ok(hits.includes('otimizar'));
  assert.ok(hits.includes('travessão (—)'));
  assert.ok(hits.includes('lista numerada'));
  assert.deepStrictEqual(h.botWordScan('oi, tudo certo por ai?'), []);
});

test('similarity: idêntico=1, distinto baixo', () => {
  assert.strictEqual(h.similarity('oi joao tudo bem por ai hoje', 'oi joao tudo bem por ai hoje'), 1);
  assert.ok(h.similarity('oi joao tudo bem por ai', 'preciso do contato do financeiro urgente') < 0.1);
});

test('maxSimilarity pega o maior par', () => {
  const mx = h.maxSimilarity('quero marcar uma conversa rapida', ['nada a ver', 'quero marcar uma conversa rapida']);
  assert.strictEqual(mx, 1);
});

test('styleProfile é estável por seed nas partes de thread (item 12)', () => {
  const a = h.styleProfile('thread-77');
  const b = h.styleProfile('thread-77');
  assert.strictEqual(a.opener, b.opener);
  assert.strictEqual(a.abbreviations, b.abbreviations);
  assert.strictEqual(a.lowercaseStart, b.lowercaseStart);
});

test('humanizeWhatsapp remove travessão e aplica abreviações (inclusive acentuadas)', () => {
  const out = h.humanizeWhatsapp('Olá João — você está disponível para conversar também?', { abbreviations: true });
  assert.ok(!out.includes('—'));
  assert.ok(out.includes('vc'));
  assert.ok(out.includes('tá'));
  assert.ok(out.includes('pra'));
  assert.ok(out.includes('tbm'));
});

test('humanizeWhatsapp: dropFinalPeriod e lowercaseStart', () => {
  const out = h.humanizeWhatsapp('Bom dia, tudo certo.', { dropFinalPeriod: true, lowercaseStart: true });
  assert.ok(!/\.$/.test(out));
  assert.strictEqual(out[0], out[0].toLowerCase());
});

test('splitBubbles divide textos longos em 2', () => {
  const longMsg = 'Primeira frase bem completa aqui para dar contexto. Segunda frase igualmente longa e detalhada. Terceira parte final da mensagem com mais texto. Quarta e ultima frase so para garantir que passa dos 160 caracteres com folga.';
  const parts = h.splitBubbles(longMsg);
  assert.strictEqual(parts.length, 2);
  assert.strictEqual(h.splitBubbles('curta').length, 1);
});

test('humanDelayMs: noite/madrugada muito mais lento que horário comercial (item 3)', () => {
  // compara médias sobre muitas amostras (o jitter e o multiplicador "ocupado" são aleatórios)
  const N = 400;
  let sumDay = 0, sumNight = 0;
  for (let i = 0; i < N; i++) {
    sumDay += h.humanDelayMs('texto de teste medio aqui', { hour: 14 });
    sumNight += h.humanDelayMs('texto de teste medio aqui', { hour: 3 });
  }
  const meanDay = sumDay / N, meanNight = sumNight / N;
  assert.ok(meanNight > meanDay * 2.5, `média noite(${meanNight|0}) deveria ser bem > dia(${meanDay|0})`);
  assert.strictEqual(h.offHours(3), true);
  assert.strictEqual(h.offHours(14), false);
});

test('qualityIssues sinaliza jargão e alta similaridade (itens 1 e 2)', () => {
  const bad = h.qualityIssues('Gostaria de apresentar nossa solução', []);
  assert.ok(bad.botMarks.length > 0);
  assert.strictEqual(bad.ok, false);

  const dup = h.qualityIssues('quero marcar uma conversa rapida com voce', ['quero marcar uma conversa rapida com voce']);
  assert.strictEqual(dup.tooSimilar, true);

  const good = h.qualityIssues('oi ana, vi que voces cresceram bastante esse ano, faz sentido trocar uma ideia?', ['assunto totalmente diferente sobre outra coisa']);
  assert.strictEqual(good.ok, true);
});
