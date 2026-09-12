const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const { template, parseQuestions } = require('../core');
function harness(generate, text) {
  const state = { text, calls: 0, notices: [] }, mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../main-source'), 'utf8'), {
    require: id => id === 'obsidian' ? { Plugin: class {}, PluginSettingTab: class {}, Modal: class {}, Notice: class { constructor(text) { state.notices.push(text); } } } : id === './bridge' ? { getConfig: () => ({ model: 'test' }), runClaude: async (...args) => { state.calls++; return generate(state, ...args); } } : require(id.startsWith('./') ? '../'+id.slice(2) : id),
    module: mod, console, AbortController, setTimeout, clearTimeout
  });
  const plugin = new mod.exports(); const file = { extension: 'md', path: 'note.md' };
  plugin.app = { workspace: { getLeavesOfType: () => [] }, vault: { read: async () => state.text, process: async (_, fn) => { state.text = fn(state.text); } } };
  plugin.settings = { instructions: '', timeout: 30 }; plugin.refresh = () => {}; plugin.showProgress = () => {};
  return { plugin, file, state };
}
test('批量写回、上下文保留，重跑未答命令不重复调用模型', async () => {
  const { plugin, file, state } = harness(async () => '答案', '# 文档\n\n' + template('问题1', 'one') + '\n' + template('问题2', 'two'));
  await plugin.run(file, false);
  assert.deepEqual(parseQuestions(state.text).map(b => b.answer), ['答案', '答案']);
  assert.ok(state.text.startsWith('# 文档\n\n')); assert.equal(state.calls, 2);
  await plugin.run(file, false); assert.equal(state.calls, 2); assert.equal(plugin.job, null);
});
test('生成期间修改当前问题：保留手写内容，未写入答案可在结果中找回', async () => {
  const { plugin, file, state } = harness(async s => { s.text = s.text.replace('问题1', '修改后的问题'); return '生成答案'; }, template('问题1', 'one'));
  await plugin.run(file, false);
  assert.equal(parseQuestions(state.text)[0].question, '修改后的问题'); assert.equal(parseQuestions(state.text)[0].answer, '');
  assert.equal(plugin.report.items[0].status, '未写回'); assert.equal(plugin.report.items[0].answer, '生成答案');
});
test('模型失败保留旧答案，其他题继续执行', async () => {
  const text = template('问题1', 'one').replace('<!-- ai-answer:empty -->', '旧答案') + '\n' + template('问题2', 'two');
  const { plugin, file, state } = harness(async s => { if (s.calls === 1) throw new Error('网络失败'); return '第二题答案'; }, text);
  await plugin.run(file, true);
  assert.deepEqual(parseQuestions(state.text).map(b => b.answer), ['旧答案', '第二题答案']);
});
test('取消后不写回当前回答且不继续下一题；重复点击不能开启第二任务', async () => {
  let resolve; const gate = new Promise(r => resolve = r);
  const { plugin, file, state } = harness(async () => gate, template('问题1', 'one') + '\n' + template('问题2', 'two'));
  const running = plugin.run(file, true);
  await new Promise(r => setTimeout(r, 10));
  await plugin.run(file, true); assert.equal(state.calls, 1);
  plugin.stop(false); resolve('迟到答案'); await running;
  assert.deepEqual(parseQuestions(state.text).map(b => b.answer), ['', '']); assert.equal(state.calls, 1); assert.equal(plugin.job, null);
});
