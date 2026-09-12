const { test }=require('node:test');
const assert=require('node:assert/strict');
const {template,parseQuestions,patchAnswer,contextWithoutAnswers}=require('../core');
const {withAnnotations,anchorFor,locate,hash}=require('../annotations');
const {insertFollowUp,followUpContext,mergeLegacyFollowUps}=require('../follow-up');
test('高亮元数据保留中文、表情及跨格式引用，不污染问题或模型上下文',()=>{
  const raw=template('解释**概念**🙂','id');
  const anchor=anchorFor('解释概念🙂',2,4,'question','解释**概念**🙂');
  const updated=withAnnotations(raw,[anchor]);
  const b=parseQuestions(updated)[0];
  assert.equal(b.question,'解释**概念**🙂');assert.deepEqual(b.annotations,[anchor]);
  assert.ok(!contextWithoutAnswers(updated).includes('aqb-highlights'));
  assert.equal(withAnnotations(updated,[]),raw);
});
test('重复文字通过前后文定位，歧义或内容变化时不错误高亮',()=>{
  const text='第一次词语，第二次词语。';const start=text.lastIndexOf('词语');
  const a=anchorFor(text,start,start+2,'answer','source');
  assert.deepEqual(locate(text,a),{start,end:start+2});
  assert.equal(locate('内容已变化',a),null);
  assert.equal(locate('词语词语',{quote:'词语',prefix:'',suffix:''}),null);
  assert.notEqual(hash('旧答案'),hash('新答案'));
});
test('重答清除旧答案高亮，同时保留问题高亮和折叠默认值',()=>{
  let raw=template('问题','id').replace('[!ai-answer]+','[!ai-answer]-');
  const q=anchorFor('问题',0,2,'question','问题'),a=anchorFor('旧答案',0,3,'answer','旧答案');
  raw=withAnnotations(raw,[q,a]);const b=parseQuestions(raw)[0];
  const result=patchAnswer(raw,b,'新答案').replacement;
  assert.deepEqual(parseQuestions(result)[0].annotations,[q]);assert.ok(result.includes('[!ai-answer]-'));
});
test('追问引用所选答案，原框与后续正文保持原样',()=>{
  const block=template('原问题','parent');const text='前文\n\n'+block+'\n后文\n';
  const next=insertFollowUp(text,parseQuestions(text)[0],'为什么？','带**符号**\n[!ai-answer] 引用');const parsed=parseQuestions(next.text);
  assert.equal(parsed.length,2);assert.equal(parsed[0].raw,block);assert.equal(parsed[1].id,next.id);
  assert.equal(parsed[1].question,'为什么？');assert.equal(parsed[1].answer,'');
  assert.equal(parsed[1].thread.rootId,'parent');assert.ok(followUpContext('正文',parsed[1],parsed).includes('带**符号**'));
  assert.ok(next.text.startsWith('前文\n\n'));assert.ok(next.text.endsWith('\n后文\n'));
});
test('连续追问按顺序追加到同一原框关联下，旧版冗余内容可转换',()=>{
  const parent=template('原问题','p');
  let first=insertFollowUp(parent,parseQuestions(parent)[0],'追问1','引用');
  let second=insertFollowUp(first.text,parseQuestions(first.text)[1],'追问2','追问回答');
  const blocks=parseQuestions(second.text);
  assert.deepEqual(blocks.map(b=>b.question),['原问题','追问1','追问2']);assert.equal(blocks[2].thread.rootId,'p');assert.equal(blocks[2].thread.replyToId,first.id);
  const legacy=parent+'\n'+template('原问题：原问题\n\n我对下面这段回答有疑惑：\n\n> 引用\n\n我的追问：为什么？','f');
  const migrated=mergeLegacyFollowUps(legacy);assert.equal(migrated.count,1);assert.equal(parseQuestions(migrated.text)[1].question,'为什么？');assert.equal(parseQuestions(migrated.text)[1].thread.rootId,'p');
  assert.equal(mergeLegacyFollowUps(migrated.text).count,0);
});
test('追问遇到原框修改或重复标识时拒绝覆盖',()=>{
  const raw=template('问题','id');const b=parseQuestions(raw)[0];
  assert.throws(()=>insertFollowUp(raw.replace('> 问题','> 已改'),b,'追问'),/已修改/);
  assert.throws(()=>insertFollowUp(raw+'\n'+raw,b,'追问'),/已修改/);
});
test('追问兼容 CRLF 与原框末尾无换行',()=>{
  const raw=template('问题','id').trimEnd().replace(/\n/g,'\r\n');
  const next=insertFollowUp(raw,parseQuestions(raw)[0],'追问');
  assert.equal(parseQuestions(next.text).length,2);assert.ok(!/(?<!\r)\n/.test(next.text));
});
