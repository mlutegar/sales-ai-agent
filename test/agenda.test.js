'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  slotDate, slotLabel, overlaps, conflictsWithBooked,
  agendaAvailabilityBlock, alternativeLabels,
} = require('../lib/agenda');

// ── slotDate / slotLabel ───────────────────────────────────────────────────────

test('slotDate: aceita ISO local com e sem segundos', () => {
  assert.ok(slotDate('2026-07-14T10:00') instanceof Date);
  assert.ok(slotDate('2026-07-14T10:00:00') instanceof Date);
  assert.strictEqual(slotDate('data-invalida'), null);
});

test('slotLabel: rótulo pt-BR com dia da semana e hora', () => {
  const label = slotLabel('2026-07-14T10:00');
  assert.match(label, /14\/07/);
  assert.match(label, /10:00/);
  assert.match(label, /às/);
});

test('slotLabel: entrada inválida devolve a string original (não quebra)', () => {
  assert.strictEqual(slotLabel('???'), '???');
});

// ── overlaps / conflictsWithBooked ─────────────────────────────────────────────

test('overlaps: mesmo horário conflita', () => {
  assert.ok(overlaps('2026-07-14T10:00', 15, '2026-07-14T10:00', 15));
});

test('overlaps: sobreposição parcial conflita (10:00–10:30 vs 10:15–10:45)', () => {
  assert.ok(overlaps('2026-07-14T10:00', 30, '2026-07-14T10:15', 30));
});

test('overlaps: encostado NÃO conflita (10:00–10:15 vs 10:15)', () => {
  assert.ok(!overlaps('2026-07-14T10:00', 15, '2026-07-14T10:15', 15));
});

test('overlaps: dias diferentes não conflitam', () => {
  assert.ok(!overlaps('2026-07-14T10:00', 60, '2026-07-15T10:00', 60));
});

test('overlaps: duração ausente assume 15 min', () => {
  assert.ok(overlaps('2026-07-14T10:00', null, '2026-07-14T10:10', null));
  assert.ok(!overlaps('2026-07-14T10:00', null, '2026-07-14T10:20', null));
});

test('conflictsWithBooked: detecta colisão com algum slot reservado', () => {
  const booked = [
    { date_time: '2026-07-14T09:00', duration_min: 30 },
    { date_time: '2026-07-14T14:00', duration_min: 30 },
  ];
  assert.ok(conflictsWithBooked('2026-07-14T14:15', 15, booked));
  assert.ok(!conflictsWithBooked('2026-07-14T11:00', 15, booked));
  assert.ok(!conflictsWithBooked('2026-07-14T11:00', 15, []));
});

// ── agendaAvailabilityBlock ────────────────────────────────────────────────────

test('bloco com slots: lista horários e proíbe inventar fora da lista', () => {
  const block = agendaAvailabilityBlock([
    { date_time: '2026-07-14T10:00', duration_min: 15 },
    { date_time: '2026-07-15T16:30', duration_min: 30 },
  ]);
  assert.match(block, /REALMENTE livres/);
  assert.match(block, /14\/07/);
  assert.match(block, /16:30/);
  assert.match(block, /NUNCA proponha horário fora da lista/);
});

test('bloco sem slots: proíbe propor data/hora e manda perguntar preferência', () => {
  const block = agendaAvailabilityBlock([]);
  assert.match(block, /NÃO proponha data\/hora/);
  assert.match(block, /preferência do cliente/);
});

// ── alternativeLabels ──────────────────────────────────────────────────────────

test('alternativeLabels: no máximo N rótulos', () => {
  const free = [
    { date_time: '2026-07-14T10:00' },
    { date_time: '2026-07-15T11:00' },
    { date_time: '2026-07-16T12:00' },
  ];
  const alts = alternativeLabels(free, 2);
  assert.strictEqual(alts.length, 2);
  assert.match(alts[0], /14\/07/);
});
