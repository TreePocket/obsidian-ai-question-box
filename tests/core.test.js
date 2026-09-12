const { test } = require('node:test');
const assert = require('node:assert/strict');
const { template, parseQuestions, ensureIds, patchAnswer, contextWithoutAnswers } = require('../core');
function apply(text, expected, answer) { const p = patchAnswer(text, expected, answer); return text.slice(0, p.start) + p.replacement + text.slice(p.end); }
test('插入、识别多题、写回嵌套 Markdown，并保留其他内容', () => {
  const text = '# 正文\n\n' + template('问题一\n补充', 'one') + '\n正文中段\n\n' + template('问题二', 'two') + '\n结尾\n';
  const blocks = parseQuestions(text); assert.equal(blocks.length, 2); assert.equal(blocks[0].question, '问题一\n补充');
  const answer = '第一段\n\n- 列表\n\n```js\nconst a = 1;\n```\n\n> 引用';
  const changed = apply(text, blocks[0], answer);
  assert.equal(parseQuestions(changed)[0].answer, answer);
  assert.ok(changed.endsWith(text.slice(blocks[0].end)));
  assert.equal(parseQuestions(changed)[1].raw, blocks[1].raw);
  assert.equal(parseQuestions(apply(changed, blocks[1], '第二答')).length, 2);
});
test('忽略代码示例、frontmatter、普通引用和答案内的提问标记', () => {
  const text = '---\nx: |\n  > [!ai-question] fake\n---\n```md\n' + template('fake', 'f') + '```\n\n    > [!ai-question] fake\n\n> 普通引用\n\n' + template('real', 'r');
  assert.deepEqual(parseQuestions(text).map(b => b.id), ['r']);
  const result = apply(text, parseQuestions(text)[0], '> [!ai-question|fake] 不执行\n> 问题');
  assert.equal(parseQuestions(result).length, 1);
});
test('问题代码内的答案标记不截断问题', () => {
  const text = '> [!ai-question|id] 提问\n> ```md\n> > [!ai-answer] example\n> ```\n> 解释上面的代码\n';
  assert.ok(parseQuestions(text)[0].question.endsWith('解释上面的代码'));
});
test('补充缺失标识并修复复制导致的重复 ID，重跑保持稳定', () => {
  const text = template('A', 'same') + '\n' + template('B', 'same') + '\n> [!ai-question] 标题问题\n> 内容\n';
  const next = ensureIds(text); const blocks = parseQuestions(next);
  assert.equal(new Set(blocks.map(b => b.id)).size, 3); assert.equal(next, ensureIds(next));
  assert.equal(blocks[2].question, '标题问题\n内容');
});
test('问题、手写答案、删除或重复 ID 冲突时拒绝覆盖', () => {
  const text = template('问题', 'id'); const b = parseQuestions(text)[0];
  for (const modified of [text.replace('> 问题', '> 改了问题'), text.replace('<!-- ai-answer:empty -->', '手写答案'), '', text + '\n' + text]) assert.throws(() => apply(modified, b, '答案'), /未覆盖/);
  assert.equal(parseQuestions(apply('新增正文\n\n' + text, b, '答案'))[0].answer, '答案');
});
test('上下文剔除旧答案，空答案不破坏原文', () => {
  const text = template('问题', 'id'); const b = parseQuestions(text)[0];
  assert.throws(() => apply(text, b, '  '), /空答案/);
  const answered = apply(text, b, '旧答案');
  assert.ok(!contextWithoutAnswers(answered).includes('旧答案'));
  assert.ok(contextWithoutAnswers(answered).includes('问题'));
});
test('保留 CRLF 与文件末尾无换行', () => {
  const text = template('问题', 'id').trimEnd().replace(/\n/g, '\r\n');
  const result = apply(text, parseQuestions(text)[0], '第一行\n第二行');
  assert.ok(!result.endsWith('\n')); assert.ok(!/(?<!\r)\n/.test(result));
  assert.equal(parseQuestions(result)[0].answer, '第一行\n第二行');
});
test('不允许答案框后外层文字被静默删除', () => {
  assert.throws(() => parseQuestions(template('问题', 'id') + '> 额外文字\n'), /外层文字/);
});
