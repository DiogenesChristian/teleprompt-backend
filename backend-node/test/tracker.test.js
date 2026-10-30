const test = require('node:test');
const assert = require('node:assert/strict');
const { Tracker, words } = require('../src/speech/tracker');

const script = () => ({
  id: 'rt', durationSec: 60,
  blocks: [
    { id: 'b1', title: 'Abertura', text: 'Boa noite. O Governo Federal anunciou hoje um pacote de R$ 12 bilhões para 15 estados brasileiros a partir de janeiro.' },
    { id: 'b2', title: 'Detalhes', text: 'A ministra Helena Duarte afirmou que as obras começam pelo Nordeste. [PAUSA] A duplicação da BR-232 é prioridade.' },
    { id: 'b3', title: 'Encerramento', text: 'Você pode acompanhar tudo no nosso site. Boa noite.' }
  ],
  anchors: [
    { id: 'a1', blockId: 'b1', text: 'R$ 12 bilhões', label: 'Valor do pacote', type: 'valor', priority: 'essencial' },
    { id: 'a2', blockId: 'b2', text: 'Helena Duarte', label: 'Ministra Helena Duarte', type: 'nome', priority: 'essencial' },
    { id: 'a3', blockId: 'b2', text: 'Nordeste', label: 'Começa no Nordeste', type: 'obrigatoria', priority: 'cortavel' },
    { id: 'a4', blockId: 'b3', text: 'nosso site', label: 'Chamada para o site', type: 'cta', priority: 'essencial' }
  ]
});

test('normaliza palavras: acentos, R$, marcações técnicas e números por extenso', () => {
  assert.deepEqual(words('R$ 12 bilhões [PAUSA] Ação'), ['12', 'bilhoes', 'acao']);
  assert.deepEqual(words('doze estados'), ['12', 'estados']);
});

test('acompanha a posição da fala no roteiro', () => {
  const t = new Tracker(script());
  let s = t.push('boa noite o governo federal anunciou', true, 1000);
  assert.ok(s.pos >= 6 && s.pos <= 7, 'pos ' + s.pos);
  s = t.push('hoje um pacote de doze bilhões', true, 2000);
  assert.ok(s.pos > 10);
  assert.equal(s.offScript, false);
});

test('tolera erro de reconhecimento de uma letra', () => {
  const t = new Tracker(script());
  const s = t.push('boa noite o governo federau anunciou hoje', true, 1000);
  assert.ok(s.pos >= 7, 'pos ' + s.pos);
});

test('marca âncora como dita quando as palavras dela são faladas', () => {
  const t = new Tracker(script());
  const s = t.push('o governo anunciou um pacote de 12 bilhões para os estados', true, 1000);
  assert.equal(s.anchors.a1, 'dita');
  assert.equal(s.anchors.a2, 'pendente');
});

test('não marca âncora com palavras fora de ordem ou muito distantes', () => {
  const t = new Tracker(script());
  const s = t.push('Duarte falou sobre assuntos diferentes e só depois Helena encerrou a entrevista.', true, 1000);
  assert.equal(s.anchors.a2, 'pendente');
});

test('detecta improviso e sugere uma ponte para a próxima âncora pendente', () => {
  const t = new Tracker(script());
  t.push('boa noite o governo federal anunciou hoje um pacote de 12 bilhões', true, 1000);
  let s = t.push('olha eu estive lá ontem e conversei com muita gente', true, 3000);
  assert.equal(s.offScript, false, 'ainda dentro da tolerância de tempo');
  s = t.push('as pessoas estão bem preocupadas com o trânsito da cidade', true, 7000);
  assert.equal(s.offScript, true);
  assert.ok(s.bridge && s.bridge.text.length > 5);
  assert.ok(s.bridge.resumeText.length > 5);
  // volta ao roteiro: o improviso termina
  s = t.push('para 15 estados brasileiros a partir de janeiro', true, 8000);
  assert.equal(s.offScript, false);
  assert.equal(s.bridge, null);
});

test('âncora pulada fica para trás e ganha prioridade na ponte', () => {
  const t = new Tracker(script());
  t.push('boa noite o governo federal anunciou', true, 1000);
  // salta para o bloco 2 sem dizer o valor
  t.setPosition(25);
  t.push('a ministra afirmou que as obras começam pelo nordeste', true, 2000);
  const s = t.snapshot(2000);
  assert.ok(s.behind.includes('a1'), 'a1 ficou para trás: ' + JSON.stringify(s.behind));
  t.push('quero contar uma história que aconteceu comigo semana passada lá', true, 4000);
  const s2 = t.push('foi uma coisa muito curiosa e engraçada demais mesmo', true, 9000);
  assert.equal(s2.offScript, true);
  assert.equal(s2.bridge.anchorId, 'a1', 'a essencial atrasada vem primeiro');
});

test('plano de corte quando o tempo aperta', () => {
  const t = new Tracker(script());
  t.setClock(10);
  assert.equal(t.cutPlan().tight, false);
  t.setClock(55); // faltam 5 s para ~40 palavras
  const p = t.cutPlan();
  assert.equal(p.tight, true);
  assert.ok(p.deficitSec > 0);
  assert.ok(p.essential.includes('a1') && p.essential.includes('a2'));
  assert.ok(p.cuttable.includes('a3'));
});

test('mudança de última hora mantém os estados das âncoras', () => {
  const t = new Tracker(script());
  t.push('um pacote de 12 bilhões', true, 1000);
  const s = script(); s.blocks[0].text += ' Texto novo.';
  t.load(s);
  assert.equal(t.snapshot().anchors.a1, 'dita');
});


test('acompanha mesmo quando o apresentador troca algumas palavras', () => {
  const t = new Tracker(script());
  // roteiro: "O Governo Federal anunciou hoje um pacote de R$ 12 bilhões para 15 estados brasileiros"
  const s = t.push('o governo federal divulgou nesta segunda um pacote de doze bilhões para quinze estados', true, 1000);
  assert.equal(t.words[s.pos - 1], 'estados', 'parou depois de "estados" (pos ' + s.pos + ')');
  assert.equal(s.offScript, false);
});

test('palavra no singular ou plural conta como a mesma', () => {
  const { same } = require('../src/speech/tracker');
  assert.ok(same('estados', 'estado'));
  assert.ok(same('brasileiros', 'brasileiro'));
  assert.ok(!same('12', '13'));
});

test('edição de última hora mantém a fala no mesmo ponto do tópico', () => {
  const t = new Tracker(script());
  t.push('a ministra helena duarte afirmou que as obras começam', true, 1000);
  const before = t.snapshot(1000);
  assert.equal(before.block, 1);
  const s = script();
  s.blocks[0].text = 'Texto novo bem maior no começo. ' + 'Mais uma frase inserida aqui agora. '.repeat(3) + s.blocks[0].text;
  t.load(s);
  const after = t.snapshot(1000);
  assert.equal(after.block, 1, 'continua no tópico 2');
  
  assert.equal(t.words[after.pos], 'pelo');
});

test('tópico apagado leva a fala para o começo do próximo', () => {
  const t = new Tracker(script());
  t.setPosition(26); // dentro do tópico 2
  const s = script(); s.blocks.splice(1, 1);
  t.load(s);
  assert.equal(t.snapshot().block, 1);
  assert.equal(t.words[t.pos], 'voce');
});

test('sinaliza quando a leitura começou (para o teleprompter rodar sozinho)', () => {
  const t = new Tracker(script());
  assert.equal(t.snapshot(500).reading, false);
  let s = t.push('bom dia a todos', true, 1000);
  assert.equal(s.reading, false, 'fala fora do roteiro não conta');
  s = t.push('boa noite o governo federal anunciou', true, 2000);
  assert.equal(s.reading, true);
  assert.equal(t.snapshot(2000 + 5000).reading, false, 'parou de bater com o roteiro');
});


test('informa o tópico atual pela fala', () => {
  const t = new Tracker(script());
  let s = t.push('boa noite o governo federal anunciou', true, 1000);
  assert.equal(s.blockId, 'b1');
  assert.equal(s.blockTitle, 'Abertura');
  s = t.push('a ministra helena duarte afirmou que as obras', true, 2000);
  assert.equal(s.blockId, 'b2');
  assert.equal(s.blockTitle, 'Detalhes');
});