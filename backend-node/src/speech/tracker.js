/* Globo Flow — rastreador de fala (mapa de âncoras).
 *
 * Recebe as palavras que a API de voz reconheceu e responde, em tempo real:
 *   - pos:       em que palavra do roteiro o apresentador está;
 *   - wpm:       ritmo da fala em palavras por minuto;
 *   - anchors:   âncoras já ditas (pendente → dita);
 *   - behind:    âncoras que ficaram para trás (sobem de prioridade e pulsam);
 *   - offScript: se o apresentador saiu do roteiro (improviso);
 *   - bridge:    frase curta sugerida para voltar ao roteiro;
 *   - cutPlan:   com o tempo apertado, o que é cortável e o que é essencial.
 *
 * É código puro (sem rede), testado em test/tracker.test.js.
 */
'use strict';

const CUE_RE = /\[(PAUSA|ÊNFASE|ENFASE|CÂMERA \d|CAMERA \d|VINHETA|ENTRA VT|SOBE SOM|CORTA)\]/gi;
const STOP = new Set(('a o e as os um uma uns umas de do da dos das no na nos nas em ao aos por para com sem que se ' +
  'mais mas como foi ser sao esta estao isso esse essa este aquele aquela tambem ja nao sim seu sua seus suas ' +
  'ele ela eles elas nos voce voces muito onde quando qual entre sobre ate desde apos antes depois ' +
  'pelo pela pelos pelas cada todo toda todos todas outro outra ainda apenas hoje').split(' '));

const NUMS = {
  zero: '0', um: '1', uma: '1', dois: '2', duas: '2', tres: '3', quatro: '4', cinco: '5', seis: '6', sete: '7',
  oito: '8', nove: '9', dez: '10', onze: '11', doze: '12', treze: '13', quatorze: '14', catorze: '14', quinze: '15',
  dezesseis: '16', dezessete: '17', dezoito: '18', dezenove: '19', vinte: '20', trinta: '30', quarenta: '40',
  cinquenta: '50', sessenta: '60', setenta: '70', oitenta: '80', noventa: '90', cem: '100'
};

const REF_WPM = 150;           // ritmo de referência de telejornal
const OFF_WORDS = 8;           // palavras fora do roteiro para considerar improviso
const OFF_MS = 4000;           // ... e há pelo menos 4 s sem bater com o texto
const SEARCH_BACK = 25, SEARCH_AHEAD = 140;

/* Texto → palavras normalizadas (sem acento, pontuação ou marcações técnicas). */
function words(text) {
  return String(text || '').replace(CUE_RE, ' ').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/r\$/g, ' ').replace(/(\d)[.,](?=\d{3}\b)/g, '$1')
    .replace(/[^a-z0-9%\s-]/g, ' ')
    .split(/[\s-]+/).filter(Boolean)
    .map((w) => NUMS[w] || w);
}

function lev1(a, b) {
  // distância de edição ≤ 1 (tolerância a erro de reconhecimento)
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
function same(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  if (a.length >= 5 && b.length >= 5) return lev1(a, b);
  return false;
}

class Tracker {
  constructor(script) {
    this.load(script);
    this.pos = 0;
    this.spoken = [];          // [{w, t}] últimas palavras finais
    this.lastMatchAt = 0;
    this.unmatched = 0;
    this.offScript = false;
    this.bridge = null;
    this.elapsedSec = 0;
    this.states = {};
    (this.script.anchors || []).forEach((a) => { this.states[a.id] = 'pendente'; });
  }

  /* (Re)carrega o roteiro mantendo estados das âncoras (mudança de última hora). */
  load(script) {
    const prev = this.states || {};
    this.script = script || { blocks: [], anchors: [] };
    this.words = []; this.wordBlock = []; this.blockStart = [];
    (this.script.blocks || []).forEach((b, i) => {
      this.blockStart.push(this.words.length);
      words(b.text).forEach((w) => { this.words.push(w); this.wordBlock.push(i); });
    });
    this.anchorInfo = (this.script.anchors || []).map((a) => {
      const bi = this.script.blocks.findIndex((b) => b.id === a.blockId);
      const toks = words(a.text);
      const key = toks.filter((w) => !STOP.has(w));
      let start = -1;
      if (bi >= 0) {
        const s = this.blockStart[bi], e = bi + 1 < this.blockStart.length ? this.blockStart[bi + 1] : this.words.length;
        for (let i = s; i <= e - toks.length && start < 0; i++) {
          if (toks.every((t, k) => this.words[i + k] === t)) start = i;
        }
        if (start < 0) start = s;
      }
      return { a, block: bi, start, end: start + toks.length, key: key.length ? key : toks };
    });
    if (this.states) {
      this.states = {};
      (this.script.anchors || []).forEach((a) => { this.states[a.id] = prev[a.id] || 'pendente'; });
    }
  }

  setAnchor(id, state) { if (this.states[id]) this.states[id] = state; }
  setPosition(wordIndex) { this.pos = Math.max(0, Math.min(this.words.length, wordIndex | 0)); this.unmatched = 0; }
  setClock(elapsedSec) { this.elapsedSec = Math.max(0, +elapsedSec || 0); }

  /* Recebe um trecho reconhecido. Só os finais mexem no estado. */
  push(text, isFinal, now) {
    now = now || Date.now();
    if (!isFinal) return this.snapshot(now);
    const ws = words(text);
    if (!ws.length) return this.snapshot(now);
    ws.forEach((w) => this.spoken.push({ w, t: now }));
    this.spoken = this.spoken.slice(-60);

    const matched = this.align(now);
    if (matched) { this.unmatched = 0; this.lastMatchAt = now; }
    else this.unmatched += ws.length;

    this.markAnchors();
    const wasOff = this.offScript;
    this.offScript = !matched && this.unmatched >= OFF_WORDS && now - (this.lastMatchAt || 0) >= OFF_MS;
    if (this.offScript && !wasOff) this.bridge = this.makeBridge();
    if (!this.offScript) this.bridge = null;
    return this.snapshot(now);
  }

  /* Procura as últimas palavras faladas perto da posição atual. */
  align() {
    const tail = this.spoken.slice(-4).map((x) => x.w);
    if (tail.length < 3) {
      // começo da fala: aceita 2 palavras se baterem exatamente
      if (tail.length < 2) return false;
    }
    const n = tail.length;
    const from = Math.max(0, this.pos - SEARCH_BACK), to = Math.min(this.words.length - 1, this.pos + SEARCH_AHEAD);
    let best = -1, bestScore = 0, bestDist = 1e9;
    for (let i = from; i <= to; i++) {
      let score = 0;
      for (let j = 0; j < n; j++) if (same(this.words[i + j], tail[j])) score++;
      const dist = Math.abs(i - this.pos);
      if (score > bestScore || (score === bestScore && dist < bestDist)) { best = i; bestScore = score; bestDist = dist; }
    }
    const need = n >= 4 ? 3 : n;
    if (best >= 0 && bestScore >= need) { this.pos = Math.min(this.words.length, best + n); return true; }
    return false;
  }

  markAnchors() {
    const recent = this.spoken.slice(-40).map((x) => x.w);
    this.anchorInfo.forEach((info) => {
      if (this.states[info.a.id] !== 'pendente') return;
      const ok = info.key.every((k) => recent.some((w) => same(w, k)));
      if (ok) this.states[info.a.id] = 'dita';
    });
  }

  behind() {
    return this.anchorInfo
      .filter((i) => this.states[i.a.id] === 'pendente' && i.end > 0 && i.end + 3 < this.pos)
      .map((i) => i.a.id);
  }

  wpm(now) {
    const recent = this.spoken.filter((x) => now - x.t <= 10000);
    if (recent.length < 4) return null;
    const span = Math.max(3000, now - recent[0].t);
    return Math.round(recent.length / span * 60000);
  }

  /* Cartão de ponte: frase curta para voltar ao roteiro. */
  makeBridge() {
    const pending = this.anchorInfo.filter((i) => this.states[i.a.id] === 'pendente');
    const late = pending.filter((i) => i.end + 3 < this.pos);
    const ahead = pending.filter((i) => i.end + 3 >= this.pos).sort((x, y) => x.start - y.start);
    const pick = late.find((i) => i.a.priority === 'essencial') || ahead[0] || late[0];
    const block = this.wordBlock[Math.min(this.pos, this.words.length - 1)] || 0;
    const resume = this.resumeText(this.pos);
    if (!pick) {
      return { text: 'Voltando ao nosso assunto…', anchorId: null, resumeAt: this.pos, resumeBlock: block, resumeText: resume };
    }
    const a = pick.a;
    const templates = {
      nome: 'Voltando ao que disse ' + a.text + '…',
      data: 'E vale lembrar a data: ' + a.text + '.',
      valor: 'Voltando aos números: ' + a.text + '.',
      numero: 'Voltando aos números: ' + a.text + '.',
      cta: 'Antes de seguir: ' + a.text + '.',
      encerramento: 'E para encerrar…'
    };
    const late1 = late.indexOf(pick) >= 0;
    return {
      text: templates[a.type] || (late1 ? 'Um ponto importante: ' + a.label + '.' : 'Isso nos leva ao próximo ponto: ' + a.label + '.'),
      anchorId: a.id,
      anchorLabel: a.label,
      resumeAt: late1 ? pick.start : this.pos,
      resumeBlock: late1 ? pick.block : block,
      resumeText: late1 ? this.resumeText(pick.start) : resume
    };
  }

  resumeText(from) {
    const b = this.wordBlock[Math.min(from, this.words.length - 1)];
    const block = this.script.blocks[b];
    if (!block) return '';
    const plain = String(block.text).replace(CUE_RE, ' ').replace(/\s{2,}/g, ' ').trim();
    const sentences = plain.match(/[^.!?]+[.!?]*/g) || [plain];
    let count = this.blockStart[b];
    for (const s of sentences) {
      const n = words(s).length;
      if (count + n > from) return s.trim();
      count += n;
    }
    return sentences[sentences.length - 1].trim();
  }

  /* Plano de corte: se o tempo não fecha, o que pode sair e o que fica. */
  cutPlan() {
    const duration = +this.script.durationSec || 0;
    if (!duration) return { tight: false };
    const remainingSec = duration - this.elapsedSec;
    const needSec = (this.words.length - this.pos) / REF_WPM * 60;
    const deficitSec = Math.round(needSec - remainingSec);
    if (deficitSec <= Math.max(5, duration * 0.05)) return { tight: false, deficitSec: Math.max(0, deficitSec) };
    const cur = this.wordBlock[Math.min(this.pos, this.words.length - 1)] || 0;
    const pending = this.anchorInfo.filter((i) => this.states[i.a.id] === 'pendente' && i.block >= cur);
    const cuttableBlocks = (this.script.blocks || []).map((b, i) => ({ b, i }))
      .filter(({ b, i }) => i > cur && this.anchorInfo.every((x) => x.block !== i || x.a.priority !== 'essencial' || this.states[x.a.id] !== 'pendente'))
      .map(({ b }) => ({ id: b.id, title: b.title, saveSec: Math.round(words(b.text).length / REF_WPM * 60) }));
    return {
      tight: true,
      deficitSec,
      essential: pending.filter((i) => i.a.priority === 'essencial').map((i) => i.a.id),
      cuttable: pending.filter((i) => i.a.priority !== 'essencial').map((i) => i.a.id),
      cuttableBlocks
    };
  }

  snapshot(now) {
    return {
      pos: this.pos,
      total: this.words.length,
      block: this.wordBlock[Math.min(this.pos, this.words.length - 1)] || 0,
      wpm: this.wpm(now || Date.now()),
      anchors: Object.assign({}, this.states),
      behind: this.behind(),
      offScript: this.offScript,
      bridge: this.bridge,
      cutPlan: this.cutPlan()
    };
  }
}

module.exports = { Tracker, words, same };
