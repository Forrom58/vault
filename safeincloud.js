// safeincloud.js — legge un database SafeInCloud (.db, formato 1) e lo converte in voci di Vault.
// Tutto avviene nel browser: il file e la password non lasciano il dispositivo.
// Formato ricostruito dai progetti open source evilsocket/SafeInCloud e
// mxschmitt/golang-safe-in-cloud (verificato sul loro file di prova reale):
//   u16 magic | u8 versione | [salt] [iv] [salt2] [blocco]   ([x] = 1 byte di lunghezza + dati)
//   chiave1 = PBKDF2-SHA1(password, salt, 10000, 32 byte)
//   blocco  --AES-256-CBC(chiave1, iv)-->  [iv2] [chiave2] [controllo]
//   controllo = PBKDF2-SHA1(chiave2, salt2, 1000, 32 byte)   (verifica della password)
//   resto del file --AES-256-CBC(chiave2, iv2)--> zlib --> XML (<database><card>...)
(function(){
  'use strict';
  const subtle = crypto.subtle;

  function reader(bytes){
    let p = 0;
    return {
      byte(){ if (p >= bytes.length) throw new Error('FORMATO'); return bytes[p++]; },
      array(){ const n = this.byte(); if (p + n > bytes.length) throw new Error('FORMATO'); const a = bytes.slice(p, p + n); p += n; return a; },
      rest(){ return bytes.slice(p); }
    };
  }
  async function pbkdf2(secretBytes, salt, iterations){
    const base = await subtle.importKey('raw', secretBytes, 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-1', salt, iterations }, base, 256));
  }
  async function aesCbc(keyBytes, iv, data){
    const key = await subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['decrypt']);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, key, data));
  }
  function same(a, b){
    if (a.length !== b.length) return false;
    let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }
  async function inflateZlib(bytes){
    if (typeof DecompressionStream === 'undefined') throw new Error('BROWSER');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Restituisce il testo XML. Errori: 'FORMATO' (non è un .db SafeInCloud leggibile),
  // 'PASSWORD' (password errata), 'BROWSER' (browser troppo vecchio).
  async function decryptDb(arrayBuffer, password){
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 40) throw new Error('FORMATO');
    const r = reader(bytes);
    const magic = r.byte() | (r.byte() << 8);
    r.byte(); // versione
    if (magic !== 0x0505) throw new Error('FORMATO');
    const salt = r.array(), iv = r.array(), salt2 = r.array(), block = r.array();
    if (iv.length !== 16 || block.length === 0 || block.length % 16) throw new Error('FORMATO');
    const k1 = await pbkdf2(new TextEncoder().encode(password), salt, 10000);
    let inner;
    try { inner = await aesCbc(k1, iv, block); } catch (e) { throw new Error('PASSWORD'); }
    let iv2, k2, check;
    try { const ri = reader(inner); iv2 = ri.array(); k2 = ri.array(); check = ri.array(); }
    catch (e) { throw new Error('PASSWORD'); }
    if (iv2.length !== 16 || k2.length !== 32 || check.length !== 32) throw new Error('PASSWORD');
    if (!same(await pbkdf2(k2, salt2, 1000), check)) throw new Error('PASSWORD');
    let body;
    try { body = await aesCbc(k2, iv2, r.rest()); } catch (e) { throw new Error('FORMATO'); }
    let xmlBytes;
    try { xmlBytes = await inflateZlib(body); } catch (e) { throw new Error(e.message === 'BROWSER' ? 'BROWSER' : 'FORMATO'); }
    return new TextDecoder('utf-8').decode(xmlBytes).replace(/^﻿/, '');
  }

  const SECRET_TYPES = ['password', 'pin', 'one_time_password', 'secret'];
  const oneLine = s => String(s || '').replace(/\r\n|\r|\n/g, ' ').trim();

  // Converte l'XML in voci di Vault: { entries, skippedEmpty, attachments, total, templates, deleted }
  function parseXml(xmlText){
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length || !doc.documentElement || doc.documentElement.nodeName !== 'database'){
      throw new Error('FORMATO');
    }
    const root = doc.documentElement;
    const labels = {};
    Array.from(root.children).forEach(el => { if (el.nodeName === 'label') labels[el.getAttribute('id')] = el.getAttribute('name') || ''; });
    const entries = [];
    let skippedEmpty = 0, attachments = 0, total = 0, templates = 0, deleted = 0;
    Array.from(root.children).forEach(card => {
      if (card.nodeName !== 'card') return;
      total++;
      if (card.getAttribute('template') === 'true'){ templates++; return; }
      if (card.getAttribute('deleted') === 'true'){ deleted++; return; }
      const kids = Array.from(card.children);
      const fieldEls = kids.filter(k => k.nodeName === 'field');
      const notesEl = kids.find(k => k.nodeName === 'notes');
      attachments += kids.filter(k => k.nodeName === 'file').length;
      const fields = fieldEls.map(f => ({
        name: oneLine(f.getAttribute('name')) || 'Campo',
        type: (f.getAttribute('type') || '').toLowerCase(),
        value: oneLine(f.textContent)
      })).filter(f => f.value !== '');
      const login = fields.find(f => f.type === 'login');
      const pass = fields.find(f => f.type === 'password');
      const extra = fields.filter(f => f !== login && f !== pass)
        .map(f => ({ name: f.name, value: f.value, secret: SECRET_TYPES.indexOf(f.type) !== -1 }));
      const labelNames = kids.filter(k => k.nodeName === 'label_id')
        .map(k => labels[(k.textContent || '').trim()]).filter(Boolean);
      if (labelNames.length) extra.push({ name: 'Etichette', value: labelNames.join(', '), secret: false });
      const title = oneLine(card.getAttribute('title'));
      const notes = notesEl ? String(notesEl.textContent || '').replace(/\r\n?/g, '\n').trim() : '';
      if (!title && !login && !pass && !notes && !extra.length){ skippedEmpty++; return; }
      entries.push({
        site: title || 'Senza titolo',
        user: login ? login.value : '',
        pass: pass ? pass.value : '',
        notes,
        fields: extra
      });
    });
    return { entries, skippedEmpty, attachments, total, templates, deleted };
  }

  async function importDb(arrayBuffer, password){
    return parseXml(await decryptDb(arrayBuffer, password));
  }

  window.SafeInCloud = Object.freeze({ decryptDb, parseXml, importDb });
})();
