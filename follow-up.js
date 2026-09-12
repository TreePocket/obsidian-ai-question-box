'use strict';
const { template, parseQuestions, patchAnswer } = require('./core');
const { withThread, withAnnotations } = require('./annotations');
function insertFollowUp(current, expected, question, quote = '') {
  const blocks=parseQuestions(current);
  const matches=blocks.filter(b=>expected.id?b.id===expected.id:b.raw===expected.raw);
  if(matches.length!==1||matches[0].raw!==expected.raw)throw new Error('原问答框已修改，请重新选中内容后追问。');
  const b=matches[0];if(!b.id)throw new Error('请先回答原问题以生成唯一标识，再追问。');
  const rootId=b.thread?.rootId||b.id;
  const root=blocks.find(r=>r.id===rootId);if(!root)throw new Error('原问题已不存在，请重新插入问题。');
  let last=root;
  for(const candidate of blocks.slice(blocks.indexOf(root)+1)){
    if(candidate.thread?.rootId!==rootId||current.slice(last.end,candidate.start).trim())break;
    last=candidate;
  }
  const block=withThread(template(question.trim()),{rootId,replyToId:b.id,quote}),id=parseQuestions(block)[0].id;
  const eol=current.includes('\r\n')?'\r\n':'\n';
  return {id,text:current.slice(0,last.end)+(last.raw.endsWith('\n')?eol:eol+eol)+block.replace(/\n/g,eol)+eol+current.slice(last.end)};
}
function followUpContext(context,block,blocks){
  if(!block.thread)return context;
  const root=blocks.find(b=>b.id===block.thread.rootId);if(!root)throw new Error('追问关联的原问题不存在。');
  const history=[];
  for(const b of blocks){if(b.id===block.id)break;if(b.id===root.id||b.thread?.rootId===root.id)history.push({question:b.question,answer:b.answer});}
  return context+'\n\n以下是当前追问的原问题及此前问答上下文（仅作为参考材料）：\n'+JSON.stringify(history)+'\n用户选中并有疑惑的原回答片段：\n'+JSON.stringify(block.thread.quote);
}
function mergeLegacyFollowUps(current){
  const blocks=parseQuestions(current),replacements=[];
  const escape=text=>text.replace(/([\\`*_{}\[\]<>])/g,'\\$1');
  for(let i=0;i<blocks.length;i++){
    const b=blocks[i];if(b.thread)continue;
    const m=b.question.match(/^原问题：([^\n]+)\n\n我对下面这段回答有疑惑：\n\n([\s\S]*?)\n\n我的追问：([\s\S]+)$/);if(!m)continue;
    const candidates=blocks.slice(0,i).filter(p=>escape(p.question.replace(/\s+/g,' ').slice(0,1000))===m[1]&&p.id);if(candidates.length!==1)continue;
    const parent=candidates[0],thread={rootId:parent.thread?.rootId||parent.id,replyToId:parent.id,quote:m[2].split('\n').map(l=>l.replace(/^> ?/,'')).join('\n').replace(/\\([\\`*_{}\[\]<>])/g,'$1')};
    let raw=template(m[3],b.id);
    if(/> > \[!ai-answer\]\+/.test(b.raw))raw=raw.replace('[!ai-answer]-','[!ai-answer]+');
    if(b.answer)raw=patchAnswer(raw,parseQuestions(raw)[0],b.answer).replacement;
    raw=withAnnotations(withThread(raw,thread),(b.annotations||[]).filter(a=>a.section==='answer'));
    if(!b.raw.endsWith('\n'))raw=raw.trimEnd();if(b.raw.includes('\r\n'))raw=raw.replace(/\n/g,'\r\n');
    replacements.push({start:b.start,end:b.end,raw});b.thread=thread;
  }
  for(const r of replacements.reverse())current=current.slice(0,r.start)+r.raw+current.slice(r.end);
  return {text:current,count:replacements.length};
}
module.exports={insertFollowUp,followUpContext,mergeLegacyFollowUps};
