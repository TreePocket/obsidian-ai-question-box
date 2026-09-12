'use strict';
const { StateField, Prec, EditorState } = require('@codemirror/state');
const { Decoration, EditorView, WidgetType } = require('@codemirror/view');
const { editorInfoField, editorLivePreviewField, MarkdownRenderer, Component, setIcon, Notice, Modal, Menu } = require('obsidian');
const { parseQuestions, template, patchAnswer } = require('./core');
const { hash, withAnnotations, withThread, anchorFor, locate } = require('./annotations');
const { insertFollowUp } = require('./follow-up');

function currentBlock(text, expected) {
  const candidates = parseQuestions(text).filter(b => expected.id ? b.id === expected.id : b.raw === expected.raw);
  if (candidates.length !== 1 || candidates[0].raw !== expected.raw) throw new Error('这个框已被修改，请重新选择文字或打开编辑后再试。');
  return candidates[0];
}
async function replaceBlock(plugin, file, expected, raw) {
  await plugin.update(file, text => { const b = currentBlock(text, expected); return text.slice(0, b.start) + raw + text.slice(b.end); });
}
function textMap(root) {
  const nodes = [], walker = root.ownerDocument.createTreeWalker(root, 4);
  let node, text = '';
  while ((node = walker.nextNode())) {
    if (!node.data.trim() && (node.parentNode === root || /[\r\n]/.test(node.data))) continue;
    if (node.parentElement.closest('[data-aqb-ui],.callout-title,.aqb-placeholder')) continue;
    const question = node.parentElement.closest('.callout[data-callout="ai-question"]');
    if (question && !question.contains(root)) continue;
    const answer = node.parentElement.closest('.callout[data-callout="ai-answer"]');
    if (answer && !answer.contains(root)) continue;
    nodes.push({ node, start: text.length, end: text.length + node.data.length }); text += node.data;
  }
  return { nodes, text };
}
function pointOffset(map, container, offset) {
  for (const item of map.nodes) {
    if (item.node === container) return item.start + offset;
    const r = item.node.ownerDocument.createRange(); r.selectNodeContents(item.node);
    if (r.comparePoint(container, offset) < 0) return item.start;
  }
  return map.text.length;
}
function paintHighlights(root, annotations, section, source) {
  for (const mark of root.querySelectorAll('mark.aqb-highlight')) mark.replaceWith(...mark.childNodes);
  root.normalize(); const map = textMap(root);
  const ranges = annotations.filter(a => a.section === section && a.source === hash(source)).map(a => locate(map.text, a)).filter(Boolean).sort((a,b) => a.start - b.start);
  const merged = [];
  for (const r of ranges) { const last = merged.at(-1); if (last && r.start <= last.end) last.end = Math.max(last.end, r.end); else merged.push({ ...r }); }
  for (const r of merged.reverse()) for (const item of [...map.nodes].reverse()) {
    const start = Math.max(r.start, item.start) - item.start, end = Math.min(r.end, item.end) - item.start;
    if (end <= start) continue;
    const n = item.node;
    if (end < n.length) n.splitText(end);
    const selected = start ? n.splitText(start) : n;
    const mark = root.ownerDocument.createElement('mark'); mark.className = 'aqb-highlight';
    selected.replaceWith(mark); mark.append(selected);
  }
}
function installControls(plugin, box, file, expected, roots) {
  const title = box.querySelector(':scope > .callout-title');
  if (!title || title.querySelector('.aqb-tools')) return;
  box.querySelector(':scope > .callout-title > .aqb-answer-button')?.remove();
  const tools = title.createDiv({ cls: 'aqb-tools', attr: { 'data-aqb-ui': 'true' } });
  let savedSelection = null, busy = false;
  const capture = () => {
    const selection = box.ownerDocument.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const startElement=range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement;
    const endElement=range.endContainer.nodeType===1?range.endContainer:range.endContainer.parentElement;
    if(startElement.closest('.callout[data-callout="ai-question"]')!==box || endElement.closest('.callout[data-callout="ai-question"]')!==box){savedSelection=null;return;}
    for (const [section, root] of Object.entries(roots)) {
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) continue;
      if (section === 'question' && (range.startContainer.parentElement?.closest('[data-callout="ai-answer"]') || range.endContainer.parentElement?.closest('[data-callout="ai-answer"]'))) continue;
      const map = textMap(root), start = pointOffset(map, range.startContainer, range.startOffset), end = pointOffset(map, range.endContainer, range.endOffset);
      if (end > start && map.text.slice(start,end).trim()) { savedSelection = { section, start, end, text: map.text }; return; }
    }
    savedSelection = null;
  };
  box.addEventListener('mouseup', capture); box.addEventListener('keyup', capture);
  const button = (label, fn) => {
    const b = tools.createEl('button', { text: label, attr: { type:'button' } });
    b.addEventListener('mousedown', e => { capture(); e.preventDefault(); e.stopPropagation(); });
    b.onclick = e => { e.preventDefault(); e.stopPropagation(); fn(); }; return b;
  };
  const highlight = async remove => {
    if (busy) return;
    capture(); const selected = savedSelection;
    if (!selected) return void new Notice('请先在问题或答案中选中文字，再点击高亮。');
    if (selected.end - selected.start > 50000) return void new Notice('单次高亮请控制在 5 万字符以内。');
    busy = true;
    try {
      let list = (expected.annotations || []).filter(a => a.source === hash(expected[a.section]));
      if (remove) list = list.filter(a => {
        if (a.section !== selected.section) return true;
        const r = locate(selected.text, a); return !r || r.end <= selected.start || r.start >= selected.end;
      });
      else {
        if (list.length >= 200) throw new Error('每个问答框最多保存 200 处高亮。');
        list.push(anchorFor(selected.text, selected.start, selected.end, selected.section, expected[selected.section]));
      }
      const raw = withAnnotations(expected.raw, list);
      await replaceBlock(plugin, file, expected, raw);
      expected = { ...expected, raw, annotations: list };
      for (const [section, root] of Object.entries(roots)) paintHighlights(root, list, section, expected[section]);
      box.ownerDocument.getSelection()?.removeAllRanges(); savedSelection = null;
      new Notice(remove ? '已取消所选区域的高亮。' : '已高亮，标记已保存到文档。');
    } catch (e) { new Notice(e.message); } finally { busy = false; }
  };
  button('高亮', () => void highlight(false));
  button('取消高亮', () => void highlight(true));
  button('追问', () => {
    capture();
    if (!savedSelection || savedSelection.section !== 'answer') return void new Notice('请先选中答案中有疑惑的文字，再点击「追问」。');
    const quote = savedSelection.text.slice(savedSelection.start,savedSelection.end).trim();
    openFollowUp(plugin,file,expected,quote);
  });
  box.addEventListener('contextmenu', event => {
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    if (target?.closest('.callout[data-callout="ai-question"]') !== box ||
        target.closest('.callout[data-callout="ai-answer"]') !== roots.answer.closest('.callout[data-callout="ai-answer"]')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    // A right click without an active selection must not reuse an earlier quote.
    savedSelection = null; capture();
    const selected = savedSelection?.section === 'answer' ? savedSelection : null;
    const quote = selected ? selected.text.slice(selected.start, selected.end).trim() : '';
    const menu = new Menu();
    menu.addItem(item => item.setTitle('追问').setIcon('corner-down-right').onClick(() => openFollowUp(plugin,file,expected,quote)));
    if (quote) {
      menu.addSeparator();
      menu.addItem(item => item.setTitle('复制').setIcon('copy').onClick(() => {
        void box.ownerDocument.defaultView.navigator.clipboard.writeText(quote).catch(() => new Notice('复制失败，请使用 Cmd/Ctrl + C。'));
      }));
      menu.addItem(item => item.setTitle('高亮').setIcon('highlighter').onClick(() => { savedSelection=selected; void highlight(false); }));
      menu.addItem(item => item.setTitle('取消高亮').setIcon('eraser').onClick(() => { savedSelection=selected; void highlight(true); }));
    }
    menu.showAtMouseEvent(event);
  }, true);
  button('编辑', () => new EditBoxModal(plugin, file, expected).open());
  button('AI 回答', () => void plugin.run(file, true, expected.id, expected.line));
  for (const [section, root] of Object.entries(roots)) paintHighlights(root, expected.annotations || [], section, expected[section]);
}
function openFollowUp(plugin,file,block,quote='') {
  if (!block.answer.trim()) return void new Notice('请先生成答案，再进行追问。');
  if (quote.length > 10000) return void new Notice('一次追问请引用不超过 1 万字符。');
  new FollowUpModal(plugin,file,block,quote).open();
}
class FollowUpModal extends Modal {
  constructor(plugin,file,block,quote) { super(plugin.app); this.plugin=plugin;this.file=file;this.block=block;this.quote=quote; }
  onOpen() {
    this.setTitle(this.quote ? '针对选中内容追问' : '针对这条答案追问');
    if (this.quote) {
      this.contentEl.createEl('p',{text:'引用的回答'});
      this.contentEl.createEl('blockquote',{cls:'aqb-followup-quote',text:this.quote});
    } else this.contentEl.createEl('p',{text:'AI 会结合这条答案和之前的问答来回答你的疑问。'});
    this.contentEl.createEl('label',{text:'你的疑问',attr:{for:'aqb-followup-input'}});
    const input=this.contentEl.createEl('textarea',{cls:'aqb-question-input',attr:{id:'aqb-followup-input',rows:'4',placeholder:'例如：为什么会这样？能换一个简单的例子解释吗？'}});
    const row=this.contentEl.createDiv({cls:'aqb-actions'});row.createEl('button',{text:'取消'}).onclick=()=>this.close();
    const button=row.createEl('button',{text:'提交追问并生成答案',cls:'mod-cta'});
    let submitted=false;
    const submit=async()=>{
      if(submitted)return;
      if(!input.value.trim())return void new Notice('请写下你的疑问。');
      if(this.plugin.job)return void new Notice('已有答案正在生成，请等待完成后再追问。');
      submitted=true;button.disabled=true;
      try {
        let id;
        await this.plugin.update(this.file,current=>{const next=insertFollowUp(current,this.block,input.value,this.quote);id=next.id;return next.text;});
        this.close();void this.plugin.run(this.file,true,id);
      } catch(e) {new Notice(e.message);submitted=false;button.disabled=false;}
    };
    button.onclick=submit;
    input.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'&&!e.isComposing){e.preventDefault();void submit();}});
    input.focus();
  }
  onClose(){this.contentEl.empty();}
}
class EditBoxModal extends Modal {
  constructor(plugin, file, block) { super(plugin.app); this.plugin = plugin; this.file = file; this.block = block; }
  onOpen() {
    this.setTitle('编辑问答框');
    this.contentEl.createEl('label', { text: '问题', attr:{for:'aqb-edit-question'} });
    const question = this.contentEl.createEl('textarea', { cls:'aqb-question-input', attr:{id:'aqb-edit-question',rows:'4'} }); question.value = this.block.question;
    this.contentEl.createEl('label', { text:'答案（支持 Markdown）', attr:{for:'aqb-edit-answer'} });
    const answer = this.contentEl.createEl('textarea', { cls:'aqb-question-input', attr:{id:'aqb-edit-answer',rows:'8'} }); answer.value = this.block.answer;
    const row = this.contentEl.createDiv({cls:'aqb-actions'});
    row.createEl('button',{text:'取消'}).onclick = () => this.close();
    const save = row.createEl('button',{text:'保存',cls:'mod-cta'});
    save.onclick = async () => {
      if (!question.value.trim()) return void new Notice('问题不能为空。');
      save.disabled = true;
      try {
        let raw = template(question.value.trim(), this.block.id || undefined);
        if (/> > \[!ai-answer\]\+/.test(this.block.raw)) raw = raw.replace('[!ai-answer]-','[!ai-answer]+');
        if (answer.value.trim()) raw = patchAnswer(raw, parseQuestions(raw)[0], answer.value.trim()).replacement;
        const list = (this.block.annotations || []).filter(a => a.source === hash(a.section === 'question' ? question.value.trim() : answer.value.trim()));
        raw = withAnnotations(withThread(raw,this.block.thread), list);
        if (!this.block.raw.endsWith('\n')) raw = raw.trimEnd();
        if (this.block.raw.includes('\r\n')) raw = raw.replace(/\n/g,'\r\n');
        await replaceBlock(this.plugin, this.file, this.block, raw); this.close();
      } catch(e) { new Notice(e.message); save.disabled = false; }
    };
    question.focus();
  }
  onClose() { this.contentEl.empty(); }
}
function stableExtension(plugin) {
  const renderCache = new WeakMap();
  class BoxWidget extends WidgetType {
    constructor(block, file) { super(); this.block = block; this.file = file; }
    eq(other) { return this.block.raw === other.block.raw && this.file === other.file; }
    ignoreEvent() { return true; }
    toDOM(view) {
      const host = view.dom.ownerDocument.createElement('div'); host.className = 'aqb-stable-widget markdown-rendered'; host.contentEditable = 'false'; host.dataset.aqbFile = this.file?.path || '';
      const component = new Component(); component.load(); host.aqbComponent = component;
      const box = host.createDiv({cls:'callout aqb-stable-box'+(this.block.thread?' aqb-followup-turn':''),attr:{'data-callout':'ai-question','data-callout-metadata':this.block.id || ''}});
      const title = box.createDiv({cls:'callout-title'}); setIcon(title.createDiv({cls:'callout-icon'}),this.block.thread?'corner-down-right':'message-circle-question');title.createDiv({cls:'callout-title-inner',text:this.block.thread?'追问':'提问'});
      const content = box.createDiv({cls:'callout-content'}), q = content.createDiv({cls:'aqb-question-body'});
      const answer = content.createDiv({cls:'callout',attr:{'data-callout':'ai-answer'}});
      const key = `${this.file?.path}:${this.block.id || this.block.line}`;
      const collapsed = plugin.foldStates.has(key) ? plugin.foldStates.get(key) : true;
      if (collapsed) answer.classList.add('is-collapsed');
      const at = answer.createDiv({cls:'callout-title'}); setIcon(at.createDiv({cls:'callout-icon'}),'sparkles');at.createDiv({cls:'callout-title-inner',text:'AI 答案'});
      const a = answer.createDiv({cls:'callout-content'});
      plugin.makeAnswersCollapsible(host);
      // Store after our captured toggle; no editor event should take over a text selection.
      const observer = new MutationObserver(() => { plugin.foldStates.set(key, answer.classList.contains('is-collapsed')); view.requestMeasure(); });
      observer.observe(answer,{attributes:true,attributeFilter:['class']}); host.aqbObserver = observer;
      Promise.all([
        MarkdownRenderer.render(plugin.app, this.block.question, q, this.file?.path || '', component),
        this.block.answer ? MarkdownRenderer.render(plugin.app, this.block.answer, a, this.file?.path || '', component) : Promise.resolve(a.createEl('p',{text:'等待 AI 回答',cls:'aqb-placeholder'}))
      ]).then(() => {
        if (host.aqbDestroyed) return;
        installControls(plugin, box, this.file, this.block, { question:q, answer:a }); view.requestMeasure();
      }).catch(e => { a.createEl('p',{text:'显示失败：'+e.message}); });
      return host;
    }
    destroy(dom) { dom.aqbDestroyed = true; dom.aqbObserver?.disconnect(); dom.aqbComponent?.unload(); }
  }
  class GroupWidget extends WidgetType {
    constructor(blocks,file) { super();this.blocks=blocks;this.file=file; }
    eq(other) { return this.file===other.file && this.blocks.length===other.blocks.length && this.blocks.every((b,i)=>b.raw===other.blocks[i].raw); }
    ignoreEvent(){return true;}
    toDOM(view) {
      const host=view.dom.ownerDocument.createElement('div');host.className='aqb-stable-group';host.contentEditable='false';host.aqbChildren=[];
      const roots=new Map();
      for(const block of this.blocks){
        const widget=new BoxWidget(block,this.file),dom=widget.toDOM(view);
        const parent=block.thread && roots.get(block.thread.rootId);
        if(parent)parent.querySelector(':scope > .callout > .callout-content').append(dom);else host.append(dom);
        roots.set(block.id,dom);host.aqbChildren.push({widget,dom});
      }
      return host;
    }
    destroy(host){for(const {widget,dom} of host.aqbChildren || [])widget.destroy(dom);}
  }
  const build = state => {
    if (!state.field(editorLivePreviewField, false)) return Decoration.none;
    const file = state.field(editorInfoField, false)?.file; if (!file) return Decoration.none;
    const cached = renderCache.get(state.doc);
    if (cached?.file === file && cached.path === file.path) return cached.decorations;
    try {
      const blocks = parseQuestions(state.doc.toString());
      const groups=[];
      for(const b of blocks){
        const from=b.start>0 && state.doc.sliceString(b.start-1,b.start)==='\n' ? b.start-1 : b.start;
        const last=groups.at(-1);
        if(last && !state.doc.sliceString(last.to,b.start).trim()){last.blocks.push(b);last.to=b.end;}else groups.push({from,to:b.end,blocks:[b]});
      }
      const decorations = Decoration.set(groups.map(g=>Decoration.replace({widget:new GroupWidget(g.blocks,file),block:true,inclusive:true}).range(g.from,g.to)),true);
      renderCache.set(state.doc,{file,path:file.path,decorations}); return decorations;
    } catch (e) { plugin.lastStableRenderError = e.message; return Decoration.none; }
  };
  const field = StateField.define({ create:build, update(value,tr) {
    return build(tr.state);
  }, provide: f => EditorView.decorations.from(f) });
  // Skip hidden source on cursor motion, but don't let a single backspace erase a whole answer.
  plugin.stableField = field;
  return [Prec.highest(field), EditorView.atomicRanges.of(view => view.state.field(field)),
    EditorState.transactionFilter.of(tr=>{
      if(!tr.isUserEvent('delete') || !tr.startState.selection.main.empty || !tr.startState.field(editorLivePreviewField,false))return tr;
      let blocked=false;
      tr.changes.iterChangedRanges((from,to)=>{tr.startState.field(field).between(from,to,(a,b)=>{if(to>from && from<b && to>a)blocked=true;});});
      if(blocked){new Notice('为避免误删整段答案，请通过「编辑」修改框内内容；删除整个框可切换到源码模式。');return [];}
      return tr;
    }),
    Prec.highest(EditorView.domEventHandlers({copy(event,view){
      const selection=view.dom.ownerDocument.getSelection();
      const node=selection?.anchorNode;const host=(node?.nodeType===1?node:node?.parentElement)?.closest?.('.aqb-stable-widget');
      if(!selection?.isCollapsed && host && view.dom.contains(host) && host.contains(selection.focusNode)){
        event.clipboardData?.setData('text/plain',selection.toString());event.preventDefault();return true;
      }
      return false;
    }}))
  ];
}
function diagnose(state) { return { live:state.field(editorLivePreviewField,false), file:state.field(editorInfoField,false)?.file?.path }; }
module.exports = { stableExtension, installControls, currentBlock, textMap, paintHighlights, diagnose, openFollowUp };
