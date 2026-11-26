const test = require('node:test');
const assert = require('node:assert/strict');
const {validateBlocks} = require('../src/validation');
const valid = {blocks:[{id:'b1',text:'Boa noite.'}]};
test('aceita texto válido e rascunho vazio, mas não revisão vazia',()=>{
  assert.equal(validateBlocks(valid,true),null);
  const draft={blocks:[{id:'b1',text:'  '}]};
  assert.equal(validateBlocks(draft),null); assert.match(validateBlocks(draft,true),/não vazio/);
});
test('rejeita estrutura, tipos e IDs inválidos',()=>{
  for(const body of [null,{}, {blocks:[]},{blocks:[null]},{blocks:[{id:'b1'}]},{blocks:[{id:'b1',text:1}]},{blocks:[...valid.blocks,...valid.blocks]},{blocks:[{id:'b1',text:'ok',durationSec:-1}]}]) assert.ok(validateBlocks(body));
});
test('rejeita âncoras inválidas e referências inexistentes',()=>{
  for(const anchors of [null,[null],[{id:'a1',blockId:'missing',text:'x'}]]) assert.ok(validateBlocks({...valid,anchors}));
  assert.equal(validateBlocks({...valid,anchors:[{id:'a1',blockId:'b1',text:'Boa'}]}),null);
});
