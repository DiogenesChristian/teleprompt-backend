const test = require('node:test');
const assert = require('node:assert/strict');
const { Tracker } = require('../src/speech/tracker');
const script = { blocks: [{ id: 'b1', text: 'A ministra Helena Duarte afirmou que as obras começam pelo Nordeste. O projeto terá investimento federal. Você pode acompanhar tudo no nosso site.' }], anchors: [{ id: 'a1', blockId: 'b1', text: 'Helena Duarte' }] };

test('parciais são substituídas sem duplicar palavras nem confirmar âncoras', () => {
  const t = new Tracker(script);
  let s = t.push('a ministra Helena Duarte', false, 1000);
  assert.equal(s.pos, 4);
  assert.equal(s.anchors.a1, 'pendente');
  t.push('a ministra Helena Duarte', false, 1500);
  t.push('a ministra Helena Duarte afirmou', false, 1800);
  s = t.push('a ministra Helena Duarte afirmou', true, 2000);
  assert.equal(s.pos, 5);
  assert.equal(s.anchors.a1, 'dita');
  assert.equal(t.spoken.length, 5);
  assert.equal(s.wpm, null);
});

test('gagueira e autocorreção retomam sem recuar a posição', () => {
  const t = new Tracker(script);
  let s = t.push('a ministra ministra Helena quer dizer Helena Duarte afirmou que as obras começam', true, 1000);
  assert.equal(t.words[s.pos], 'pelo');
  const pos = s.pos;
  s = t.push('Helena Duarte afirmou', true, 2000);
  assert.equal(s.pos, pos);
});

test('pular frase retoma adiante sem marcar âncora omitida', () => {
  const t = new Tracker(script);
  t.push('a ministra', true, 1000);
  const s = t.push('você pode acompanhar tudo no nosso site', true, 3000);
  assert.equal(s.pos, t.words.length);
  assert.equal(s.anchors.a1, 'pendente');
  assert.ok(s.behind.includes('a1'));
});

test('palavras antigas não mantêm leitura durante improviso', () => {
  const t = new Tracker(script);
  t.push('a ministra Helena Duarte afirmou', true, 1000);
  t.push('viagem completamente diferente distante inesperada', true, 3000);
  const s = t.push('outros assuntos pessoais surgiram durante aquela conversa longa', true, 7000);
  assert.equal(s.offScript, true);
  assert.equal(s.reading, false);
});

test('pausa ao perder o trecho e só retoma com fala confirmada durante o improviso', () => {
  const t = new Tracker(script);
  const pos = t.push('a ministra Helena Duarte afirmou', true, 1000).pos;
  let s = t.push('e', true, 2000);
  assert.equal(s.reading, false);
  assert.equal(s.pos, pos);
  s = t.push('minha viagem teve passeios completamente diferentes durante aquelas férias', true, 6000);
  assert.equal(s.offScript, true);
  assert.ok(s.bridge);
  s = t.push('as obras começam pelo Nordeste', false, 6500);
  assert.equal(s.pos, pos);
  assert.equal(s.offScript, true);
  s = t.push('as obras começam pelo Nordeste', true, 7000);
  assert.ok(s.pos > pos);
  assert.equal(s.reading, true);
  assert.equal(s.offScript, false);
  assert.equal(s.bridge, null);
});

for (const wpm of [90, 150, 220]) {
  test(`ritmo de ${wpm} ppm independe de lote de transcrição`, () => {
    const t = new Tracker(script);
    let now = 1000;
    t.push('a ministra Helena', true, now);
    for (let i = 0; i < 4; i++) {
      now += 4 / wpm * 60000;
      t.push('Duarte afirmou que as', true, now);
    }
    assert.ok(Math.abs(t.snapshot(now).wpm - wpm) <= 1);
  });
}

test('salto manual descarta a hipótese e o histórico de ritmo', () => {
  const t = new Tracker(script);
  t.push('a ministra Helena Duarte', true, 1000);
  t.setPosition(0);
  assert.equal(t.snapshot(2000).reading, false);
  assert.equal(t.spoken.length, 0);
  assert.equal(t.snapshot(2000).wpm, null);
});
