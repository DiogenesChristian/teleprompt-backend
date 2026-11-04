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

const REF_WPM = 150;          
const OFF_WORDS = 8;           
const OFF_MS = 4000;           
const SEARCH_BACK = 25, SEARCH_AHEAD = 140;


function words(text) {
  return String(text || '').replace(CUE_RE, ' ').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/r\$/g, ' ').replace(/(\d)[.,](?=\d{3}\b)/g, '$1')
    .replace(/[^a-z0-9%\s-]/g, ' ')
    .split(/[\s-]+/).filter(Boolean)
    .map((w) => NUMS[w] || w);
}

function lev1(a, b) {
  
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function stem(w) {
  return w.length >= 5 ? w.replace(/(oes|aes|ais|eis|res|es|s)$/, '').slice(0, 6) : w;
}
function levN(a, b, max) {
 
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}
function same(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  if (a.length >= 5 && b.length >= 5) {
    if (lev1(a, b)) return true;
    if (stem(a) === stem(b)) return true;
    if (a.length >= 8 && b.length >= 8) return levN(a, b, 2);
  }
  return false;
}
const FUZZY_TAIL = 8;      
const FUZZY_RATIO = 0.6;   
const READING_MS = 4000;   
const MAX_ANCHOR_GAP = 3;

class Tracker {
  constructor(script) {
    this.load(script);
    this.pos = 0;
    this.pace = [];
    this.lastFinalAt = null;
    this.interimText = null;
    this.spoken = [];          
    this.lastMatchAt = 0;
    this.unmatched = 0;
    this.offScript = false;
    this.bridge = null;
    this.elapsedSec = 0;
    this.states = {};
    (this.script.anchors || []).forEach((a) => { this.states[a.id] = 'pendente'; });
  }

  
  load(script) {
    const prev = this.states || {};
    const old = this.words ? { script: this.script, pos: this.pos, blockStart: this.blockStart, wordBlock: this.wordBlock, total: this.words.length } : null;
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
    if (old && typeof old.pos === 'number') {
      this.pos = this.remap(old);
      this.unmatched = 0;
      if (this.spoken && this.spoken.length >= 3) this.align(); // ajusta pelo que acabou de ser dito
    }
  }

  
  remap(old) {
    if (!old.total || !this.words.length) return 0;
    if (old.pos >= old.total) return this.words.length;
    const ob = old.wordBlock[Math.max(0, Math.min(old.pos, old.total - 1))];
    const offset = old.pos - old.blockStart[ob];
    const oldBlocks = old.script.blocks || [], blocks = this.script.blocks || [];
    for (let k = ob; k < oldBlocks.length; k++) {
      const nb = blocks.findIndex((b) => b.id === oldBlocks[k].id);
      if (nb < 0) continue; // tópico apagado: vai para o começo do próximo que ainda existe
      const start = this.blockStart[nb], end = nb + 1 < this.blockStart.length ? this.blockStart[nb + 1] : this.words.length;
      return k === ob ? Math.min(start + offset, end) : start;
    }
    return this.words.length;
  }

  setAnchor(id, state) { if (this.states[id]) this.states[id] = state; }
  setPosition(wordIndex) {
    this.pos = Math.max(0, Math.min(this.words.length, wordIndex | 0));
    this.unmatched = 0;
    this.spoken = [];
    this.pace = [];
    this.lastFinalAt = null;
    this.interimText = null;
    this.lastMatchAt = 0;
    this.offScript = false;
    this.bridge = null;
  }
  setClock(elapsedSec) { this.elapsedSec = Math.max(0, +elapsedSec || 0); }

  
  push(text, isFinal, now) {
    now = now ?? Date.now();
    if (!isFinal) {
      // Parciais substituem a hipótese anterior; nunca confirmam âncoras ou ritmo.
      if (text === this.interimText) return this.snapshot(now);
      this.interimText = text;
      const hypothesis = words(text);
      if (!hypothesis.length) return this.snapshot(now);
      const committed = this.spoken, pos = this.pos;
      this.spoken = committed.concat(hypothesis.map((w) => ({ w, t: now })));
      const matched = this.align();
      this.spoken = committed;
      this.pos = Math.max(pos, this.pos);
      if (matched) this.lastMatchAt = now;
      return this.snapshot(now);
    }
    this.interimText = null;
    const ws = words(text);
    if (!ws.length) return this.snapshot(now);
    if (this.lastFinalAt !== null && now > this.lastFinalAt) {
      this.pace.push({ count: ws.length, start: this.lastFinalAt, end: now });
    }
    this.lastFinalAt = now;
    this.pace = this.pace.filter((x) => now - x.end < 10000);
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
      if (!same(this.words[i + n - 1], tail[n - 1])) continue;
      if (score > bestScore || (score === bestScore && dist < bestDist)) { best = i; bestScore = score; bestDist = dist; }
    }
    const need = n >= 4 ? 3 : n;
    if (best >= 0 && bestScore >= need) { this.pos = Math.max(this.pos, Math.min(this.words.length, best + n)); return true; }
    return this.alignLoose();
  }

  
  alignLoose() {
    const recent = this.spoken.map((x) => x.w).filter((w) => !STOP.has(w)).slice(-FUZZY_TAIL);
    let best = null;
    const from = Math.max(0, this.pos - SEARCH_BACK);
    const to = Math.min(this.words.length - 1, this.pos + SEARCH_AHEAD);
    // Sufixos curtos permitem retomar após gagueira, correção ou frase pulada.
    for (let size = 3; size <= recent.length; size++) {
      const tail = recent.slice(-size);
      for (let i = from; i <= to; i++) {
        let k = i, hits = 0, last = -1, lastInput = -1;
        const lim = Math.min(this.words.length, i + size * 2 + 4);
        for (let j = 0; j < tail.length; j++) {
          let found = -1;
          for (let m = k; m < Math.min(lim, k + 5); m++) {
            if (same(this.words[m], tail[j])) { found = m; break; }
          }
          if (found >= 0) { hits++; last = found; lastInput = j; k = found + 1; }
        }
        if (hits < Math.max(3, Math.ceil(size * FUZZY_RATIO)) || lastInput !== size - 1) continue;
        const score = hits - (size - hits) * 0.6;
        const dist = Math.abs(i - this.pos);
        if (!best || score > best.score || (score === best.score && dist < best.dist)) {
          best = { score, last, dist };
        }
      }
    }
    if (!best) return false;
    this.pos = Math.max(this.pos, Math.min(this.words.length, best.last + 1));
    return true;
  }

  markAnchors() {
    const recent = this.spoken.slice(-40).map((x) => x.w);
    this.anchorInfo.forEach((info) => {
      if (this.states[info.a.id] !== 'pendente') return;
      let from = 0, matched = true, first = true;
      for (const token of info.key) {
        let found = -1;
        const start = first ? 0 : from;
        const end = first ? recent.length : Math.min(recent.length, from + MAX_ANCHOR_GAP + 1);
        for (let i = start; i < end; i++) {
          if (same(recent[i], token)) { found = i; break; }
        }
        if (found < 0) { matched = false; break; }
        from = found + 1;
        first = false;
      }
      if (matched) this.states[info.a.id] = 'dita';
    });
  }

  behind() {
    return this.anchorInfo
      .filter((i) => this.states[i.a.id] === 'pendente' && i.end > 0 && i.end + 3 < this.pos)
      .map((i) => i.a.id);
  }

  wpm(now) {
    const recent = this.pace.filter((x) => now - x.end < 10000);
    if (!recent.length) return null;
    let count = 0, duration = 0;
    for (const x of recent) {
      const overlap = x.end - Math.max(x.start, now - 10000);
      count += x.count * overlap / (x.end - x.start);
      duration += overlap;
    }
    if (duration < 1500) return null;
    return Math.round(count / duration * 60000);
  }

 
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
    const block = this.wordBlock[Math.min(this.pos, this.words.length - 1)] || 0;
    const topico = (this.script.blocks || [])[block] || {};
    return {
      pos: this.pos,
      total: this.words.length,
      block: block,
      blockId: topico.id || null,       // tópico atual (para o título mudar pela fala)
      blockTitle: topico.title || '',
      wpm: this.wpm(now ?? Date.now()),
      // a fala está batendo com o roteiro agora (usado para começar a rolar sozinho)
      reading: !!this.lastMatchAt && (now ?? Date.now()) - this.lastMatchAt < READING_MS,
      anchors: Object.assign({}, this.states),
      behind: this.behind(),
      offScript: this.offScript,
      bridge: this.bridge,
      cutPlan: this.cutPlan()
    };
  }
}

module.exports = { Tracker, words, same, stem };

