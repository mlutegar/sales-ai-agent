// Agenda interna (schedule_slots) — funções puras para a IA propor horários REAIS.
// A regra de negócio: o bot só oferece horários que existem como slot LIVRE na
// agenda da plataforma (nada de inventar "amanhã às 14h" sem lastro), e um horário
// pedido pelo cliente só vira sugestão se não colidir com reunião já reservada.
// Sem integração externa (Google/Outlook) por enquanto — fonte única: schedule_slots.

// Converte o date_time do slot ("YYYY-MM-DDTHH:MM[:SS]", hora local) em Date.
function slotDate(dateTimeStr) {
  const d = new Date(dateTimeStr);
  return isNaN(d.getTime()) ? null : d;
}

// Rótulo humano pt-BR: "seg., 14/07 às 10:00" — é o que a IA repete pro cliente.
function slotLabel(dateTimeStr) {
  const d = slotDate(dateTimeStr);
  if (!d) return String(dateTimeStr);
  const dia = d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `${dia} às ${hora}`;
}

// Sobreposição de intervalos [início, início+duração) — base da checagem de conflito.
function overlaps(aStart, aDurMin, bStart, bDurMin) {
  const a0 = slotDate(aStart), b0 = slotDate(bStart);
  if (!a0 || !b0) return false;
  const a1 = a0.getTime() + (aDurMin || 15) * 60000;
  const b1 = b0.getTime() + (bDurMin || 15) * 60000;
  return a0.getTime() < b1 && b0.getTime() < a1;
}

// true se o horário proposto colide com algum slot já RESERVADO (booked=1).
function conflictsWithBooked(dateTime, durationMin, bookedSlots) {
  return (bookedSlots || []).some((s) => overlaps(dateTime, durationMin, s.date_time, s.duration_min));
}

// Bloco de prompt com a disponibilidade REAL do vendedor.
// Com slots: a IA só pode oferecer horários desta lista (no máx. 2 por mensagem).
// Sem slots: proíbe inventar data/hora — pergunta a preferência do cliente.
function agendaAvailabilityBlock(freeSlots) {
  if (!freeSlots || !freeSlots.length) {
    return `\n## AGENDA DO VENDEDOR (disponibilidade real)\nNão há horários livres cadastrados na agenda. NÃO proponha data/hora específicas (você não sabe a disponibilidade). Pergunte a preferência do cliente (dia/período) e diga que confirma o horário em seguida.`;
  }
  const lista = freeSlots.map((s) => `- ${slotLabel(s.date_time)} (${s.duration_min || 15} min)`).join('\n');
  return `\n## AGENDA DO VENDEDOR (horários REALMENTE livres — use SOMENTE estes)\n${lista}\nAo propor horário de reunião, ofereça até 2 opções DESTA lista, pelo rótulo exato. NUNCA proponha horário fora da lista; se nenhum servir para o cliente, pergunte a preferência dele e diga que verifica a agenda.`;
}

// Alternativas prontas para notificação/hint quando o horário pedido conflita.
function alternativeLabels(freeSlots, n = 2) {
  return (freeSlots || []).slice(0, n).map((s) => slotLabel(s.date_time));
}

module.exports = { slotDate, slotLabel, overlaps, conflictsWithBooked, agendaAvailabilityBlock, alternativeLabels };
