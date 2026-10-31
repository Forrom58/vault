(function(){
  'use strict';

  const $ = id => document.getElementById(id);

  // ---------- state ----------
  let vault = null;              // { entries: [{id, site, user, pass, notes}] }
  let masterPassword = null;
  let coverCanvas = null;        // canvas holding current carrier image pixels
  let pendingImportFile = null;

  // ---------- utility: messages ----------
  // Il testo viene inserito con un breve ritardo dopo aver reso visibile il riquadro:
  // così i lettori di schermo (TalkBack, VoiceOver, NVDA) lo annunciano davvero.
  function showMsg(el, text, type){
    clearTimeout(el._msgTimer);
    el.className = 'msg show ' + type;
    el.setAttribute('aria-live', type === 'err' ? 'assertive' : 'polite');
    el.textContent = '';
    el._msgTimer = setTimeout(() => { el.textContent = text; }, 60);
  }
  function clearMsg(el){
    clearTimeout(el._msgTimer);
    el.className = 'msg';
    el.textContent = '';
  }
  // Annuncio vocale breve senza testo visibile (es. "copiato").
  function announce(text){
    const live = $('srLive');
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 60);
  }

  // ---------- finestre modali accessibili ----------
  // Mentre una finestra è aperta il resto della pagina è "inert" (non raggiungibile
  // con Tab né dal lettore di schermo); alla chiusura il focus torna dove era.
  let modalReturnFocus = null;
  function openModal(bg, focusEl){
    modalReturnFocus = document.activeElement;
    bg.classList.add('show');
    document.querySelector('.wrap').inert = true;
    focusEl.focus();
  }
  function closeModal(bg){
    bg.classList.remove('show');
    if (!document.querySelector('.modal-bg.show')) document.querySelector('.wrap').inert = false;
    const r = modalReturnFocus; modalReturnFocus = null;
    if (r && document.body.contains(r) && r.offsetParent !== null) r.focus();
  }

  // Pulsante "mostra/nascondi" accanto a un campo password.
  function addEyeToggle(input){
    const wrap = document.createElement('div');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'mostra';
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'mostra password');
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'nascondi' : 'mostra';
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.setAttribute('aria-label', show ? 'nascondi password' : 'mostra password');
      input.focus();
    });
    wrap.appendChild(btn);
    return btn;
  }
  function hidePw(input){
    input.type = 'password';
    const btn = input.parentNode.querySelector('button');
    if (btn){ btn.textContent = 'mostra'; btn.setAttribute('aria-pressed','false'); btn.setAttribute('aria-label','mostra password'); }
  }
  ['newPw1','newPw2','importPw'].forEach(id => addEyeToggle($(id)));

  function downloadBlob(blob, filename){
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
  }

  function makeCopyButton(getText, ariaLabel){
    const btn = document.createElement('button');
    btn.className = 'small ghost';
    btn.textContent = 'copia';
    if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
    btn.addEventListener('click', async () => {
      try{
        await navigator.clipboard.writeText(getText());
        announce('Copiato');
        btn.textContent = 'copiato';
        setTimeout(()=>{ btn.textContent = 'copia'; }, 1200);
      }catch(e){
        announce('Errore: copia non riuscita');
        btn.textContent = 'errore';
      }
    });
    return btn;
  }

  // ---------- crypto: vedi vault-crypto.js ----------
  const { STEGO_HEADER_BYTES, encryptVault, embedPayload, capacityBytes, openVault } = window.VaultCrypto;

  // ---------- image helpers ----------
  function loadImageFromFile(file){
    return new Promise((resolve,reject)=>{
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Immagine non leggibile'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error('File non leggibile'));
      reader.readAsDataURL(file);
    });
  }

  function getCanvasImageData(canvas){
    return canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);
  }

  function canvasFromImage(img){
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img,0,0);
    return canvas;
  }

  // Riempie un Uint8Array con byte da crypto.getRandomValues, a blocchi
  // (il limite per singola chiamata e' 65536 byte).
  function cryptoRandomBytes(n){
    const out = new Uint8Array(n);
    const CHUNK = 65536;
    for (let off=0; off<n; off+=CHUNK){
      out.set(crypto.getRandomValues(new Uint8Array(Math.min(CHUNK, n-off))), off);
    }
    return out;
  }

  // Polyfill UUID v4 (RFC 4122) basato su crypto.getRandomValues, usato solo quando
  // crypto.randomUUID non è disponibile.
  function uuidV4Fallback(){
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // versione 4
    b[8] = (b[8] & 0x3f) | 0x80; // variante RFC 4122
    const hex = Array.from(b, x => x.toString(16).padStart(2,'0'));
    return hex.slice(0,4).join('') + '-' +
           hex.slice(4,6).join('') + '-' +
           hex.slice(6,8).join('') + '-' +
           hex.slice(8,10).join('') + '-' +
           hex.slice(10,16).join('');
  }
  function newEntryId(){
    return crypto.randomUUID ? crypto.randomUUID() : uuidV4Fallback();
  }

  function generateNoiseCanvas(w,h){
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(w,h);
    const d = imageData.data;
    const pixelCount = w*h;
    const rnd = cryptoRandomBytes(pixelCount*3); // 1 byte casuale per canale R,G,B
    for (let i=0,r=0;i<d.length;i+=4,r+=3){
      d[i]   = 40 + (rnd[r]   % 80);   // R muted range for visual coherence
      d[i+1] = 40 + (rnd[r+1] % 80);   // G
      d[i+2] = 55 + (rnd[r+2] % 100);  // B
      d[i+3] = 255;                     // alpha opaque
    }
    ctx.putImageData(imageData,0,0);
    return canvas;
  }

  function renderPreview(canvas){
    const preview = $('coverPreview');
    preview.width = canvas.width;
    preview.height = canvas.height;
    preview.getContext('2d').drawImage(canvas,0,0);
    $('coverInfo').textContent =
      canvas.width+'×'+canvas.height+' px — capienza utile ~'+formatBytes(capacityBytes(getCanvasImageData(canvas)));
  }

  function formatBytes(n){
    if (n < 1024) return n+' B';
    return (n/1024).toFixed(1)+' KB';
  }

  // Calcola la dimensione minima dell'immagine (lato di un quadrato) necessaria
  // per contenere il vault attuale, con un margine di sicurezza.
  // MARGIN_FACTOR: moltiplicatore applicato ai byte necessari prima di dimensionare l'immagine.
  const COVER_MARGIN_FACTOR = 1.6;
  const COVER_MIN_SIDE = 60; // evita immagini talmente piccole da essere inutilizzabili/sospette
  function computeAutoCoverSize(vaultObj){
    const enc = new TextEncoder();
    const plainBytes = enc.encode(JSON.stringify(vaultObj)).length;
    const gcmTagOverhead = 16; // tag GCM incluso nel ciphertext restituito da crypto.subtle
    const bytesNeeded = plainBytes + gcmTagOverhead + STEGO_HEADER_BYTES;
    const bytesWithMargin = Math.ceil(bytesNeeded * COVER_MARGIN_FACTOR) + 32;
    const bitsNeeded = bytesWithMargin * 8;
    const pixelsNeeded = Math.ceil(bitsNeeded / 3);
    const side = Math.max(COVER_MIN_SIDE, Math.ceil(Math.sqrt(pixelsNeeded)));
    return { width: side, height: side, bytesNeeded };
  }

  // ---------- unbiased random password generation ----------
  function randomIndex(max){
    const range = 256 - (256 % max);
    let byte;
    do { byte = crypto.getRandomValues(new Uint8Array(1))[0]; } while (byte >= range);
    return byte % max;
  }
  function generatePassword(length, opts){
    const sets = {
      lower: 'abcdefghijklmnopqrstuvwxyz',
      upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      digits: '0123456789',
      symbols: '!@#$%^&*()-_=+[]{};:,.<>?'
    };
    let charset = '';
    if (opts.lower) charset += sets.lower;
    if (opts.upper) charset += sets.upper;
    if (opts.digits) charset += sets.digits;
    if (opts.symbols) charset += sets.symbols;
    if (!charset) charset = sets.lower + sets.digits;
    let pw = '';
    for (let i=0;i<length;i++){ pw += charset[randomIndex(charset.length)]; }
    return pw;
  }

  // ---------- stima robustezza master password ----------
  // Soglie sotto le quali il vault e' esposto a brute-force offline sul PNG esfiltrato:
  // MIN_MASTER_PW_LEN: lunghezza minima assoluta indipendente dal charset.
  // MIN_MASTER_PW_ENTROPY_BITS: entropia stimata minima (charset rilevato ^ lunghezza).
  const MIN_MASTER_PW_LEN = 12;
  const MIN_MASTER_PW_ENTROPY_BITS = 50;

  function countCharClasses(pw){
    let n = 0;
    if (/[a-z]/.test(pw)) n++;
    if (/[A-Z]/.test(pw)) n++;
    if (/[0-9]/.test(pw)) n++;
    if (/[^a-zA-Z0-9]/.test(pw)) n++;
    return n;
  }
  function estimatePasswordEntropyBits(pw){
    if (!pw) return 0;
    let charsetSize = 0;
    if (/[a-z]/.test(pw)) charsetSize += 26;
    if (/[A-Z]/.test(pw)) charsetSize += 26;
    if (/[0-9]/.test(pw)) charsetSize += 10;
    if (/[^a-zA-Z0-9]/.test(pw)) charsetSize += 33; // stima simboli comuni da tastiera
    if (charsetSize === 0) return 0;
    return pw.length * Math.log2(charsetSize);
  }

  // Nota: l'entropia qui è una stima sul charset usato, non tiene conto di parole di
  // dizionario o pattern prevedibili (servirebbe un dizionario/zxcvbn, fuori scope).
  // Il vincolo sul numero minimo di classi di caratteri riduce il rischio di password
  // lunghe ma monotematiche (es. una singola parola in minuscolo) che l'entropia
  // teorica da sola non intercetta.
  const MIN_MASTER_PW_CLASSES = 2;
  function passwordStrengthInfo(pw){
    const bits = estimatePasswordEntropyBits(pw);
    const classes = countCharClasses(pw);
    const lenOk = pw.length >= MIN_MASTER_PW_LEN;
    const entropyOk = bits >= MIN_MASTER_PW_ENTROPY_BITS && classes >= MIN_MASTER_PW_CLASSES;
    let label, pct, color;
    if (!pw.length){
      label = 'robustezza: —'; pct = 0; color = 'var(--accent)';
    } else if (!lenOk){
      label = 'troppo corta (minimo '+MIN_MASTER_PW_LEN+' caratteri) — ~'+Math.round(bits)+' bit stimati';
      pct = Math.min(100, (pw.length/MIN_MASTER_PW_LEN)*40);
      color = 'var(--err)';
    } else if (!entropyOk){
      label = 'debole — ~'+Math.round(bits)+' bit stimati, aggiungi varietà di caratteri (minuscole/MAIUSCOLE/numeri/simboli)';
      pct = Math.min(100, (bits/MIN_MASTER_PW_ENTROPY_BITS)*70);
      color = 'var(--err)';
    } else if (bits < MIN_MASTER_PW_ENTROPY_BITS*1.4){
      label = 'accettabile — ~'+Math.round(bits)+' bit stimati';
      pct = 75;
      color = 'var(--accent)';
    } else {
      label = 'robusta — ~'+Math.round(bits)+' bit stimati';
      pct = 100;
      color = 'var(--ok)';
    }
    return { bits, lenOk, entropyOk, label, pct, color };
  }

  function updatePwStrengthUI(){
    const pw = $('newPw1').value;
    const info = passwordStrengthInfo(pw);
    const fill = $('pwStrengthFill');
    fill.style.width = info.pct+'%';
    fill.style.background = info.color;
    $('pwStrengthLabel').textContent = info.label;
  }
  $('newPw1').addEventListener('input', updatePwStrengthUI);
  $('newPw1').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); $('newPw2').focus(); } });
  $('newPw2').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); $('btnCreateVault').click(); } });
  $('importPw').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); $('btnConfirmPwPrompt').click(); } });

  // ---------- UI: setup panel ----------
  const setupPanel = $('setupPanel');
  const coverPanel = $('coverPanel');
  const vaultPanel = $('vaultPanel');
  const statusPill = $('statusPill');
  const setupMsg = $('setupMsg');
  const coverMsg = $('coverMsg');
  const vaultMsg = $('vaultMsg');

  function setStatus(unlocked, label){
    statusPill.textContent = label;
    statusPill.className = 'status-pill ' + (unlocked ? 'unlocked' : 'locked');
  }

  // ---------- modifiche non esportate (protezione da perdita dati) ----------
  let dirty = false;
  function setDirty(v){
    dirty = v;
    if (vault) setStatus(true, v ? 'sbloccato — modifiche NON esportate' : 'sbloccato — tutto esportato');
  }
  window.addEventListener('beforeunload', (e) => {
    if (dirty){ e.preventDefault(); e.returnValue = ''; }
  });

  $('btnNewVault').addEventListener('click', () => {
    clearMsg(setupMsg);
    coverPanel.classList.remove('hidden');
    coverCanvas = null;
    $('coverInfo').textContent = 'nessuna immagine selezionata';
    const c = $('coverPreview');
    c.getContext('2d').clearRect(0,0,c.width,c.height);
    updatePwStrengthUI();
    $('coverSize').focus({ preventScroll: true }); // niente salto della pagina
  });

  $('btnCancelCreate').addEventListener('click', () => {
    $('newPw1').value = ''; $('newPw2').value = '';
    hidePw($('newPw1')); hidePw($('newPw2'));
    updatePwStrengthUI();
    coverPanel.classList.add('hidden');
    $('btnNewVault').focus();
  });

  $('btnGenCover').addEventListener('click', () => {
    const [w,h] = $('coverSize').value.split('x').map(Number);
    coverCanvas = generateNoiseCanvas(w,h);
    renderPreview(coverCanvas);
    clearMsg(coverMsg);
  });

  $('btnCreateVault').addEventListener('click', () => {
    const pw1 = $('newPw1').value;
    const pw2 = $('newPw2').value;
    if (!coverCanvas){
      showMsg(coverMsg, 'Seleziona o genera prima un\'immagine di copertura.', 'err');
      return;
    }
    const pwInfo = passwordStrengthInfo(pw1);
    if (!pwInfo.lenOk){
      showMsg(coverMsg, 'La master password deve avere almeno '+MIN_MASTER_PW_LEN+' caratteri.', 'err');
      return;
    }
    if (!pwInfo.entropyOk){
      showMsg(coverMsg, 'Master password troppo debole (~'+Math.round(pwInfo.bits)+' bit stimati, minimo '+MIN_MASTER_PW_ENTROPY_BITS+'). Aggiungi varietà di caratteri: minuscole, MAIUSCOLE, numeri, simboli.', 'err');
      return;
    }
    if (pw1 !== pw2){
      showMsg(coverMsg, 'Le due password non coincidono.', 'err');
      return;
    }
    masterPassword = pw1;
    vault = { entries: [] };
    $('newPw1').value = '';
    $('newPw2').value = '';
    hidePw($('newPw1')); hidePw($('newPw2'));
    updatePwStrengthUI();
    coverPanel.classList.add('hidden');
    setupPanel.classList.add('hidden');
    vaultPanel.classList.remove('hidden');
    setDirty(true);
    renderEntries();
    updateCapacityGauge();
    $('vaultTitle').focus();
  });

  // ---------- import flow ----------
  $('btnImportVault').addEventListener('click', () => {
    $('fileImport').click();
  });
  $('fileImport').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    pendingImportFile = file;
    $('importPw').value = '';
    hidePw($('importPw'));
    clearMsg($('pwPromptMsg'));
    openModal($('pwPromptBg'), $('importPw'));
  });

  let unlocking = false;
  function setUnlocking(v){
    unlocking = v;
    $('btnConfirmPwPrompt').disabled = v;
    $('btnCancelPwPrompt').disabled = v;
  }

  $('btnCancelPwPrompt').addEventListener('click', () => {
    if (unlocking) return;
    $('importPw').value = '';
    closeModal($('pwPromptBg'));
    pendingImportFile = null;
  });

  $('btnConfirmPwPrompt').addEventListener('click', async () => {
    if (unlocking) return;
    const pwMsg = $('pwPromptMsg');
    const pw = $('importPw').value;
    if (!pendingImportFile){ return; }
    setUnlocking(true);
    showMsg(pwMsg, 'Sblocco in corso, attendere…', 'warn');
    let canvas, imageData;
    try{
      canvas = canvasFromImage(await loadImageFromFile(pendingImportFile));
      imageData = getCanvasImageData(canvas);
    }catch(err){
      showMsg(pwMsg, 'Errore nella lettura del file immagine: '+err.message, 'err');
      setUnlocking(false);
      return;
    }
    // Un solo ramo di errore: "password errata" e "non è un vault" sono indistinguibili
    // (vedi extractPayload), quindi il messaggio è lo stesso in entrambi i casi.
    try{
      const vaultObj = await openVault(imageData, pw);
      vault = vaultObj;
      masterPassword = pw;
      coverCanvas = canvas;
      $('importPw').value = '';
      setUnlocking(false);
      clearMsg(pwMsg);
      closeModal($('pwPromptBg'));
      setupPanel.classList.add('hidden');
      vaultPanel.classList.remove('hidden');
      setDirty(false);
      setStatus(true, 'sbloccato — vault caricato');
      renderEntries();
      updateCapacityGauge();
      pendingImportFile = null;
      $('vaultTitle').focus();
    }catch(err){
      setUnlocking(false);
      showMsg(pwMsg, 'Password errata, oppure il file non è un vault valido creato da questa app.', 'err');
      $('importPw').focus();
    }
  });

  // ---------- vault panel: entries ----------
  const entryBody = $('entryBody');
  const entryCountEl = $('entryCount');
  let searchTerm = '';

  function matchesSearch(entry, term){
    if (!term) return true;
    const t = term.toLowerCase();
    return (entry.site||'').toLowerCase().includes(t)
        || (entry.user||'').toLowerCase().includes(t)
        || (entry.notes||'').toLowerCase().includes(t);
  }

  // Se il campo "Sito / servizio" è un indirizzo web (con o senza schema),
  // restituisce l'URL http(s) assoluto; altrimenti null. Solo http/https: nessun
  // altro schema (javascript:, data:, ecc.) può diventare un link.
  const SITE_URL_RE = /^(https?:\/\/)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:\d{1,5})?([\/?#]\S*)?$/i;
  function siteToUrl(text){
    const t = (text || '').trim();
    if (!SITE_URL_RE.test(t)) return null;
    try{
      const u = new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    }catch(e){
      return null;
    }
  }

  function renderEntries(){
    entryBody.innerHTML = '';
    const filtered = vault.entries.filter(e => matchesSearch(e, searchTerm));

    if (!vault.entries.length){
      entryBody.innerHTML = '<tr class="empty-row"><td colspan="5">Nessuna credenziale. Aggiungine una con "+ Nuova voce".</td></tr>';
      entryCountEl.textContent = '0';
      return;
    }
    if (!filtered.length){
      entryBody.innerHTML = '<tr class="empty-row"><td colspan="5">Nessuna voce corrisponde alla ricerca.</td></tr>';
      entryCountEl.textContent = '0 di ' + vault.entries.length;
      return;
    }
    entryCountEl.textContent = searchTerm
      ? filtered.length + ' di ' + vault.entries.length
      : String(vault.entries.length);
    filtered.forEach(entry => {
      const tr = document.createElement('tr');
      const nm = entry.site || 'voce senza nome';

      const tdSite = document.createElement('td');
      tdSite.dataset.label = 'Sito / servizio';
      const siteUrl = siteToUrl(entry.site);
      if (siteUrl){
        const link = document.createElement('a');
        link.href = siteUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'site-link';
        link.textContent = entry.site;
        tdSite.appendChild(link);
      } else {
        tdSite.textContent = entry.site || '—';
      }
      tr.appendChild(tdSite);

      const tdUser = document.createElement('td');
      tdUser.dataset.label = 'Utente';
      const userCell = document.createElement('div');
      userCell.className = 'pw-cell';
      const userSpan = document.createElement('span');
      userSpan.textContent = entry.user || '—';
      userCell.appendChild(userSpan);
      if (entry.user){
        userCell.appendChild(makeCopyButton(() => entry.user, 'copia utente di ' + nm));
      }
      tdUser.appendChild(userCell);
      tr.appendChild(tdUser);

      const tdPass = document.createElement('td');
      tdPass.dataset.label = 'Password';
      const pwCell = document.createElement('div');
      pwCell.className = 'pw-cell';
      const pwSpan = document.createElement('span');
      pwSpan.className = 'pw-mask';
      pwSpan.textContent = '••••••••••';
      pwSpan.dataset.visible = 'false';
      pwSpan.setAttribute('aria-hidden', 'true'); // i pallini non vengono letti
      const btnToggle = document.createElement('button');
      btnToggle.className = 'small ghost';
      btnToggle.textContent = 'mostra';
      btnToggle.setAttribute('aria-label', 'mostra password di ' + nm);
      btnToggle.setAttribute('aria-pressed', 'false');
      btnToggle.addEventListener('click', () => {
        const visible = pwSpan.dataset.visible === 'true';
        pwSpan.textContent = visible ? '••••••••••' : (entry.pass || 'vuoto');
        pwSpan.dataset.visible = visible ? 'false' : 'true';
        pwSpan.setAttribute('aria-hidden', visible ? 'true' : 'false');
        btnToggle.textContent = visible ? 'mostra' : 'nascondi';
        btnToggle.setAttribute('aria-label', (visible ? 'mostra' : 'nascondi') + ' password di ' + nm);
        btnToggle.setAttribute('aria-pressed', visible ? 'false' : 'true');
        if (!visible) announce(entry.pass || 'password vuota');
      });
      pwCell.appendChild(pwSpan);
      pwCell.appendChild(btnToggle);
      pwCell.appendChild(makeCopyButton(() => entry.pass || '', 'copia password di ' + nm));
      tdPass.appendChild(pwCell);
      tr.appendChild(tdPass);

      const tdNotes = document.createElement('td');
      tdNotes.dataset.label = 'Note';
      tdNotes.className = 'notes-cell';
      tdNotes.textContent = entry.notes || '';
      tr.appendChild(tdNotes);

      const tdActions = document.createElement('td');
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'cell-actions';
      const btnEdit = document.createElement('button');
      btnEdit.className = 'small ghost';
      btnEdit.textContent = 'modifica';
      btnEdit.setAttribute('aria-label', 'modifica ' + nm);
      btnEdit.addEventListener('click', () => openEntryModal(entry));
      const btnDel = document.createElement('button');
      btnDel.className = 'small danger';
      btnDel.textContent = 'elimina';
      btnDel.setAttribute('aria-label', 'elimina ' + nm);
      btnDel.addEventListener('click', () => {
        if (!confirm('Eliminare la voce "' + (entry.site || '') + '"?')) return;
        vault.entries = vault.entries.filter(x => x.id !== entry.id);
        setDirty(true);
        renderEntries();
        updateCapacityGauge();
        $('vaultTitle').focus();
        showMsg(vaultMsg, 'Voce eliminata. Ricorda di esportare per salvare la modifica.', 'warn');
      });
      actionsDiv.appendChild(btnEdit);
      actionsDiv.appendChild(btnDel);
      tdActions.appendChild(actionsDiv);
      tr.appendChild(tdActions);

      entryBody.appendChild(tr);
    });
  }

  function updateCapacityGauge(){
    if (!coverCanvas) return;
    const cap = capacityBytes(getCanvasImageData(coverCanvas));
    const used = new TextEncoder().encode(JSON.stringify(vault)).length + 28; // rough pre-encryption estimate + salt/iv
    const pct = Math.min(100, (used/cap)*100);
    $('capacityFill').style.width = pct+'%';
    $('capacityLabel').textContent =
      'capienza immagine: ~'+formatBytes(used)+' usati su ~'+formatBytes(cap)+' disponibili ('+pct.toFixed(1)+'%)';
    $('capacityFill').style.background = pct > 90 ? 'var(--err)' : 'var(--accent)';
  }

  // ---------- ricerca voci ----------
  const searchInput = $('searchInput');

  searchInput.addEventListener('input', () => {
    searchTerm = searchInput.value.trim();
    renderEntries();
  });

  // ---------- gestione copertina per vault già esistente ----------
  const coverActionMsg = $('coverActionMsg');

  $('btnRegenCover').addEventListener('click', () => {
    if (!vault) return;
    const size = computeAutoCoverSize(vault);
    coverCanvas = generateNoiseCanvas(size.width, size.height);
    setDirty(true);
    updateCapacityGauge();
    showMsg(
      coverActionMsg,
      'Nuova immagine generata: '+size.width+'×'+size.height+' px, dimensionata sui '+
      formatBytes(size.bytesNeeded)+' di dati attuali (con margine di sicurezza). '+
      'Esporta il vault per salvarla su disco: l\'immagine precedente scaricata non è più collegata a questo vault.',
      'ok'
    );
  });

  // ---------- entry modal ----------
  const entryModalBg = $('entryModalBg');
  function openEntryModal(entry){
    $('entryModalTitle').textContent = entry ? 'Modifica voce' : 'Nuova voce';
    $('entryId').value = entry ? entry.id : '';
    $('entrySite').value = entry ? entry.site : '';
    $('entryUser').value = entry ? entry.user : '';
    $('entryPass').value = entry ? entry.pass : '';
    $('entryNotes').value = entry ? entry.notes : '';
    $('genOptions').classList.add('hidden');
    openModal(entryModalBg, $('entrySite'));
  }
  $('btnAddEntry').addEventListener('click', () => openEntryModal(null));
  $('btnCancelEntry').addEventListener('click', () => closeModal(entryModalBg));
  ['entrySite','entryUser','entryPass'].forEach(id => {
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); $('btnSaveEntry').click(); } });
  });
  // Esc chiude la finestra aperta
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (entryModalBg.classList.contains('show')) closeModal(entryModalBg);
    else if ($('pwPromptBg').classList.contains('show')) $('btnCancelPwPrompt').click();
  });

  $('btnGenInModal').addEventListener('click', () => {
    const options = $('genOptions');
    options.classList.toggle('hidden');
    if (!options.classList.contains('hidden')) regenInModal();
  });
  function regenInModal(){
    const len = parseInt($('genLen').value,10) || 20;
    const opts = {
      lower: $('genLower').checked,
      upper: $('genUpper').checked,
      digits: $('genDigits').checked,
      symbols: $('genSymbols').checked
    };
    $('entryPass').value = generatePassword(len, opts);
    announce('Password generata');
  }
  ['genLen','genLower','genUpper','genDigits','genSymbols'].forEach(id => {
    $(id).addEventListener('change', regenInModal);
    $(id).addEventListener('input', regenInModal);
  });

  $('btnSaveEntry').addEventListener('click', () => {
    const id = $('entryId').value;
    const site = $('entrySite').value.trim();
    const user = $('entryUser').value.trim();
    const pass = $('entryPass').value;
    const notes = $('entryNotes').value.trim();
    if (!site){
      alert('Il campo "sito / servizio" è obbligatorio.');
      $('entrySite').focus();
      return;
    }
    if (id){
      const e = vault.entries.find(x => x.id === id);
      if (e){ e.site = site; e.user = user; e.pass = pass; e.notes = notes; }
    } else {
      vault.entries.push({
        id: newEntryId(),
        site, user, pass, notes
      });
    }
    closeModal(entryModalBg);
    setDirty(true);
    renderEntries();
    updateCapacityGauge();
    if (document.activeElement === document.body || !document.body.contains(document.activeElement)) $('btnAddEntry').focus();
    showMsg(vaultMsg, 'Voce salvata in memoria. Esporta il vault (PNG) per rendere permanente la modifica.', 'warn');
  });

  // ---------- export ----------
  function canvasToPngBlob(canvas){
    return new Promise((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('creazione PNG fallita')), 'image/png');
    });
  }
  // Rilegge il PNG appena prodotto e lo decifra: conferma che il file è integro
  // (alcuni browser alterano i pixel per anti-tracciamento e distruggerebbero il vault).
  async function verifyExportedBlob(blob, password, expectedJson){
    try{
      const data = getCanvasImageData(canvasFromImage(await loadImageFromFile(blob)));
      const obj = await openVault(data, password);
      return JSON.stringify(obj) === expectedJson;
    }catch(e){
      return false;
    }
  }
  function exportFileName(){
    const d = new Date(), p = n => String(n).padStart(2,'0');
    return 'vault-' + d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) +
           '_' + p(d.getHours()) + '-' + p(d.getMinutes()) + '.png';
  }

  let exporting = false;
  $('btnExport').addEventListener('click', async () => {
    if (exporting) return;
    clearMsg(vaultMsg);
    if (!coverCanvas || !masterPassword || !vault){
      showMsg(vaultMsg, 'Nessun vault attivo.', 'err');
      return;
    }
    exporting = true;
    $('btnExport').disabled = true;
    showMsg(vaultMsg, 'Esportazione e verifica in corso, attendere…', 'warn');
    try{
      const snapshot = JSON.stringify(vault);
      const { iterations, salt, iv, ciphertext } = await encryptVault(masterPassword, JSON.parse(snapshot));
      const imageData = getCanvasImageData(coverCanvas);
      const clone = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
      try{
        await embedPayload(clone, masterPassword, iterations, salt, iv, ciphertext);
      }catch(err){
        showMsg(vaultMsg, 'L\'immagine di copertura è troppo piccola per contenere il vault attuale. Usa un\'immagine più grande.', 'err');
        return;
      }
      const outCanvas = document.createElement('canvas');
      outCanvas.width = clone.width; outCanvas.height = clone.height;
      outCanvas.getContext('2d').putImageData(clone,0,0);
      const blob = await canvasToPngBlob(outCanvas);
      if (!(await verifyExportedBlob(blob, masterPassword, snapshot))){
        showMsg(vaultMsg, 'ESPORTAZIONE ANNULLATA: la verifica del PNG è fallita, il file sarebbe illeggibile. '+
          'Probabile causa: il browser altera le immagini (protezione anti-tracciamento, es. Brave, Firefox, Safari). '+
          'Usa Chrome o Edge, oppure disattiva quella protezione per questa pagina. Le modifiche sono ancora in memoria: non chiudere la pagina.', 'err');
        return;
      }
      downloadBlob(blob, exportFileName());
      if (JSON.stringify(vault) === snapshot) setDirty(false);
      showMsg(vaultMsg, 'Vault esportato e verificato. Conserva il PNG in formato originale, senza ricomprimerlo (niente WhatsApp, Google Foto, ecc.).', 'ok');
    }catch(err){
      showMsg(vaultMsg, 'Errore nell\'esportazione: '+err.message, 'err');
    }finally{
      exporting = false;
      $('btnExport').disabled = false;
    }
  });

  // ---------- esportazione in chiaro (backup non cifrato) ----------
  $('btnExportTxt').addEventListener('click', () => {
    clearMsg(vaultMsg);
    if (!vault){
      showMsg(vaultMsg, 'Nessun vault attivo.', 'err');
      return;
    }
    if (!vault.entries.length){
      showMsg(vaultMsg, 'Il vault non contiene voci da esportare.', 'warn');
      return;
    }
    const step1 = confirm(
      'Questo file conterrà tutte le password IN CHIARO, senza cifratura e senza steganografia. '+
      'Chiunque apra il file potrà leggerle direttamente. Continuare?'
    );
    if (!step1) return;
    const step2 = confirm(
      'Conferma: il file TXT non sarà protetto in alcun modo. '+
      'Se lo conservi, tienilo in un posto sicuro (es. cifrato separatamente) ed eliminalo quando non ti serve più. Procedere con l\'esportazione?'
    );
    if (!step2) return;

    const now = new Date();
    const lines = [];
    lines.push('VAULT — ESPORTAZIONE IN CHIARO (NON CIFRATA)');
    lines.push('Generato il: ' + now.toLocaleString('it-IT'));
    lines.push('ATTENZIONE: questo file non è protetto. Trattalo come le password stesse.');
    lines.push('='.repeat(60));
    lines.push('');
    vault.entries.forEach((e, i) => {
      lines.push('Voce ' + (i+1));
      lines.push('Sito/servizio: ' + (e.site || ''));
      lines.push('Utente:        ' + (e.user || ''));
      lines.push('Password:      ' + (e.pass || ''));
      // Le righe di nota successive alla prima sono rientrate di 15 colonne (larghezza di
      // "Note:          "): nessuna riga di nota può essere scambiata per un separatore
      // o per un campo all'importazione.
      (e.notes || '').split(/\r\n|\r|\n/).forEach((nl, k) => {
        lines.push(k === 0 ? 'Note:          ' + nl : ' '.repeat(15) + nl);
      });
      lines.push('-'.repeat(60));
    });
    const blob = new Blob([lines.join('\n')], {type:'text/plain;charset=utf-8'});
    downloadBlob(blob, 'vault-in-chiaro-' + now.toISOString().slice(0,10) + '.txt');
    showMsg(vaultMsg, 'Backup in chiaro esportato. File non protetto: conservalo con cautela.', 'warn');
  });

  // ---------- importazione da TXT in chiaro ----------
  // Formato letto = formato scritto da "Esporta vault (TXT, in chiaro)": intestazione,
  // poi blocchi "Voce N" con i campi a prefisso fisso di 15 caratteri, chiusi da una
  // riga di 60 trattini. Le righe di nota successive alla prima sono rientrate di 15 colonne.
  const TXT_HEADER_PREFIX = 'VAULT — ESPORTAZIONE IN CHIARO';
  const TXT_SEPARATOR = '-'.repeat(60);
  function parsePlainTxt(text){
    const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
    if (lines[0].trim().indexOf(TXT_HEADER_PREFIX) !== 0) throw new Error('FORMATO_NON_RICONOSCIUTO');
    const entries = [];
    let invalid = 0;
    let cur = null;
    let inNotes = false;
    const val = l => (l.length > 15 ? l.slice(15) : '');
    function close(){
      if (cur){
        cur.site = cur.site.trim();
        cur.user = cur.user.trim();
        cur.notes = cur.notes.trim();
        if (cur.site) entries.push(cur); else invalid++;
      }
      cur = null;
      inNotes = false;
    }
    for (let i=1;i<lines.length;i++){
      const l = lines[i];
      if (l.replace(/\s+$/, '') === TXT_SEPARATOR){ close(); continue; }
      if (/^Voce \d+\s*$/.test(l)){ close(); cur = {site:'', user:'', pass:'', notes:''}; continue; }
      if (!cur) continue;
      if (l.startsWith('Sito/servizio:')){ cur.site = val(l); inNotes = false; }
      else if (l.startsWith('Utente:')){ cur.user = val(l); inNotes = false; }
      else if (l.startsWith('Password:')){ cur.pass = val(l); inNotes = false; }
      else if (l.startsWith('Note:')){ cur.notes = val(l); inNotes = true; }
      else if (inNotes){ cur.notes += '\n' + val(l); }
    }
    close();
    return { entries, invalid };
  }

  $('btnImportTxt').addEventListener('click', () => {
    clearMsg(vaultMsg);
    if (!vault){
      showMsg(vaultMsg, 'Nessun vault attivo.', 'err');
      return;
    }
    $('fileImportTxt').click();
  });
  $('fileImportTxt').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !vault) return;
    clearMsg(vaultMsg);
    let parsed;
    try{
      parsed = parsePlainTxt(await file.text());
    }catch(err){
      showMsg(vaultMsg, 'File non riconosciuto: deve essere un TXT prodotto da "Esporta vault (TXT, in chiaro)".', 'err');
      return;
    }
    const keyOf = x => JSON.stringify([x.site, x.user, x.pass, x.notes]);
    const existing = new Set(vault.entries.map(keyOf));
    let added = 0, duplicates = 0;
    parsed.entries.forEach(en => {
      const k = keyOf(en);
      if (existing.has(k)){ duplicates++; return; }
      existing.add(k);
      vault.entries.push({ id: newEntryId(), site: en.site, user: en.user, pass: en.pass, notes: en.notes });
      added++;
    });
    if (added) setDirty(true);
    renderEntries();
    updateCapacityGauge();
    let msg = 'Importate '+added+' voci';
    if (duplicates) msg += ', '+duplicates+' ignorate perché già presenti';
    if (parsed.invalid) msg += ', '+parsed.invalid+' scartate perché senza sito/servizio';
    msg += '. Esporta il vault (PNG) per rendere permanente la modifica.';
    showMsg(vaultMsg, msg, (added || duplicates) ? 'warn' : 'err');
  });

  // ---------- lock ----------
  $('btnLock').addEventListener('click', () => {
    if (dirty && !confirm('Ci sono modifiche NON esportate: bloccando andranno perse. Bloccare comunque?')) return;
    dirty = false;
    vault = null;
    masterPassword = null;
    coverCanvas = null;
    searchTerm = '';
    searchInput.value = '';
    vaultPanel.classList.add('hidden');
    setupPanel.classList.remove('hidden');
    setStatus(false, 'bloccato — nessun vault caricato');
    clearMsg(vaultMsg);
    $('btnImportVault').focus();
  });

})();

