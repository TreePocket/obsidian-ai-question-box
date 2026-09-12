const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runClaude, getConfig, parseEnv } = require('../bridge');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqb-tests-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const cli = path.join(temp, 'fake-claude');
fs.writeFileSync(cli, `#!${process.execPath}\nlet input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const mode=process.env.TEST_MODE;if(mode==='wait')return setTimeout(()=>{},10000);if(mode==='bad')return console.log('invalid');if(mode==='error'){console.log(JSON.stringify({is_error:true,result:'test failure'}));process.exitCode=1;return;}const a=process.argv.slice(2);console.log(JSON.stringify({result:JSON.stringify({input,tools:a[a.indexOf('--tools')+1],settings:a[a.indexOf('--setting-sources')+1],mcp:a.includes('--strict-mcp-config')})}));});\n`, { mode: 0o755 });
function config(mode) { return { cli, model: 'test', env: { ...process.env, TEST_MODE: mode }, loadUserSettings: true }; }
test('通过 stdin 发送文档，禁用工具和 MCP，按 Claudian 配置加载用户认证', async () => {
  const prompt = '问题 `echo should-not-run` $(test)';
  const answer = JSON.parse(await runClaude(config(), prompt));
  assert.equal(answer.input, prompt); assert.equal(answer.tools, ''); assert.equal(answer.settings, 'user'); assert.equal(answer.mcp, true);
});
test('进程失败或无效结果不能写成答案', async () => {
  await assert.rejects(runClaude(config('error'), 'q'), /test failure/);
  await assert.rejects(runClaude(config('bad'), 'q'), /返回异常/);
});
test('停止与超时均能退出等待', async () => {
  const controller = new AbortController(); const pending = runClaude(config('wait'), 'q', { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /已停止/);
  await assert.rejects(runClaude(config('wait'), 'q', { timeoutMs: 50 }), /超时/);
});
test('Claudian 未启用或接口变更时明确报错', () => {
  assert.throws(() => getConfig({}), /先启用/);
  assert.throws(() => getConfig({ plugins: { plugins: { realclaudian: {} } } }), /不兼容/);
});
test('遵循当前 Claude 会话模型、用户配置开关和环境变量', () => {
  const p = { manifest: { version: '2.0.31' }, settings: { model: 'haiku', providerConfigs: { claude: { loadUserSettings: false } } }, getResolvedProviderCliPath: () => cli, getActiveEnvironmentVariables: () => 'export ANTHROPIC_MODEL="custom"\n# ignore', getView: () => ({ getActiveTab: () => ({ providerId: 'claude', conversationId: 'id' }) }), getConversationSync: () => ({ selectedModel: 'opus' }) };
  const c = getConfig({ plugins: { plugins: { realclaudian: p } } });
  assert.equal(c.model, 'opus'); assert.equal(c.loadUserSettings, false); assert.equal(c.env.ANTHROPIC_MODEL, 'custom');
  assert.deepEqual(parseEnv("A='a=b'\nBAD\n# comment"), { A: 'a=b' });
});
