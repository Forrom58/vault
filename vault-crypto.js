// vault-crypto.js — cifratura e steganografia condivise da registratore e visualizzatore.
// Formato del PNG invariato rispetto a vault-stego-18 / vault-viewer.V4 (compatibile).
(function(){
  'use strict';
  // ---------- crypto ----------
  const PBKDF2_ITERATIONS = 600000; // soglia minima raccomandata OWASP per PBKDF2-HMAC-SHA256
  async function deriveKey(password, salt, iterations){
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), {name:'PBKDF2'}, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {name:'PBKDF2', salt, iterations, hash:'SHA-256'},
      keyMaterial,
      {name:'AES-GCM', length:256},
      false,
      ['encrypt','decrypt']
    );
  }

  async function encryptVault(password, vaultObj){
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
    const enc = new TextEncoder();
    const plaintext = enc.encode(JSON.stringify(vaultObj));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, plaintext));
    // Iterazioni, salt e iv non sono concatenati al ciphertext: li scrive embedPayload
    // nell'envelope steganografico, disposto su canali permutati dalla master password
    // (nessun header leggibile in posizione fissa senza password).
    return { iterations: PBKDF2_ITERATIONS, salt, iv, ciphertext };
  }

  async function decryptVault(password, iterations, salt, iv, ciphertext){
    const key = await deriveKey(password, salt, iterations);
    const plaintext = await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  // ---------- steganography (LSB, 3 bits per pixel across R,G,B) ----------
  function bytesToBits(bytes){
    const bits = new Uint8Array(bytes.length*8);
    for (let i=0;i<bytes.length;i++){
      for (let b=0;b<8;b++){
        bits[i*8+b] = (bytes[i] >> (7-b)) & 1;
      }
    }
    return bits;
  }
  function bitsToBytes(bits){
    const bytes = new Uint8Array(Math.floor(bits.length/8));
    for (let i=0;i<bytes.length;i++){
      let v=0;
      for (let b=0;b<8;b++){ v = (v<<1) | bits[i*8+b]; }
      bytes[i]=v;
    }
    return bytes;
  }

  // ---------- permutazione dei canali derivata dalla password ----------
  // Costante di contesto fissa, pubblica: serve SOLO a derivare la permutazione dei
  // pixel, MAI la chiave AES (quella usa un salt casuale per-file, invariato).
  const STEGO_PERMUTATION_CONTEXT = 'vault-stego-v5-pixel-permutation';
  const STEGO_HEADER_BYTES = 36; // iterazioni(4)+salt(16)+iv(12)+lunghezza(4)
  const STEGO_HEADER_BITS = STEGO_HEADER_BYTES * 8;

  function totalChannelsOf(imageData){
    return Math.floor(imageData.data.length/4)*3; // 3 canali (R,G,B) per pixel, alpha escluso
  }

  // Seed della permutazione, con suffisso opzionale aggiunto al salt PBKDF2.
  // Senza suffisso: seed dell'header, dipende solo da password e dimensioni immagine,
  // quindi è stabile tra export (serve al bootstrap: prima di leggere l'header si
  // conosce solo la password). Con il salt casuale dell'export come suffisso: seed
  // del payload, diverso ad ogni export.
  async function derivePermutationSeed(password, saltSuffix){
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), {name:'PBKDF2'}, false, ['deriveBits']
    );
    const contextBytes = enc.encode(STEGO_PERMUTATION_CONTEXT);
    let saltBytes = contextBytes;
    if (saltSuffix && saltSuffix.length){
      saltBytes = new Uint8Array(contextBytes.length + saltSuffix.length);
      saltBytes.set(contextBytes, 0);
      saltBytes.set(saltSuffix, contextBytes.length);
    }
    // Stesse iterazioni della chiave AES: nessuna scorciatoia più economica del
    // brute-force diretto per un attaccante che tenta password candidate.
    const bits = await crypto.subtle.deriveBits(
      {name:'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash:'SHA-256'},
      keyMaterial, 256
    );
    return new Uint8Array(bits);
  }
  function deriveHeaderSeed(password){
    return derivePermutationSeed(password, null);
  }
  function derivePayloadSeed(password, salt){
    return derivePermutationSeed(password, salt);
  }

  // Canali "liberi" (non riservati all'header), nell'ordine naturale 0..totalChannels-1.
  // Su questo sottoinsieme opera la permutazione del payload, mai sovrapposta all'header.
  function computeRemainingChannels(totalChannels, headerChannels){
    const reserved = new Uint8Array(totalChannels);
    for (let i=0;i<headerChannels.length;i++) reserved[headerChannels[i]] = 1;
    const remaining = new Uint32Array(totalChannels - headerChannels.length);
    let ri = 0;
    for (let c=0;c<totalChannels;c++){
      if (!reserved[c]) remaining[ri++] = c;
    }
    return remaining;
  }
  function readBitAtChannel(data, channelIndex){
    const pixelIndex = Math.floor(channelIndex/3);
    const channel = channelIndex % 3;
    return data[pixelIndex*4 + channel] & 1;
  }
  function writeBitAtChannel(data, channelIndex, bit){
    const pixelIndex = Math.floor(channelIndex/3);
    const channel = channelIndex % 3;
    const dataIdx = pixelIndex*4 + channel;
    data[dataIdx] = (data[dataIdx] & 0xFE) | bit;
  }

  async function deriveKeystream(seedBytes, numBytes){
    const key = await crypto.subtle.importKey('raw', seedBytes, {name:'AES-CTR'}, false, ['encrypt']);
    const zeros = new Uint8Array(numBytes);
    const counter = new Uint8Array(16); // seed già unico per password+contesto: counter fisso va bene
    const keystream = await crypto.subtle.encrypt({name:'AES-CTR', counter, length:64}, key, zeros);
    return new Uint8Array(keystream);
  }

  function keyedShuffleIndices(n, keystreamBytes){
    const arr = new Uint32Array(n);
    for (let i=0;i<n;i++) arr[i]=i;
    let bytePos = 0;
    function nextIndex(maxExclusive){
      const bytesPerDraw = maxExclusive <= 256 ? 1 : (maxExclusive <= 65536 ? 2 : 4);
      const range = Math.pow(256, bytesPerDraw);
      const limit = range - (range % maxExclusive);
      let v;
      do {
        if (bytePos + bytesPerDraw > keystreamBytes.length){
          // Segnala al chiamante che il keystream va rideriso più ampio,
          // invece di continuare con uno stato a metà.
          throw new Error('KEYSTREAM_EXHAUSTED');
        }
        v = 0;
        for (let b=0;b<bytesPerDraw;b++){ v = (v<<8) | keystreamBytes[bytePos++]; }
        v = v >>> 0;
      } while (v >= limit);
      return v % maxExclusive;
    }
    for (let i=n-1;i>0;i--){
      const j = nextIndex(i+1);
      const tmp = arr[i]; arr[i]=arr[j]; arr[j]=tmp;
    }
    return arr;
  }

  async function computeChannelOrder(seedBytes, n){
    // Se il margine iniziale non basta per il rejection sampling, rideriva da capo un
    // keystream più ampio con lo stesso seed (raddoppiando il margine): resta
    // deterministico, stesso seed e stesso n danno sempre la stessa permutazione.
    let multiplier = 4;
    const MAX_MULTIPLIER = 64; // limite di sicurezza, evita loop patologici
    while (multiplier <= MAX_MULTIPLIER){
      const keystream = await deriveKeystream(seedBytes, n*multiplier);
      try{
        return keyedShuffleIndices(n, keystream);
      }catch(err){
        if (err.message !== 'KEYSTREAM_EXHAUSTED') throw err;
        multiplier *= 2;
      }
    }
    throw new Error('KEYSTREAM_EXHAUSTED');
  }

  // ---------- steganografia: envelope a 36 byte, header e payload su permutazioni separate ----------
  function capacityBytes(imageData){
    return Math.floor(totalChannelsOf(imageData)/8) - STEGO_HEADER_BYTES; // meno l'envelope
  }

  async function embedPayload(imageData, password, iterations, salt, iv, ciphertext){
    // Header a 36 byte: 4 iterazioni + 16 salt + 12 iv + 4 lunghezza ciphertext.
    const header = new Uint8Array(STEGO_HEADER_BYTES);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, iterations, false);
    header.set(salt, 4);
    header.set(iv, 20);
    dv.setUint32(32, ciphertext.length, false);

    const headerBits = bytesToBits(header);
    const payloadBits = bytesToBits(ciphertext);

    const totalChannels = totalChannelsOf(imageData);
    if (headerBits.length > totalChannels) throw new Error('CAPACITY_EXCEEDED');

    // Header: permutazione fissa (password + dimensioni immagine), invariata tra export.
    const headerSeed = await deriveHeaderSeed(password);
    const headerOrder = await computeChannelOrder(headerSeed, totalChannels);
    const headerChannels = headerOrder.slice(0, headerBits.length);

    // Payload: permutazione indipendente, derivata anche dal salt casuale di questo
    // export (cambia ad ogni export), solo sui canali non riservati all'header.
    const remainingChannels = computeRemainingChannels(totalChannels, headerChannels);
    if (payloadBits.length > remainingChannels.length) throw new Error('CAPACITY_EXCEEDED');
    const payloadSeed = await derivePayloadSeed(password, salt);
    const payloadOrder = await computeChannelOrder(payloadSeed, remainingChannels.length);

    for (let i=0;i<headerBits.length;i++){
      writeBitAtChannel(imageData.data, headerChannels[i], headerBits[i]);
    }
    for (let i=0;i<payloadBits.length;i++){
      writeBitAtChannel(imageData.data, remainingChannels[payloadOrder[i]], payloadBits[i]);
    }
  }

  async function extractPayload(imageData, password){
    const totalChannels = totalChannelsOf(imageData);

    const headerSeed = await deriveHeaderSeed(password);
    const headerOrder = await computeChannelOrder(headerSeed, totalChannels);
    const headerChannels = headerOrder.slice(0, STEGO_HEADER_BITS);

    // Legge sempre i 288 bit dell'header attraverso la permutazione fissa. Con password
    // sbagliata 'headerOrder' è un'altra permutazione: i bit sono indistinguibili da
    // rumore e il controllo sotto fallisce quasi certamente, come per un'immagine che
    // non è un vault — nessun oracolo "è un vault sì/no".
    const headerBits = new Uint8Array(STEGO_HEADER_BITS);
    for (let i=0;i<STEGO_HEADER_BITS;i++){
      headerBits[i] = readBitAtChannel(imageData.data, headerChannels[i]);
    }
    const headerBytes = bitsToBytes(headerBits);
    const hdv = new DataView(headerBytes.buffer);
    const iterations = hdv.getUint32(0, false);
    const salt = headerBytes.slice(4, 20);
    const iv = headerBytes.slice(20, 32);
    const payloadLen = hdv.getUint32(32, false);

    const remainingChannels = computeRemainingChannels(totalChannels, headerChannels);
    const maxPossiblePayload = Math.floor(remainingChannels.length / 8);
    // Le iterazioni lette dall'header devono coincidere esattamente con PBKDF2_ITERATIONS.
    if (payloadLen <= 0 || payloadLen > maxPossiblePayload || iterations !== PBKDF2_ITERATIONS){
      throw new Error('DECRYPT_FAILED');
    }

    // Payload: stessa permutazione usata in scrittura, derivata dal salt letto dall'header.
    const payloadSeed = await derivePayloadSeed(password, salt);
    const payloadOrder = await computeChannelOrder(payloadSeed, remainingChannels.length);
    const payloadBits = new Uint8Array(payloadLen*8);
    for (let i=0;i<payloadBits.length;i++){
      payloadBits[i] = readBitAtChannel(imageData.data, remainingChannels[payloadOrder[i]]);
    }
    const ciphertext = bitsToBytes(payloadBits);
    return { iterations, salt, iv, ciphertext };
  }

  // Apre un vault: estrae dal PNG e decifra. Errore unico se password errata
  // o file non valido (nessun oracolo).
  async function openVault(imageData, password){
    const r = await extractPayload(imageData, password);
    const obj = await decryptVault(password, r.iterations, r.salt, r.iv, r.ciphertext);
    if (!obj || !Array.isArray(obj.entries)) throw new Error('DECRYPT_FAILED');
    return obj;
  }

  window.VaultCrypto = Object.freeze({
    PBKDF2_ITERATIONS, STEGO_HEADER_BYTES,
    encryptVault, decryptVault, embedPayload, extractPayload, capacityBytes, openVault
  });
})();
