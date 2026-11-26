const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;
function validateBlocks(body, review = false) {
  if (!object(body) || !Array.isArray(body.blocks) || !body.blocks.length) return 'Informe pelo menos um bloco do roteiro.';
  const ids = new Set();
  for (const [i, b] of body.blocks.entries()) {
    const label = `Bloco ${i + 1}`;
    if (!object(b) || !nonempty(b.id)) return `${label}: identificador inválido.`;
    if (ids.has(b.id)) return `${label}: identificador duplicado.`;
    ids.add(b.id);
    if (typeof b.text !== 'string' || (review && !nonempty(b.text))) return `${label}: ${review ? 'informe um texto não vazio' : 'o texto deve ser uma string'}.`;
    if (b.title !== undefined && typeof b.title !== 'string') return `${label}: título inválido.`;
    if (b.durationSec !== undefined && (!Number.isFinite(b.durationSec) || b.durationSec < 0)) return `${label}: duração inválida.`;
  }
  if (body.anchors !== undefined) {
    if (!Array.isArray(body.anchors)) return 'As âncoras devem ser uma lista.';
    const anchorIds = new Set();
    for (const a of body.anchors) {
      if (!object(a) || !nonempty(a.id) || anchorIds.has(a.id) || !ids.has(a.blockId) || typeof a.text !== 'string') return 'Âncora inválida, duplicada ou vinculada a um bloco inexistente.';
      anchorIds.add(a.id);
      for (const field of ['label', 'type', 'priority']) if (a[field] !== undefined && typeof a[field] !== 'string') return 'Campo de âncora inválido.';
    }
  }
  return null;
}
module.exports = { object, nonempty, validateBlocks };
