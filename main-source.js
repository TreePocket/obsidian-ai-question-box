'use strict';
const { Plugin, PluginSettingTab, Setting, Notice, Modal, setIcon } = require('obsidian');
const { parseQuestions, template, ensureIds, patchAnswer, contextWithoutAnswers, buildPrompt } = require('./core');
const { getConfig, runClaude } = require('./bridge');
const { followUpContext, mergeLegacyFollowUps } = require('./follow-up');
const DEFAULTS = { questionBg: '#eef2ff', questionBorder: '#6366f1', answerBg: '#ffffff', answerBorder: '#0d9488', darkQuestionBg: '#242840', darkQuestionBorder: '#a5b4fc', darkAnswerBg: '#172f32', darkAnswerBorder: '#5eead4', timeout: 180, instructions: '使用中文回答，先直接回答问题，再按需要解释、举例；保留必要的英文术语。' };
function foreground(hex) {
  const [r, g, b] = hex.match(/[\da-f]{2}/gi).map(c => parseInt(c, 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return r * .2126 + g * .7152 + b * .0722 > .179 ? '#111111' : '#ffffff';
}
class QuestionModal extends Modal {
  constructor(plugin, editor, file) { super(plugin.app); this.plugin = plugin; this.editor = editor; this.file = file; this.submitted = false; }
  onOpen() {
    this.setTitle('插入 AI 提问框');
    this.contentEl.createEl('p', { text: '输入问题后，点击「插入并生成答案」或按 Cmd/Ctrl + Enter，立即开始生成。答案保存在问题框内部。' });
    this.contentEl.createEl('label', { text: '你的问题', attr: { for: 'aqb-question-input' } });
    const input = this.contentEl.createEl('textarea', { cls: 'aqb-question-input', attr: { id: 'aqb-question-input', rows: '5', placeholder: '例如：请结合上文，解释这个概念并举例。' } });
    input.value = this.editor.getSelection();
    const row = this.contentEl.createDiv({ cls: 'aqb-actions' });
    row.createEl('button', { text: '取消' }).onclick = () => this.close();
    const insert = row.createEl('button', { text: '仅插入' });
    const generate = row.createEl('button', { text: '插入并生成答案', cls: 'mod-cta' });
    const submit = answerNow => {
      if (this.submitted) return;
      if (!input.value.trim()) { new Notice('请先输入问题。'); input.focus(); return; }
      const sourceStillOpen = this.app.workspace.getLeavesOfType('markdown').some(l => l.view.editor === this.editor && l.view.file === this.file);
      if (!sourceStillOpen) { new Notice('原文档已关闭或切换，请重新打开原文档后插入。'); return; }
      if (answerNow && this.plugin.job) { new Notice('已有任务正在生成，请等待完成，或选择「仅插入」。'); return; }
      this.submitted = true;
      const id = this.plugin.insert(this.editor, input.value.trim());
      this.close();
      if (answerNow) void this.plugin.run(this.file, true, id);
    };
    insert.onclick = () => submit(false);
    generate.onclick = () => submit(true);
    input.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(true); } });
    input.focus();
  }
  onClose() { this.contentEl.empty(); }
}
class ProgressModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  onOpen() { this.draw(); }
  draw() {
    this.setTitle('文档提问 · 生成进度'); this.contentEl.empty();
    const report = this.plugin.report;
    this.contentEl.createEl('p', { text: report?.summary || '尚未开始', attr: { role: 'status', 'aria-live': 'polite' } });
    for (const item of report?.items || []) {
      const row = this.contentEl.createDiv({ cls: 'aqb-report-item' });
      row.createEl('strong', { text: `${item.status} · ${item.question.slice(0, 90)}` });
      if (item.error) row.createEl('p', { text: item.error });
      if (item.answer && item.status !== '已完成') new Setting(row).setName('答案未写回，可手动保存').addButton(b => b.setButtonText('复制生成的答案').onClick(() => { navigator.clipboard.writeText(item.answer).then(() => new Notice('已复制答案。')).catch(() => new Notice('复制失败。')); }));
    }
    const row = this.contentEl.createDiv({ cls: 'aqb-actions' });
    if (this.plugin.job) row.createEl('button', { text: '停止生成', cls: 'mod-warning' }).onclick = () => this.plugin.stop();
    row.createEl('button', { text: this.plugin.job ? '后台继续' : '关闭' }).onclick = () => this.close();
  }
  onClose() { if (this.plugin.progressModal === this) this.plugin.progressModal = null; this.contentEl.empty(); }
}
class AIQuestionBox extends Plugin {
  async onload() {
    this.settings = { ...DEFAULTS, ...await this.loadData() };
    this.job = null; this.report = null; this.progressModal = null;
    this.foldStates = new Map();
    this.registerEvent(this.app.workspace.on('file-open', file => {
      if (!file) return;
      for (const key of this.foldStates.keys()) if (key.startsWith(file.path + ':')) this.foldStates.delete(key);
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        if (leaf.view.file === file) this.collapseAnswers(leaf.view.containerEl);
      }
    }));
    this.stableViews = require('./stable-view');
    this.registerEditorExtension(this.stableViews.stableExtension(this));
    this.dynamicStyle = document.head.createEl('style'); this.applyColors();
    this.register(() => this.dynamicStyle.remove());
    this.addSettingTab(new QuestionSettings(this.app, this));
    this.addCommand({ id: 'insert-question', name: '插入提问框', editorCallback: (editor, view) => new QuestionModal(this, editor, view.file).open() });
    this.addCommand({ id: 'insert-marker', name: '插入固定提问标记（稍后填写）', editorCallback: editor => this.insert(editor) });
    this.addCommand({ id: 'answer-unanswered', name: '回答当前文档所有未答问题', callback: () => this.runActive(false) });
    this.addCommand({ id: 'answer-all', name: '回答／重新回答当前文档所有问题', callback: () => this.runActive(true) });
    this.addCommand({ id: 'answer-current', name: '回答光标所在的问题', editorCallback: (editor, view) => {
      try { const offset = editor.posToOffset(editor.getCursor()); const b = parseQuestions(editor.getValue()).find(b => offset >= b.start && offset < b.end); if (!b) return void new Notice('请将光标放入提问框。'); void this.run(view.file, true, b.id, b.line); } catch (e) { new Notice(e.message); }
    } });
    this.addCommand({ id: 'stop-generation', name: '停止生成答案', callback: () => this.stop() });
    this.addCommand({ id: 'show-progress', name: '查看最近生成结果', callback: () => this.showProgress() });
    this.addCommand({id:'compact-followups',name:'整理当前文档旧版追问',callback:()=>{
      const file=this.app.workspace.getActiveFile();if(file?.extension==='md')void this.compactFollowUps(file).then(count=>new Notice(`已整理 ${count} 条追问。`)).catch(e=>new Notice(e.message));
    }});
    this.addCommand({ id: 'highlight-text', name: '高亮选中文字（普通正文）', editorCallback: editor => {
      const text = editor.getSelection();
      if (!text) return void new Notice('请先选择文字；问答框内请使用框上的「高亮」按钮。');
      editor.replaceSelection(text.startsWith('==') && text.endsWith('==') ? text.slice(2,-2) : `==${text}==`);
    } });
    this.addRibbonIcon('message-circle-question', 'AI 提问框：回答当前文档未答问题', () => this.runActive(false));
    this.status = this.addStatusBarItem(); this.status.addClass('aqb-status');
    this.status.setText('AI 提问框'); this.status.setAttribute('role', 'button'); this.status.tabIndex = 0;
    this.registerDomEvent(this.status, 'click', () => this.showProgress());
    this.registerDomEvent(this.status, 'keydown', e => { if (e.key === 'Enter' || e.key === ' ') this.showProgress(); });
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      const offset = editor.posToOffset(editor.getCursor());
      const block = parseQuestions(editor.getValue()).find(b => b.answerStart !== null && offset >= b.answerStart && offset < b.end);
      if (block) {
        const from = editor.posToOffset(editor.getCursor('from')), to = editor.posToOffset(editor.getCursor('to'));
        const quote = from >= block.answerStart && to <= block.end ? editor.getSelection().replace(/^ {0,3}> > ?/gm,'').trim() : '';
        menu.addItem(item => item.setTitle('追问').setIcon('corner-down-right').onClick(() => this.stableViews.openFollowUp(this,view.file,block,quote)));
      } else menu.addItem(item => item.setTitle('插入 AI 提问框').setIcon('message-circle-question').onClick(() => new QuestionModal(this, editor, view.file).open()));
      menu.addItem(item => item.setTitle('回答本文未答问题').setIcon('sparkles').onClick(() => this.run(view.file, false)));
    }));
    this.registerMarkdownPostProcessor((el, ctx) => {
      this.makeAnswersCollapsible(el);
      for (const content of el.querySelectorAll('.callout[data-callout="ai-answer"] > .callout-content')) {
        if (!content.textContent.trim() && !content.children.length) content.createEl('p', { text: '等待 AI 回答', cls: 'aqb-placeholder' });
      }
      const boxes = [...el.querySelectorAll('.callout[data-callout="ai-question"]')];
      if (el.matches?.('.callout[data-callout="ai-question"]')) boxes.unshift(el);
      for (const box of boxes) {
        if (box.closest('.aqb-stable-widget')) continue;
        const title = box.querySelector(':scope > .callout-title');
        if (!title || title.querySelector('.aqb-answer-button')) continue;
        const id = box.getAttribute('data-callout-metadata');
        if (!id || !/^[\w-]+$/.test(id)) continue;
        const button = title.createEl('button', { cls: 'aqb-answer-button', text: 'AI 回答', attr: { 'aria-label': '回答这个问题', type: 'button' } });
        button.onclick = e => { e.preventDefault(); e.stopPropagation(); const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath); void this.run(file, true, id); };
        const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
        if (file) void this.read(file).then(text => {
          const block = parseQuestions(text).find(b => b.id === id);
          const question = box.querySelector(':scope > .callout-content');
          const answer = question?.querySelector('.callout[data-callout="ai-answer"] > .callout-content');
          if (block && question && answer) this.stableViews.installControls(this, box, file, block, {question,answer});
          if(block?.thread){
            box.classList.add('aqb-followup-turn');box.querySelector(':scope > .callout-title > .callout-title-inner')?.setText('追问');
            const scope=box.closest('.markdown-preview-view') || box.parentElement;
            const parent=[...scope.querySelectorAll('.callout[data-callout="ai-question"]')].find(p=>p.getAttribute('data-callout-metadata')===block.thread.rootId);
            if(parent && !box.contains(parent))parent.querySelector(':scope > .callout-content')?.append(box);
          }
        }).catch(() => {});
      }
    });
    this.app.workspace.onLayoutReady(() => {
      if (this.dynamicStyle.isConnected) this.app.workspace.iterateAllLeaves(leaf => this.makeAnswersCollapsible(leaf.view.containerEl));
    });
  }
  makeAnswersCollapsible(el) {
    const answers = [...el.querySelectorAll('.callout[data-callout="ai-answer"]')];
    if (el.matches?.('.callout[data-callout="ai-answer"]')) answers.unshift(el);
    for (const box of answers) {
      const title = box.querySelector(':scope > .callout-title');
      if (!title) continue;
      box.classList.add('aqb-foldable');
      if (title.dataset.aqbFoldReady) continue;
      title.dataset.aqbFoldReady = 'true';
      if (!box.closest('.aqb-stable-widget')) box.classList.add('is-collapsed');
      box.classList.add('is-collapsible', 'aqb-foldable');
      let fold = title.querySelector('.callout-fold');
      if (!fold) { fold = title.createDiv({ cls: 'callout-fold' }); setIcon(fold, 'chevron-down'); }
      title.setAttribute('role', 'button'); title.tabIndex = 0;
      title.setAttribute('aria-label', '展开或收起 AI 答案');
      const sync = () => {
        const collapsed = box.classList.contains('is-collapsed');
        title.setAttribute('aria-expanded', String(!collapsed));
        fold.classList.toggle('is-collapsed', collapsed);
      };
      sync();
      // Own the interaction in capture phase to avoid native keyboard + click double toggles.
      title.addEventListener('click', e => {
        e.preventDefault(); e.stopImmediatePropagation();
        box.classList.toggle('is-collapsed'); sync();
      }, true);
      title.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopImmediatePropagation(); title.click(); }
      }, true);
    }
  }
  collapseAnswers(el) {
    for (const box of el.querySelectorAll('.callout[data-callout="ai-answer"]')) {
      box.classList.add('is-collapsed');
      const title = box.querySelector(':scope > .callout-title');
      title?.setAttribute('aria-expanded', 'false');
      title?.querySelector('.callout-fold')?.classList.add('is-collapsed');
    }
  }
  onunload() { this.stop(false); this.progressModal?.close(); }
  applyColors() {
    for (const key of Object.keys(DEFAULTS).filter(k => /Bg|Border/.test(k))) if (!/^#[\da-f]{6}$/i.test(this.settings[key])) this.settings[key] = DEFAULTS[key];
    const vars = dark => ['question', 'answer'].map(type => {
      const prefix = dark ? 'dark' + type[0].toUpperCase() + type.slice(1) : type;
      return `--aqb-${type}-bg:${this.settings[prefix + 'Bg']};--aqb-${type}-border:${this.settings[prefix + 'Border']};--aqb-${type}-text:${foreground(this.settings[prefix + 'Bg'])};`;
    }).join('');
    this.dynamicStyle.textContent = `body{${vars(false)}}body.theme-dark{${vars(true)}}`;
  }
  async saveSettings() { this.applyColors(); await this.saveData(this.settings); }
  insert(editor, question) {
    const from = editor.getCursor('from'), to = editor.getCursor('to');
    const prefix = from.ch ? '\n\n' : (from.line > 0 && editor.getLine(from.line - 1).trim() ? '\n' : '');
    const suffix = '\n';
    const block = template(question);
    const id = parseQuestions(block)[0].id;
    editor.replaceRange(prefix + block + suffix, from, to);
    const line = from.line + (prefix.match(/\n/g) || []).length + 1;
    if (question === undefined) editor.setSelection({ line, ch: 2 }, { line, ch: editor.getLine(line).length });
    else editor.setCursor({ line, ch: 2 });
    editor.focus();
    return id;
  }
  editorFor(file) {
    const views = this.app.workspace.getLeavesOfType('markdown').map(l => l.view).filter(v => v.file === file && v.editor);
    return views.find(v => v.getMode() === 'source')?.editor || null;
  }
  async read(file) { return this.editorFor(file)?.getValue() ?? await this.app.vault.read(file); }
  async update(file, transform) {
    const editor = this.editorFor(file);
    if (editor) {
      const current = editor.getValue(); const next = transform(current);
      if (next === current) return;
      // One minimal transaction preserves unrelated text, cursor mapping and undo history.
      let start = 0; while (start < current.length && start < next.length && current[start] === next[start]) start++;
      let a = current.length, b = next.length; while (a > start && b > start && current[a - 1] === next[b - 1]) { a--; b--; }
      editor.replaceRange(next.slice(start, b), editor.offsetToPos(start), editor.offsetToPos(a));
    } else await this.app.vault.process(file, transform);
  }
  runActive(all) { const file = this.app.workspace.getActiveFile(); return this.run(file, all); }
  async compactFollowUps(file){let count=0;await this.update(file,text=>{const result=mergeLegacyFollowUps(text);count=result.count;return result.text;});return count;}
  showProgress() { if (!this.progressModal) { this.progressModal = new ProgressModal(this); this.progressModal.open(); } else this.progressModal.draw(); }
  refresh() { this.status.setText(this.report?.summary || 'AI 提问框'); this.progressModal?.draw(); }
  stop(notify = true) { if (this.job) { this.job.abort(); if (notify) new Notice('正在停止；已完成的答案会保留。'); } }
  async run(file, all, onlyId = null, onlyLine = null) {
    if (this.job) { new Notice('已有生成任务正在运行，请等待完成或停止。'); this.showProgress(); return; }
    if (!file || file.extension !== 'md') return void new Notice('请先打开 Markdown 文档。');
    const controller = new AbortController(); this.job = controller;
    try {
      const config = getConfig(this.app);
      if (onlyId && parseQuestions(await this.read(file)).filter(b => b.id === onlyId).length > 1) throw new Error('复制的提问框存在重复标识。请先运行一次「回答当前文档所有未答问题」自动修复标识，再单题回答。');
      await this.update(file, ensureIds);
      const snapshot = await this.read(file);
      const blocks = parseQuestions(snapshot).filter(b => onlyId ? b.id === onlyId : onlyLine !== null ? b.line === onlyLine : all || !b.answer);
      if (!blocks.length) { new Notice('没有需要回答的问题。'); return; }
      const context = contextWithoutAnswers(snapshot);
      if (context.length > 200000) throw new Error('文档超过 20 万字符，请拆分文档后重试。未截断或发送文档。');
      this.report = { summary: `准备回答 ${blocks.length} 个问题 · ${config.model}`, items: blocks.map(b => ({ question: b.question, status: '等待中' })) };
      this.showProgress(); let completed = 0, failed = 0;
      for (let i = 0; i < blocks.length; i++) {
        if (controller.signal.aborted) break;
        const expected = blocks[i], item = this.report.items[i];
        item.status = '生成中'; this.report.summary = `AI 回答 ${i + 1}/${blocks.length} · ${config.model}`; this.refresh();
        try {
          if (!expected.question.trim() || expected.question === '在这里输入你的问题') throw new Error('请先填写问题。');
          patchAnswer(await this.read(file), expected, '预检');
          const scopedContext=followUpContext(context,expected,parseQuestions(await this.read(file)));
          if(scopedContext.length>250000)throw new Error('追问上下文过长，请缩短文档或引用内容后再试。');
          item.answer = await runClaude(config, buildPrompt(scopedContext, expected.question, this.settings.instructions), { signal: controller.signal, timeoutMs: Math.max(30, Math.min(900, Number(this.settings.timeout) || 180)) * 1000 });
          if (controller.signal.aborted) { item.status = '已停止'; break; }
          await this.update(file, current => { const patch = patchAnswer(current, expected, item.answer); return current.slice(0, patch.start) + patch.replacement + current.slice(patch.end); });
          item.status = '已完成'; completed++;
        } catch (error) {
          if (controller.signal.aborted) { item.status = '已停止'; break; }
          item.status = '未写回'; item.error = error.message; failed++;
        }
      }
      for (const item of this.report.items) if (item.status === '等待中') item.status = '未执行';
      this.report.summary = `${controller.signal.aborted ? '已停止' : '已结束'}：${completed} 个完成，${failed} 个失败`;
      new Notice(this.report.summary, 7000);
    } catch (e) { new Notice(e.message, 9000); }
    finally { this.job = null; this.refresh(); }
  }
}
class QuestionSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl: el } = this; el.empty();
    el.createEl('h2', { text: 'AI 提问框' });
    el.createEl('p', { text: '复用 Claudian 的 Claude 路径、环境变量、登录和所选 Claude 模型。当前文档作为上下文逐题发送，答案直接写回文档。此版本接入 Claude，不接入 Claudian 的其他提供商。' });
    try { const c = getConfig(this.app); el.createEl('p', { text: `已连接 Claudian ${c.version} · 模型 ${c.model}` }); } catch (e) { el.createEl('p', { text: e.message }); }
    for (const [key, name] of [['questionBg','问题框底色'],['questionBorder','问题框边框'],['answerBg','答案框底色'],['answerBorder','答案框边框'],['darkQuestionBg','深色模式 · 问题底色'],['darkQuestionBorder','深色模式 · 问题边框'],['darkAnswerBg','深色模式 · 答案底色'],['darkAnswerBorder','深色模式 · 答案边框']]) {
      new Setting(el).setName(name).addColorPicker(c => c.setValue(this.plugin.settings[key]).onChange(async value => { this.plugin.settings[key] = value; await this.plugin.saveSettings(); }));
    }
    el.createEl('p', { text: '正文颜色随底色自动选择黑色或白色，保持清晰可读。下方预览会即时更新。' });
    const preview = el.createDiv({ cls: 'callout aqb-preview', attr: { 'data-callout': 'ai-question' } });
    preview.createEl('strong', { text: '提问' }); preview.createEl('p', { text: '为什么问题和答案使用嵌套框？' });
    const answer = preview.createDiv({ cls: 'callout', attr: { 'data-callout': 'ai-answer' } });
    answer.createEl('strong', { text: 'AI 答案' }); answer.createEl('p', { text: '答案始终留在对应的问题内部，阅读、复习和导出时都能保留上下文。' });
    new Setting(el).setName('回答要求').setDesc('所有问题通用，例如回答语言、解释深度和举例要求。').addTextArea(t => t.setValue(this.plugin.settings.instructions).onChange(async v => { this.plugin.settings.instructions = v; await this.plugin.saveSettings(); }));
    new Setting(el).setName('每题最长等待时间（秒）').setDesc('30–900 秒，默认 180 秒。').addText(t => t.setValue(String(this.plugin.settings.timeout)).onChange(async v => { if (/^\d+$/.test(v) && +v >= 30 && +v <= 900) { this.plugin.settings.timeout = +v; await this.plugin.saveSettings(); } }));
    new Setting(el).setName('恢复默认颜色').addButton(b => b.setButtonText('恢复颜色').onClick(async () => { for (const k of Object.keys(DEFAULTS).filter(k => /Bg|Border/.test(k))) this.plugin.settings[k] = DEFAULTS[k]; await this.plugin.saveSettings(); this.display(); }));
  }
}
module.exports = AIQuestionBox;
