'use strict';
const { createHash, randomUUID } = require('crypto');
const META = /^\s*<!-- aqb-highlights:([A-Za-z0-9_-]+) -->\s*$/;
const THREAD = /^\s*<!-- aqb-thread:([A-Za-z0-9_-]+) -->\s*$/;
function decodeAnnotations(body) {
  const line = body.find(l => META.test(l));
  if (!line) return [];
  try {
    const list = JSON.parse(Buffer.from(line.match(META)[1], 'base64url').toString('utf8'));
    return Array.isArray(list) ? list.filter(a => a && ['question','answer'].includes(a.section) && typeof a.quote === 'string' && a.quote.length <= 50000 && typeof a.source === 'string' && typeof a.prefix === 'string' && typeof a.suffix === 'string').slice(0, 200) : [];
  } catch { return []; }
}
function withoutMetadata(lines) { return lines.filter(l => !META.test(l) && !THREAD.test(l)); }
function decodeThread(body) {
  const line=body.find(l=>THREAD.test(l));if(!line)return null;
  try {const value=JSON.parse(Buffer.from(line.match(THREAD)[1],'base64url').toString('utf8'));return value && typeof value.rootId==='string' && typeof value.replyToId==='string' && typeof value.quote==='string' ? value : null;}catch{return null;}
}
function withThread(raw,thread) {
  const eol=raw.includes('\r\n')?'\r\n':'\n';
  const lines=raw.split(/\r?\n/).filter(l=>!THREAD.test(l.replace(/^ {0,3}> ?/,'')));
  if(thread)lines.splice(1,0,'> <!-- aqb-thread:'+Buffer.from(JSON.stringify(thread)).toString('base64url')+' -->');
  return lines.join(eol);
}
function hash(text) { return createHash('sha256').update(text).digest('hex'); }
function withAnnotations(raw, annotations) {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/).filter(l => !META.test(l.replace(/^ {0,3}> ?/, '')));
  if (annotations.length) lines.splice(1, 0, '> <!-- aqb-highlights:' + Buffer.from(JSON.stringify(annotations)).toString('base64url') + ' -->');
  return lines.join(eol);
}
function anchorFor(text, start, end, section, source) {
  return { id: randomUUID(), section, source: hash(source), quote: text.slice(start, end), prefix: text.slice(Math.max(0, start - 48), start), suffix: text.slice(end, end + 48) };
}
function locate(text, anchor) {
  const matches = []; let at = 0;
  while (anchor.quote && (at = text.indexOf(anchor.quote, at)) >= 0) {
    const end = at + anchor.quote.length;
    if ((!anchor.prefix || text.slice(0, at).endsWith(anchor.prefix)) && (!anchor.suffix || text.slice(end).startsWith(anchor.suffix))) matches.push({ start: at, end });
    at++;
  }
  return matches.length === 1 ? matches[0] : null;
}
module.exports = { decodeAnnotations, withoutMetadata, withAnnotations, hash, anchorFor, locate, decodeThread, withThread };
