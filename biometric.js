// biometric.js — sblocco con impronta (o altro sblocco del telefono) tramite passkey + estensione PRF.
// L'impronta NON sostituisce la master password: la passkey produce una chiave segreta (PRF)
// con cui la master password viene cifrata e conservata SOLO su questo dispositivo.
// Senza la passkey (cioè senza impronta/sblocco del telefono) il dato salvato è inutilizzabile.
(function(){
  'use strict';
  const STORE = 'vault-bio-v1';
  const subtle = crypto.subtle;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = u8 => btoa(String.fromCharCode.apply(null, Array.from(u8)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  function read(){
    try { const r = JSON.parse(localStorage.getItem(STORE) || 'null'); return r && r.credId ? r : null; }
    catch (e) { return null; }
  }
  function isSupported(){
    return !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
  }
  function isEnabled(){ return isSupported() && !!read(); }
  function disable(){ try { localStorage.removeItem(STORE); } catch (e) {} }

  async function keyFromPrf(prfOut){
    const base = await subtle.importKey('raw', prfOut, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('vault-master-password') },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  // Errori: 'ANNULLATO' (l'utente ha annullato o il tempo è scaduto), 'NON_SUPPORTATO' (niente PRF:
  // serve il gestore password di Google / Portachiavi iCloud), 'NESSUNO' (impronta non attivata).
  function mapErr(e){
    if (e && (e.message === 'NON_SUPPORTATO' || e.message === 'NESSUNO')) return e;
    if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return new Error('ANNULLATO');
    return new Error('NON_SUPPORTATO');
  }
  async function prfGet(credId, salt){
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: credId }],
      userVerification: 'required',
      timeout: 60000,
      extensions: { prf: { eval: { first: salt } } }
    }});
    const r = cred && cred.getClientExtensionResults().prf;
    if (!r || !r.results || !r.results.first) throw new Error('NON_SUPPORTATO');
    return new Uint8Array(r.results.first);
  }

  // Attiva: crea la passkey e salva la master password cifrata con la chiave PRF.
  async function enable(masterPassword){
    if (!isSupported()) throw new Error('NON_SUPPORTATO');
    try{
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const cred = await navigator.credentials.create({ publicKey: {
        rp: { name: 'Vault', id: location.hostname },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'Vault', displayName: 'Vault (sblocco con impronta)' },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        timeout: 60000,
        extensions: { prf: { eval: { first: salt } } }
      }});
      const credId = new Uint8Array(cred.rawId);
      const r = cred.getClientExtensionResults().prf;
      if (!r || r.enabled === false) throw new Error('NON_SUPPORTATO');
      // Alcuni sistemi danno la chiave già alla creazione, altri solo al primo uso (seconda impronta).
      const prfOut = (r.results && r.results.first) ? new Uint8Array(r.results.first) : await prfGet(credId, salt);
      const key = await keyFromPrf(prfOut);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(masterPassword)));
      localStorage.setItem(STORE, JSON.stringify({ v: 1, credId: b64(credId), salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
    }catch(e){ throw mapErr(e); }
  }

  // Sblocca: chiede l'impronta e restituisce la master password salvata.
  async function getPassword(){
    const rec = read();
    if (!rec) throw new Error('NESSUNO');
    try{
      const prfOut = await prfGet(unb64(rec.credId), unb64(rec.salt));
      const key = await keyFromPrf(prfOut);
      return dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, key, unb64(rec.ct)));
    }catch(e){ throw mapErr(e); }
  }

  function messageFor(err){
    switch (err && err.message){
      case 'ANNULLATO': return 'Impronta annullata.';
      case 'NESSUNO': return 'Lo sblocco con impronta non è attivo su questo telefono.';
      default: return 'Su questo telefono lo sblocco con impronta non è disponibile (serve il gestore password di Google o il Portachiavi iCloud). Usa la master password.';
    }
  }

  window.VaultBio = Object.freeze({ isSupported, isEnabled, enable, disable, getPassword, messageFor });
})();
