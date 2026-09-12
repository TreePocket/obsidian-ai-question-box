'use strict';
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
function parseEnv(input) {
  const env = {};
  for (const line of (input || '').split(/\r?\n/)) {
    const m = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}
function getConfig(app) {
  const p = app.plugins?.getPlugin?.('realclaudian') || app.plugins?.plugins?.realclaudian || app.plugins?.plugins?.claudian;
  if (!p) throw new Error('请先启用 Claudian 插件，并配置 Claude。');
  if (typeof p.getResolvedProviderCliPath !== 'function' || typeof p.getActiveEnvironmentVariables !== 'function') throw new Error('当前 Claudian 接口不兼容。本插件已验证 Claudian 2.0.31。');
  const cli = p.getResolvedProviderCliPath('claude');
  if (!cli) throw new Error('Claudian 未找到 Claude Code，请在 Claudian 设置中配置 Claude 路径。');
  const custom = parseEnv(p.getActiveEnvironmentVariables('claude'));
  const s = p.settings || {};
  const activeTab = p.getView?.()?.getActiveTab?.();
  const conversation = activeTab?.conversationId ? p.getConversationSync?.(activeTab.conversationId) : null;
  const activeModel = activeTab?.providerId === 'claude' ? activeTab.service?.getAuxiliaryModel?.() || conversation?.selectedModel || activeTab.draftModel : null;
  const model = activeModel || ((s.settingsProvider || 'claude') === 'claude' ? s.model : s.savedProviderModel?.claude) || custom.ANTHROPIC_MODEL || 'sonnet';
  const env = { ...process.env, ...custom };
  env.PATH = [path.dirname(cli), path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH].filter(Boolean).join(path.delimiter);
  delete env.CLAUDECODE;
  return { cli, model: model.replace(/^(?:claude-code\/|claude:)/, ''), env, loadUserSettings: s.providerConfigs?.claude?.loadUserSettings ?? s.loadUserClaudeSettings ?? true, version: p.manifest.version };
}
function runClaude(config, prompt, { signal, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('已停止'));
    const args = ['--print', '--output-format', 'json', '--model', config.model, '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', config.loadUserSettings ? 'user' : '', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--no-session-persistence', '--system-prompt', '你是文档问答助手，只根据用户提供的资料和知识回答问题。不要使用工具，不要修改文件。'];
    const child = spawn(config.cli, args, { env: config.env, cwd: os.tmpdir(), shell: false, windowsHide: true });
    let out = '', settled = false, killTimer;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const stop = message => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
      killTimer.unref?.(); finish(new Error(message));
    };
    const abort = () => stop('已停止');
    const timer = setTimeout(() => stop('生成超时，请稍后重试或在设置中增加等待时间。'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { out += data; if (out.length > 4_000_000) stop('回答过长，已停止。'); });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new Error('无法启动 Claudian 配置的 Claude 程序，请检查路径和执行权限。')));
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(killTimer);
      if (settled) return;
      let result;
      try { result = JSON.parse(out); } catch { return finish(new Error(`Claude 返回异常（退出码 ${code}），请在 Claudian 中检查登录和模型配置。`)); }
      if (code !== 0 || result.is_error) return finish(new Error(String(result.result || result.errors?.join('\n') || `Claude 请求失败（${code}）`).slice(0, 800)));
      if (typeof result.result !== 'string' || !result.result.trim()) return finish(new Error('Claude 未返回答案，已保留原内容。'));
      finish(null, result.result.trim());
    });
    child.stdin.end(prompt);
  });
}
module.exports = { getConfig, runClaude, parseEnv };
