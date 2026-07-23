/* ======================================================================
   KEUANGAN — Pribadi, Rental Eksa, Sawit, Walet
   Data disimpan di Cloudflare Worker (server yang sama dengan alarm push),
   dikunci pakai vaultId (hash dari passphrase). Semua aksi offline-first:
   langsung keliatan di layar + dicoba kirim ke server; kalau gagal, masuk
   antrian dan otomatis dikirim ulang begitu online lagi.
   ====================================================================== */

const FIN_BUSINESSES = ['pribadi','rental_eksa','sawit','walet'];
const FIN_BIZ_LABEL = {pribadi:'Pribadi', rental_eksa:'Rental Eksa', sawit:'Sawit', walet:'Walet'};
const FIN_CATEGORY_PRESET = {
  pribadi: ['Gaji','Makan','Transport','Belanja','Tagihan','Lain-lain'],
  rental_eksa: ['Perawatan','Sparepart','Lain-lain'],
  sawit: ['Panen','Pupuk','Upah Panen','Lain-lain'],
  walet: ['Panen Sarang','Listrik','Perawatan','Lain-lain'],
};
const FIN_MONTHS = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];

/* ---------------- Vault (passphrase -> vaultId) ---------------- */
async function finHash(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function finGetVaultId(){ return localStorage.getItem('rutin_vault_id')||''; }
function finGetPassLocal(){ return localStorage.getItem('rutin_vault_pass')||''; }
async function finSetupVault(passphrase){
  const vid = await finHash('rutin-finance-v1:'+passphrase);
  localStorage.setItem('rutin_vault_id', vid);
  localStorage.setItem('rutin_vault_pass', passphrase);
  return vid;
}
function finClearVault(){
  localStorage.removeItem('rutin_vault_id');
  localStorage.removeItem('rutin_vault_pass');
}

/* ---------------- Cache lokal (biar tetap bisa dibuka offline) ---------------- */
function finGetCacheTx(){ try{ return JSON.parse(localStorage.getItem('fin_cache_tx'))||{pribadi:[],rental_eksa:[],sawit:[],walet:[]}; }catch(e){ return {pribadi:[],rental_eksa:[],sawit:[],walet:[]}; } }
function finSetCacheTx(data){ localStorage.setItem('fin_cache_tx', JSON.stringify(data)); }
// Cache foto nota/bukti pengeluaran Eksa — {fotoId: dataUrl}. Foto DISIMPAN TERPISAH dari
// tx (baik di server maupun cache lokal ini), biar cache tx utama gak membengkak. Diambil
// lazy (batch-get) pas render Pengeluaran Eksa, bukan di-sync penuh kayak akun/kategori.
function finGetCacheFotos(){ try{ return JSON.parse(localStorage.getItem('fin_cache_fotos'))||{}; }catch(e){ return {}; } }
function finSetCacheFotos(data){ localStorage.setItem('fin_cache_fotos', JSON.stringify(data)); }
function finGetCacheUnits(){ try{ return JSON.parse(localStorage.getItem('fin_cache_units'))||[]; }catch(e){ return []; } }
function finSetCacheUnits(units){ localStorage.setItem('fin_cache_units', JSON.stringify(units)); }
function finGetCacheHm(){ try{ return JSON.parse(localStorage.getItem('fin_cache_hm'))||{}; }catch(e){ return {}; } } // {unitId:[...]}
function finSetCacheHm(data){ localStorage.setItem('fin_cache_hm', JSON.stringify(data)); }
function finGetCacheRates(){ try{ return JSON.parse(localStorage.getItem('fin_cache_rates'))||{}; }catch(e){ return {}; } } // {unitId:[...]}
function finSetCacheRates(data){ localStorage.setItem('fin_cache_rates', JSON.stringify(data)); }
function finGetHmForUnit(unitId){ return finGetCacheHm()[unitId]||[]; }
function finGetRatesForUnit(unitId){ return finGetCacheRates()[unitId]||[]; }
function finGetCacheConfirm(){ try{ return JSON.parse(localStorage.getItem('fin_cache_eksaconfirm'))||{}; }catch(e){ return {}; } } // {unitId:{monthKey:{pemasukan,pemasukanTxId,pengeluaran,pengeluaranTxId}}}
function finSetCacheConfirm(data){ localStorage.setItem('fin_cache_eksaconfirm', JSON.stringify(data)); }
function finGetConfirmForUnit(unitId, monthKey){ return ((finGetCacheConfirm()[unitId]||{})[monthKey]) || {pemasukan:false, pengeluaran:false}; }
function finGetCacheAccounts(){ try{ return JSON.parse(localStorage.getItem('fin_cache_accounts'))||[]; }catch(e){ return []; } }
function finSetCacheAccounts(data){ localStorage.setItem('fin_cache_accounts', JSON.stringify(data)); }
function finGetCacheSaldo(){ try{ return JSON.parse(localStorage.getItem('fin_cache_saldo'))||{}; }catch(e){ return {}; } } // {accountId:[{monthKey,amount}, ...]}
function finSetCacheSaldo(data){ localStorage.setItem('fin_cache_saldo', JSON.stringify(data)); }
function finGetSaldoHistoryForAccount(accountId){ return finGetCacheSaldo()[accountId]||[]; }
function finGetCacheCategories(){ try{ return JSON.parse(localStorage.getItem('fin_cache_categories'))||{}; }catch(e){ return {}; } } // {business:[...]}
function finSetCacheCategories(data){ localStorage.setItem('fin_cache_categories', JSON.stringify(data)); }
function finGetCategoriesFor(business){ return finGetCacheCategories()[business]||[]; }
function finGetCachePanen(){ try{ return JSON.parse(localStorage.getItem('fin_cache_panen'))||[]; }catch(e){ return []; } }
function finSetCachePanen(data){ localStorage.setItem('fin_cache_panen', JSON.stringify(data)); }
function finGetCacheSawitRates(){ try{ return JSON.parse(localStorage.getItem('fin_cache_sawit_rates'))||[]; }catch(e){ return []; } }
function finSetCacheSawitRates(data){ localStorage.setItem('fin_cache_sawit_rates', JSON.stringify(data)); }
function finGetCacheSawitProfil(){ try{ return JSON.parse(localStorage.getItem('fin_cache_sawit_profil'))||{luasHektar:0,tahunTanam:0,jumlahPohon:0}; }catch(e){ return {luasHektar:0,tahunTanam:0,jumlahPohon:0}; } }
function finSetCacheSawitProfil(data){ localStorage.setItem('fin_cache_sawit_profil', JSON.stringify(data)); }

/* ---------------- Antrian offline-sync ---------------- */
function finGetQueue(){ try{ return JSON.parse(localStorage.getItem('fin_queue'))||[]; }catch(e){ return []; } }
function finSetQueue(q){ localStorage.setItem('fin_queue', JSON.stringify(q)); finRenderQueueBadge(); }
function finQueuePush(kind, payload){
  const q = finGetQueue();
  q.push({qid:'q'+Date.now()+Math.random().toString(36).slice(2,6), kind, payload, createdAt:Date.now()});
  finSetQueue(q);
}
function finRenderQueueBadge(){
  const el = document.getElementById('finQueueBadge'); if(!el) return;
  const n = finGetQueue().length;
  el.textContent = n>0 ? n+' belum sinkron' : '';
}

const FIN_ENDPOINT = {
  'tx-add':'/finance/add', 'tx-update':'/finance/update', 'tx-delete':'/finance/delete',
  'hm-add':'/finance/eksa/hm/add', 'hm-delete':'/finance/eksa/hm/delete',
  'rate-add':'/finance/eksa/rates/add', 'rate-delete':'/finance/eksa/rates/delete',
  'unit-add':'/finance/eksa/units/add', 'unit-rename':'/finance/eksa/units/rename', 'unit-delete':'/finance/eksa/units/delete',
  'unit-set-accounts':'/finance/eksa/units/set-accounts',
  'eksa-confirm-set':'/finance/eksa/confirm/set',
  'acct-add':'/finance/accounts/add', 'acct-rename':'/finance/accounts/rename', 'acct-delete':'/finance/accounts/delete',
  'acct-saldo-set':'/finance/accounts/saldo/set',
  'cat-add':'/finance/categories/add', 'cat-delete':'/finance/categories/delete',
  'nota-foto-upload':'/finance/eksa/pengeluaran/foto/upload', 'nota-foto-delete':'/finance/eksa/pengeluaran/foto/delete',
  'panen-add':'/finance/sawit/panen/add', 'panen-delete':'/finance/sawit/panen/delete',
  'sawit-rate-add':'/finance/sawit/rates/add', 'sawit-rate-delete':'/finance/sawit/rates/delete',
  'sawit-profil-set':'/finance/sawit/profil/set',
};
// dilempar kalau server BENERAN nolak requestnya (misal data gak valid) — beda dari
// gagal fetch karena offline. Kalau ini yang kejadian, jangan diam-diam dimasukin
// antrian, karena diulang berapa kali juga bakal ditolak lagi sama server.
class FinHttpError extends Error{
  constructor(status, message){ super(message); this.status=status; this.isHttpError=true; }
}
function finApiRaw(kind, body){
  return fetch(PUSH_SERVER_URL+FIN_ENDPOINT[kind], {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  }).then(async r=>{
    if(!r.ok){ const msg = await r.text().catch(()=>''); throw new FinHttpError(r.status, msg||('HTTP '+r.status)); }
    return r.json();
  });
}
function finApiPath(path, body){
  return fetch(PUSH_SERVER_URL+path, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  }).then(async r=>{
    if(!r.ok){ const msg = await r.text().catch(()=>''); throw new FinHttpError(r.status, msg||('HTTP '+r.status)); }
    return r.json();
  });
}
// dipanggil di tiap catch() aksi offline-first: kalau server BENERAN nolak, kasih tau
// user langsung (jangan diam-diam masuk antrian gagal-terus); kalau bukan, baru diantrikan.
function finHandleSaveError(e, kind, payload){
  if(e && e.isHttpError){ showToast('Gagal simpan: '+e.message); return; }
  finQueuePush(kind, payload);
}

let finFlushing = false;
async function finFlushQueue(){
  if(finFlushing) return;
  const vaultId = finGetVaultId(); if(!vaultId) return;
  finFlushing = true;
  let droppedCount = 0;
  try{
    let q = finGetQueue();
    while(q.length){
      const item = q[0];
      try{
        await finApiRaw(item.kind, {...item.payload, vaultId});
        q.shift();
        finSetQueue(q);
      }catch(err){
        if(err && err.isHttpError){
          // server BENERAN nolak item ini (bukan soal jaringan) — kalau diulang lagi juga
          // bakal ditolak lagi. Buang item ini aja biar antrian di belakangnya gak ikut macet.
          console.error('Item antrian gagal permanen, dibuang:', item, err.message);
          q.shift();
          finSetQueue(q);
          droppedCount++;
          continue;
        }
        break; // masih offline / server gak bisa dihubungi, coba lagi nanti
      }
    }
  } finally {
    finFlushing = false;
    if(droppedCount>0) showToast(droppedCount+' item gagal permanen & dibuang dari antrian — cek lagi datanya');
  }
}
window.addEventListener('online', finFlushQueue);
setInterval(finFlushQueue, 20000);

/* ---------------- Aksi tingkat tinggi (optimistic + queue-on-fail) ---------------- */
function finNewId(prefix){ return prefix+Date.now()+Math.random().toString(36).slice(2,6); }

async function finAddTx(business, partial){
  const tx = {
    id: finNewId('t'),
    type: partial.type==='out'?'out':'in',
    amount: Number(partial.amount)||0,
    category: (partial.category||'').trim(),
    note: (partial.note||'').trim(),
    date: partial.date || finTodayStr(),
    account: partial.account || '',
  };
  if(Array.isArray(partial.items)) tx.items = partial.items;
  if(Array.isArray(partial.notaFotoIds)) tx.notaFotoIds = partial.notaFotoIds;
  const cache = finGetCacheTx(); cache[business] = cache[business]||[]; cache[business].push(tx); finSetCacheTx(cache);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('tx-add', {vaultId, business, tx}); }
  catch(e){ finHandleSaveError(e, 'tx-add', {business, tx}); }
  return tx;
}
async function finUpdateTx(business, tx){
  const cache = finGetCacheTx();
  const idx = (cache[business]||[]).findIndex(t=>t.id===tx.id);
  if(idx>-1) cache[business][idx]=tx;
  finSetCacheTx(cache);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('tx-update', {vaultId, business, tx}); }
  catch(e){ finHandleSaveError(e, 'tx-update', {business, tx}); }
}
async function finDeleteTx(business, txId){
  const cache = finGetCacheTx();
  const removed = (cache[business]||[]).find(t=>t.id===txId);
  cache[business] = (cache[business]||[]).filter(t=>t.id!==txId);
  finSetCacheTx(cache);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('tx-delete', {vaultId, business, txId}); }
  catch(e){ finHandleSaveError(e, 'tx-delete', {business, txId}); }
  // best-effort: hapus juga foto nota yang nempel (server udah otomatis hapus pas tx-delete
  // sukses langsung, tapi kalau itu tadi masuk antrian offline, foto belum ke-cleanup di
  // server — gapapa, itemnya numpuk dikit doang, gak kritis)
  if(removed?.notaFotoIds?.length){
    const fcache = finGetCacheFotos();
    removed.notaFotoIds.forEach(fid=>delete fcache[fid]);
    finSetCacheFotos(fcache);
  }
}
// Upload 1 foto nota ke server (dipanggil pas simpan pengeluaran Eksa yang ada foto barunya).
async function finUploadNotaFoto(fotoId, dataUrl){
  const fcache = finGetCacheFotos(); fcache[fotoId] = dataUrl; finSetCacheFotos(fcache);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('nota-foto-upload', {vaultId, fotoId, dataUrl}); }
  catch(e){ finHandleSaveError(e, 'nota-foto-upload', {fotoId, dataUrl}); }
}
// Ambil foto-foto yang belum ada di cache lokal (dipanggil pas render list Pengeluaran Eksa).
async function finEnsureNotaFotos(fotoIds){
  const fcache = finGetCacheFotos();
  const missing = fotoIds.filter(fid=>!fcache[fid]);
  if(!missing.length) return false;
  const vaultId = finGetVaultId(); if(!vaultId) return false;
  try{
    const result = await finApiPath('/finance/eksa/pengeluaran/foto/batch-get', {vaultId, fotoIds:missing});
    const fcache2 = finGetCacheFotos();
    Object.assign(fcache2, result);
    finSetCacheFotos(fcache2);
    return true;
  }catch(e){ return false; }
}
// Kompres foto ke JPEG max lebar 1000px sebelum disimpan (sama kayak fitur Catatan) —
// biar ukuran datanya wajar buat dikirim & disimpan di server.
function finCompressImageFile(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ev=>{
      const img = new Image();
      img.onload = ()=>{
        const maxW = 1000; const scale = Math.min(1, maxW/img.width);
        const canvas = document.createElement('canvas');
        canvas.width = img.width*scale; canvas.height = img.height*scale;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img,0,0,canvas.width,canvas.height);
        resolve(canvas.toDataURL('image/jpeg',0.7));
      };
      img.onerror = reject;
      img.src = ev.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function finAddHm(unitId, tgl, hmAwal, hmAkhir){
  const entry = { id:finNewId('hm'), tgl, hmAwal:Number(hmAwal), hmAkhir:Number(hmAkhir), dur:Math.round((Number(hmAkhir)-Number(hmAwal))*10)/10 };
  const all = finGetCacheHm(); all[unitId] = all[unitId]||[]; all[unitId].push(entry); all[unitId].sort((a,b)=>a.tgl.localeCompare(b.tgl)); finSetCacheHm(all);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('hm-add', {vaultId, unitId, id:entry.id, tgl, hmAwal:entry.hmAwal, hmAkhir:entry.hmAkhir}); }
  catch(e){ finHandleSaveError(e, 'hm-add', {unitId, id:entry.id, tgl, hmAwal:entry.hmAwal, hmAkhir:entry.hmAkhir}); }
  return entry;
}
async function finDeleteHm(unitId, id){
  const all = finGetCacheHm(); all[unitId] = (all[unitId]||[]).filter(r=>r.id!==id); finSetCacheHm(all);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('hm-delete', {vaultId, unitId, id}); }
  catch(e){ finHandleSaveError(e, 'hm-delete', {unitId, id}); }
}

async function finAddRate(unitId, effectiveFrom, rates){
  const all = finGetCacheRates(); const list = all[unitId]||[];
  const idx = list.findIndex(r=>r.effectiveFrom===effectiveFrom);
  const entry = {effectiveFrom, ...rates};
  if(idx>-1) list[idx]=entry; else list.push(entry);
  list.sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom));
  all[unitId] = list; finSetCacheRates(all);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('rate-add', {vaultId, unitId, effectiveFrom, rates}); }
  catch(e){ finHandleSaveError(e, 'rate-add', {unitId, effectiveFrom, rates}); }
}
async function finDeleteRate(unitId, effectiveFrom){
  const all = finGetCacheRates(); const list = all[unitId]||[];
  if(list.length<=1){ showToast('Minimal harus ada 1 rate aktif'); return; }
  all[unitId] = list.filter(r=>r.effectiveFrom!==effectiveFrom); finSetCacheRates(all);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('rate-delete', {vaultId, unitId, effectiveFrom}); }
  catch(e){ finHandleSaveError(e, 'rate-delete', {unitId, effectiveFrom}); }
}

/* ---- Konfirmasi pendapatan/gaji operator Eksa: dari "kalkulasi doang" jadi transaksi beneran ----
   Input HM cuma ngasih tau BERAPA seharusnya, bukan berarti duitnya udah pindah tangan.
   Baru kehitung ke saldo akun (lewat finBusinessMonthNet & finAccountMonthDelta) begitu
   ditandain lewat salah satu fungsi di bawah ini, yang bikin FinanceTx beneran. */
async function finSetConfirmEntry(unitId, monthKey, entry){
  const all = finGetCacheConfirm(); all[unitId] = all[unitId]||{}; all[unitId][monthKey] = entry; finSetCacheConfirm(all);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('eksa-confirm-set', {vaultId, unitId, monthKey, entry}); }
  catch(e){ finHandleSaveError(e, 'eksa-confirm-set', {unitId, monthKey, entry}); }
}
async function finConfirmEksaPemasukan(unitId, monthKey){
  const unit = finGetCacheUnits().find(u=>u.id===unitId); if(!unit) return;
  const r = finEksaUnitMonthNet(unitId, monthKey);
  if(!(r.pendapatan>0)){ showToast('Belum ada pendapatan buat bulan ini'); return; }
  const entry = finGetConfirmForUnit(unitId, monthKey);
  const tx = await finAddTx('rental_eksa', {
    type:'in', amount:r.pendapatan, category:'Pendapatan Sewa', account: unit.incomeAccountId||'',
    date: finConfirmDateForMonth(monthKey), note: `Pendapatan ${unit.name} - ${finMonthLabel(finParseMonthKey(monthKey))}`
  });
  await finSetConfirmEntry(unitId, monthKey, {...entry, pemasukan:true, pemasukanTxId:tx.id});
}
async function finConfirmEksaPengeluaran(unitId, monthKey){
  const unit = finGetCacheUnits().find(u=>u.id===unitId); if(!unit) return;
  const r = finEksaUnitMonthNet(unitId, monthKey);
  if(!(r.gajiOperator>0)){ showToast('Belum ada gaji operator buat bulan ini'); return; }
  const entry = finGetConfirmForUnit(unitId, monthKey);
  const tx = await finAddTx('rental_eksa', {
    type:'out', amount:r.gajiOperator, category:'Gaji Operator', account: unit.salaryAccountId||'',
    date: finConfirmDateForMonth(monthKey), note: `Gaji Operator ${unit.name} - ${finMonthLabel(finParseMonthKey(monthKey))}`
  });
  await finSetConfirmEntry(unitId, monthKey, {...entry, pengeluaran:true, pengeluaranTxId:tx.id});
}
async function finUnconfirmEksa(unitId, monthKey, field){
  const entry = finGetConfirmForUnit(unitId, monthKey);
  const txId = field==='pemasukan' ? entry.pemasukanTxId : entry.pengeluaranTxId;
  if(txId) await finDeleteTx('rental_eksa', txId);
  const next = {...entry};
  if(field==='pemasukan'){ next.pemasukan=false; next.pemasukanTxId=undefined; }
  else { next.pengeluaran=false; next.pengeluaranTxId=undefined; }
  await finSetConfirmEntry(unitId, monthKey, next);
}

async function finAddUnit(name){
  const unit = {id:finNewId('u'), name};
  const units = finGetCacheUnits(); units.push(unit); finSetCacheUnits(units);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('unit-add', {vaultId, id:unit.id, name}); }
  catch(e){ finHandleSaveError(e, 'unit-add', {id:unit.id, name}); }
  return unit;
}
async function finDeleteUnit(unitId){
  const units = finGetCacheUnits();
  if(units.length<=1){ showToast('Minimal harus ada 1 unit Eksa'); return; }
  finSetCacheUnits(units.filter(u=>u.id!==unitId));
  const hmAll = finGetCacheHm(); delete hmAll[unitId]; finSetCacheHm(hmAll);
  const ratesAll = finGetCacheRates(); delete ratesAll[unitId]; finSetCacheRates(ratesAll);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('unit-delete', {vaultId, unitId}); }
  catch(e){ finHandleSaveError(e, 'unit-delete', {unitId}); }
}
async function finRenameUnit(unitId, name){
  const units = finGetCacheUnits();
  const u = units.find(x=>x.id===unitId); if(u) u.name = name;
  finSetCacheUnits(units);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('unit-rename', {vaultId, unitId, name}); }
  catch(e){ finHandleSaveError(e, 'unit-rename', {unitId, name}); }
}
async function finSetUnitAccounts(unitId, incomeAccountId, salaryAccountId){
  const units = finGetCacheUnits();
  const u = units.find(x=>x.id===unitId); if(u){ u.incomeAccountId=incomeAccountId; u.salaryAccountId=salaryAccountId; }
  finSetCacheUnits(units);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('unit-set-accounts', {vaultId, unitId, incomeAccountId, salaryAccountId}); }
  catch(e){ finHandleSaveError(e, 'unit-set-accounts', {unitId, incomeAccountId, salaryAccountId}); }
}

async function finAddAccount(name){
  const acc = {id:finNewId('acc'), name};
  const accounts = finGetCacheAccounts(); accounts.push(acc); finSetCacheAccounts(accounts);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('acct-add', {vaultId, id:acc.id, name}); }
  catch(e){ finHandleSaveError(e, 'acct-add', {id:acc.id, name}); }
  return acc;
}
async function finRenameAccount(accountId, name){
  const accounts = finGetCacheAccounts();
  const a = accounts.find(x=>x.id===accountId); if(a) a.name=name;
  finSetCacheAccounts(accounts);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('acct-rename', {vaultId, accountId, name}); }
  catch(e){ finHandleSaveError(e, 'acct-rename', {accountId, name}); }
}
async function finDeleteAccount(accountId){
  finSetCacheAccounts(finGetCacheAccounts().filter(a=>a.id!==accountId));
  const vaultId = finGetVaultId();
  try{ await finApiRaw('acct-delete', {vaultId, accountId}); }
  catch(e){ finHandleSaveError(e, 'acct-delete', {accountId}); }
}
// Set/koreksi checkpoint saldo 1 akun di 1 bulan tertentu. Ini BUKAN alokasi ulang tiap
// bulan — checkpoint ini otomatis jadi modal buat bulan-bulan berikutnya juga (lihat
// finAccountBalanceUpTo). Cukup diisi sekali (modal awal akun) atau sesekali kalau mau
// koreksi manual (misal biar pas sama saldo rekening asli).
async function finSetSaldoAwal(monthKey, accountId, amount){
  const all = finGetCacheSaldo();
  const hist = all[accountId] = all[accountId]||[];
  const idx = hist.findIndex(h=>h.monthKey===monthKey);
  if(idx>-1) hist[idx] = {monthKey, amount}; else hist.push({monthKey, amount});
  hist.sort((a,b)=>a.monthKey.localeCompare(b.monthKey));
  finSetCacheSaldo(all);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('acct-saldo-set', {vaultId, monthKey, accountId, amount}); }
  catch(e){ finHandleSaveError(e, 'acct-saldo-set', {monthKey, accountId, amount}); }
}

async function finAddCategory(business, name){
  const all = finGetCacheCategories(); all[business] = all[business]||[];
  if(!all[business].includes(name)) all[business].push(name);
  finSetCacheCategories(all);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('cat-add', {vaultId, business, name}); }
  catch(e){ finHandleSaveError(e, 'cat-add', {business, name}); }
}
async function finDeleteCategory(business, name){
  const all = finGetCacheCategories(); all[business] = (all[business]||[]).filter(c=>c!==name);
  finSetCacheCategories(all);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('cat-delete', {vaultId, business, name}); }
  catch(e){ finHandleSaveError(e, 'cat-delete', {business, name}); }
}

/* ---------------- SAWIT: panen harian, riwayat harga TBS, data kebun ---------------- */
async function finAddPanen(tgl, kg){
  const entry = { id:finNewId('panen'), tgl, kg:Number(kg) };
  const rows = finGetCachePanen(); rows.push(entry); rows.sort((a,b)=>a.tgl.localeCompare(b.tgl)); finSetCachePanen(rows);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('panen-add', {vaultId, id:entry.id, tgl, kg:entry.kg}); }
  catch(e){ finHandleSaveError(e, 'panen-add', {id:entry.id, tgl, kg:entry.kg}); }
  return entry;
}
async function finDeletePanen(id){
  finSetCachePanen(finGetCachePanen().filter(r=>r.id!==id));
  const vaultId = finGetVaultId();
  try{ await finApiRaw('panen-delete', {vaultId, id}); }
  catch(e){ finHandleSaveError(e, 'panen-delete', {id}); }
}
async function finAddSawitRate(effectiveFrom, rates){
  const list = finGetCacheSawitRates();
  const idx = list.findIndex(r=>r.effectiveFrom===effectiveFrom);
  const entry = {effectiveFrom, ...rates};
  if(idx>-1) list[idx]=entry; else list.push(entry);
  list.sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom));
  finSetCacheSawitRates(list);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('sawit-rate-add', {vaultId, effectiveFrom, rates}); }
  catch(e){ finHandleSaveError(e, 'sawit-rate-add', {effectiveFrom, rates}); }
}
async function finDeleteSawitRate(effectiveFrom){
  const list = finGetCacheSawitRates();
  if(list.length<=1){ showToast('Minimal harus ada 1 rate aktif'); return; }
  finSetCacheSawitRates(list.filter(r=>r.effectiveFrom!==effectiveFrom));
  const vaultId = finGetVaultId();
  try{ await finApiRaw('sawit-rate-delete', {vaultId, effectiveFrom}); }
  catch(e){ finHandleSaveError(e, 'sawit-rate-delete', {effectiveFrom}); }
}
async function finSetSawitProfil(profil){
  finSetCacheSawitProfil(profil);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('sawit-profil-set', {vaultId, profil}); }
  catch(e){ finHandleSaveError(e, 'sawit-profil-set', {profil}); }
}

/* ---------------- Sinkron penuh dari server ---------------- */
async function finSyncAll(){
  const vaultId = finGetVaultId(); if(!vaultId) return;
  await finFlushQueue();
  if(finGetQueue().length) return; // masih ada yang mengantri / lagi offline, jangan timpa cache lokal
  try{
    const txRes = await finApiPath('/finance/list', {vaultId});
    finSetCacheTx(txRes);
    const units = await finApiPath('/finance/eksa/units/list', {vaultId});
    finSetCacheUnits(units);
    const hmAll = {}, ratesAll = {}, confirmAll = {};
    for(const u of units){
      hmAll[u.id] = await finApiPath('/finance/eksa/hm/list', {vaultId, unitId:u.id});
      ratesAll[u.id] = await finApiPath('/finance/eksa/rates/list', {vaultId, unitId:u.id});
      confirmAll[u.id] = await finApiPath('/finance/eksa/confirm/list', {vaultId, unitId:u.id});
    }
    finSetCacheHm(hmAll);
    finSetCacheRates(ratesAll);
    finSetCacheConfirm(confirmAll);
    for(const u of units){
      if(!ratesAll[u.id] || ratesAll[u.id].length===0) await finSeedDefaultRates(u.id);
    }
    const accounts = await finApiPath('/finance/accounts/list', {vaultId});
    finSetCacheAccounts(accounts);
    const saldoHist = await finApiPath('/finance/accounts/saldo/list', {vaultId});
    finSetCacheSaldo(saldoHist);
    const panen = await finApiPath('/finance/sawit/panen/list', {vaultId});
    finSetCachePanen(panen);
    const sawitRates = await finApiPath('/finance/sawit/rates/list', {vaultId});
    finSetCacheSawitRates(sawitRates);
    const sawitProfil = await finApiPath('/finance/sawit/profil/get', {vaultId});
    finSetCacheSawitProfil(sawitProfil);
    let cats = await finApiPath('/finance/categories/list', {vaultId, business:'pribadi'});
    if(!cats.length){
      for(const c of ['Gaji','Makan','Transport','Belanja','Tagihan','Lain-lain']) await finAddCategory('pribadi', c);
      cats = finGetCategoriesFor('pribadi');
    }
    const allCats = finGetCacheCategories(); allCats.pribadi = cats; finSetCacheCategories(allCats);
    if(!finActiveEksaUnit || !units.find(u=>u.id===finActiveEksaUnit)) finActiveEksaUnit = units[0] ? units[0].id : null;
    renderKeuanganBody();
  }catch(e){ /* offline — biarin pakai cache lama */ }
}
async function finSeedDefaultRates(unitId){
  // Rate dasar (sama seperti app HM Eksavator lama, 3 tier gaji operator) + penyesuaian yang mulai berlaku Mei 2026
  await finAddRate(unitId, '2000-01', {gajiPerHM:275000, ppnPct:2, tunjanganHarian:50000, gajiOperatorHM:50000, gajiOperatorLebih:60000, batasHM:175, batasHM2:200, gajiOperatorLebih2:70000, tunjanganOperatorHarian:100000});
  await finAddRate(unitId, '2026-05', {gajiPerHM:275000, ppnPct:2, tunjanganHarian:50000, gajiOperatorHM:50000, gajiOperatorLebih:60000, batasHM:175, batasHM2:200, gajiOperatorLebih2:70000, tunjanganOperatorHarian:115000});
}

/* ---------------- Rumus Eksa ---------------- */
function finRateForMonth(rates, monthKey){
  const sorted = [...rates].sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom));
  let chosen = sorted[0];
  for(const r of sorted){ if(r.effectiveFrom<=monthKey) chosen=r; }
  return chosen;
}
function finHitungPendapatan(totalHM, hariKerja, r){
  const gross = totalHM * r.gajiPerHM;
  const ppn = gross * r.ppnPct/100;
  return gross - ppn + hariKerja*r.tunjanganHarian;
}
// Mode progresif: tiap `lebarTingkat` HM setelah target, tarif per-HM tambahan naik
// `kenaikanTingkat` lagi dibanding tingkat sebelumnya — gak ada batas atas.
function finHitungGajiProgresif(totalHM, R0, target, lebar, kenaikan){
  if(totalHM<=target) return totalHM*R0;
  let gaji = target*R0;
  let sisa = totalHM - target;
  let tingkat = 1;
  while(sisa>0){
    const jumlahTingkatIni = Math.min(sisa, lebar);
    const tarif = R0 + tingkat*kenaikan;
    gaji += jumlahTingkatIni*tarif;
    sisa -= jumlahTingkatIni;
    tingkat++;
  }
  return gaji;
}
function finHitungGajiOperator(totalHM, hariKerja, r){
  let gajiHM;
  if(r.progresif && r.lebarTingkat>0){
    gajiHM = finHitungGajiProgresif(totalHM, r.gajiOperatorHM, r.batasHM, r.lebarTingkat, r.kenaikanTingkat||0);
  } else {
    const batasHM2 = r.batasHM2 || Infinity; // rate lama yang belum punya tier ke-3 tetap jalan seperti dulu (2 tier)
    const lebih2 = r.gajiOperatorLebih2 || r.gajiOperatorLebih;
    if(totalHM<=r.batasHM){
      gajiHM = totalHM*r.gajiOperatorHM;
    } else if(totalHM<=batasHM2){
      gajiHM = r.batasHM*r.gajiOperatorHM + (totalHM-r.batasHM)*r.gajiOperatorLebih;
    } else {
      gajiHM = r.batasHM*r.gajiOperatorHM + (batasHM2-r.batasHM)*r.gajiOperatorLebih + (totalHM-batasHM2)*lebih2;
    }
  }
  return gajiHM + hariKerja*r.tunjanganOperatorHarian;
}

/* ---------------- Util ---------------- */
function finFmt(n){ return 'Rp'+Math.round(n||0).toLocaleString('id-ID'); }
function finTodayStr(){
  const d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function finAddDaysStr(dateStr, n){
  const [y,m,d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m-1, d+n);
  return dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');
}
// Tanggal terakhir dipakai buat input HM — biar gak jump balik ke "hari ini" tiap sheet
// Input HM di-render ulang (misal abis simpan). Cuma null (jadi default hari ini) pas app
// pertama kali dibuka.
let finHmLastDate = null;
function finFmtN(n){ return parseFloat(parseFloat(n).toFixed(1)); }
function finMonthKey(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }
// Tanggal transaksi konfirmasi pendapatan/gaji Eksa = tanggal HARI INI (pas tombol dipencet),
// bukan tanggal bulan yang lagi dilaporkan. Sengaja gini: kalau HM bulan Juli baru beneran
// dibayar tanggal 3 bulan Agustus, transaksinya harus nyangkut di laporan Agustus (bulan
// duitnya beneran pindah tangan), bukan "dipaksa" balik ke Juli.
function finConfirmDateForMonth(monthKey){
  return finTodayStr();
}
function finMonthLabel(d){ return FIN_MONTHS[d.getMonth()]+' '+d.getFullYear(); }
function finTxInMonth(list, monthKey){ return (list||[]).filter(t=>t.date && t.date.slice(0,7)===monthKey); }
function finHmInMonth(rows, monthKey){ return (rows||[]).filter(r=>r.tgl && r.tgl.slice(0,7)===monthKey); }
function finPanenInMonth(rows, monthKey){ return (rows||[]).filter(r=>r.tgl && r.tgl.slice(0,7)===monthKey); }
function finSumIn(list){ return list.filter(t=>t.type==='in').reduce((s,t)=>s+t.amount,0); }
function finSumOut(list){ return list.filter(t=>t.type==='out').reduce((s,t)=>s+t.amount,0); }

// Cocokin 1 transaksi ke query pencarian bebas (kategori, catatan, tanggal, nominal, dan
// nama tiap barang rincian kalau ada) — dipakai fitur search di Pribadi & Pengeluaran Eksa.
function finTxMatchesQuery(t, q){
  if(!q) return true;
  q = q.trim().toLowerCase();
  if(!q) return true;
  const parts = [
    t.category||'', t.note||'', t.date||'',
    t.date ? t.date.split('-').reverse().join('/') : '',
    String(t.amount||''),
  ];
  if(Array.isArray(t.items)) t.items.forEach(it=>parts.push(it.nama||''));
  return parts.join(' ').toLowerCase().includes(q);
}

// Pendapatan & gaji operator 1 unit Eksa, bulan tertentu (belum dikurangi pengeluaran — itu dihitung gabungan semua unit)
function finEksaUnitMonthNet(unitId, monthKey){
  const rates = finGetRatesForUnit(unitId);
  const confirmed = finGetConfirmForUnit(unitId, monthKey);
  if(!rates.length) return {pendapatan:0, gajiOperator:0, totalHM:0, hariKerja:0, rate:null, confirmed};
  const hmRows = finHmInMonth(finGetHmForUnit(unitId), monthKey);
  const totalHM = finFmtN(hmRows.reduce((s,r)=>s+r.dur,0));
  const hariKerja = hmRows.length;
  const r = finRateForMonth(rates, monthKey);
  const pendapatan = finHitungPendapatan(totalHM, hariKerja, r);
  const gajiOperator = finHitungGajiOperator(totalHM, hariKerja, r);
  return {pendapatan, gajiOperator, totalHM, hariKerja, rate:r, confirmed};
}

// Pendapatan bersih hasil panen Sawit bulan tertentu (belum dikurangi pengeluaran lain —
// itu digabung di finBusinessMonthNet, sama filosofinya kayak Eksa).
function finSawitRateForMonth(monthKey){ return finRateForMonth(finGetCacheSawitRates(), monthKey); }
function finSawitMonthNet(monthKey){
  const rates = finGetCacheSawitRates();
  const rate = rates.length ? finSawitRateForMonth(monthKey) : null;
  const panenRows = finPanenInMonth(finGetCachePanen(), monthKey);
  const totalKg = finFmtN(panenRows.reduce((s,r)=>s+r.kg,0));
  if(!rate) return {totalKg, pendapatanKotor:0, pendapatanBersih:0, upahPanen:0, rate:null};
  const pendapatanKotor = totalKg * rate.hargaPerKg;
  const setelahPotongan = pendapatanKotor * (1 - (rate.potonganPercent||0)/100);
  const pendapatanBersih = setelahPotongan * (1 - (rate.pajakPercent||0)/100);
  const upahPanen = totalKg * (rate.upahPanenPerKg||0);
  return {totalKg, pendapatanKotor, pendapatanBersih, upahPanen, rate};
}

// Laba/rugi bersih 1 bulan untuk 1 bisnis (Eksa = jumlah semua unit dikurangi pengeluaran bareng; yang lain simpel masuk-keluar)
function finBusinessMonthNet(business, monthKey){
  if(business==='rental_eksa'){
    const units = finGetCacheUnits();
    // pendapatan/gajiOperator yang BELUM dikonfirmasi cuma proyeksi — gak boleh ikut kehitung
    // ke Laba Bersih/saldo akun. Yang UDAH dikonfirmasi udah jadi FinanceTx beneran, otomatis
    // ke-hitung lewat finSumIn/finSumOut(tx) di bawah, jadi jangan ditambahin dobel di sini.
    let pendapatanProjeksi=0, gajiOperatorProjeksi=0, totalHM=0, hariKerja=0;
    units.forEach(u=>{
      const r = finEksaUnitMonthNet(u.id, monthKey);
      totalHM += r.totalHM; hariKerja += r.hariKerja;
      if(!r.confirmed.pemasukan) pendapatanProjeksi += r.pendapatan;
      if(!r.confirmed.pengeluaran) gajiOperatorProjeksi += r.gajiOperator;
    });
    const tx = finTxInMonth((finGetCacheTx().rental_eksa||[]), monthKey);
    const masukAktual = finSumIn(tx);   // termasuk pendapatan sewa yg udah dikonfirmasi + pemasukan lain
    const keluarAktual = finSumOut(tx); // termasuk gaji operator yg udah dikonfirmasi + pengeluaran lain (sparepart dll)
    const net = masukAktual - keluarAktual;
    return {
      pendapatanProjeksi, gajiOperatorProjeksi,
      masukAktual, keluarAktual, net,
      totalHM:finFmtN(totalHM), hariKerja,
    };
  }
  if(business==='sawit'){
    const r = finSawitMonthNet(monthKey);
    const tx = finTxInMonth((finGetCacheTx().sawit||[]), monthKey);
    const masuk = r.pendapatanBersih + finSumIn(tx);
    const keluar = r.upahPanen + finSumOut(tx);
    return {masuk, keluar, net: masuk-keluar, totalKg:r.totalKg, rate:r.rate};
  }
  const tx = finTxInMonth((finGetCacheTx()[business]||[]), monthKey);
  const masuk = finSumIn(tx), keluar = finSumOut(tx);
  return {masuk, keluar, net: masuk-keluar};
}

// Delta 1 akun di 1 bulan tertentu = semua transaksi (lintas bisnis) yang ditandain ke
// akun itu + pendapatan/gaji operator Eksa yang ditandain ke akun itu di setting unitnya.
function finAccountMonthDelta(accountId, monthKey){
  let delta = 0;
  const txAll = finGetCacheTx();
  Object.keys(txAll).forEach(biz=>{
    finTxInMonth(txAll[biz]||[], monthKey).forEach(t=>{
      if(t.account===accountId) delta += (t.type==='in'? t.amount : -t.amount);
    });
  });
  // CATATAN: dulu di sini ada tambahan otomatis dari finEksaUnitMonthNet (pendapatan/gaji
  // operator Eksa dihitung langsung dari Input HM). Itu DIHAPUS — pendapatan/gaji operator
  // cuma proyeksi/kalkulasi sampai user tandain "sudah diterima/dibayar" di tab Laporan
  // (lihat finConfirmEksaPemasukan/finConfirmEksaPengeluaran), yang baru bikin tx beneran dan
  // otomatis ke-hitung lewat loop tx di atas. Jadi duit yang belum jelas gak nyangkut di saldo.
  return delta;
}
// Saldo akun sampai dengan bulan tertentu (KUMULATIF, bukan cuma bulan itu doang).
// Ambil checkpoint (modal awal/koreksi) paling akhir yang <= bulan target, lalu
// jumlahkan semua transaksi dari bulan checkpoint itu s/d bulan target — jadi laba
// bulan-bulan sebelumnya otomatis nempel jadi modal, gak perlu diisi ulang tiap bulan.
function finAccountBalanceUpTo(accountId, targetMonthKey){
  const history = finGetSaldoHistoryForAccount(accountId);
  let baseline = null;
  history.forEach(h=>{ if(h.monthKey<=targetMonthKey && (!baseline || h.monthKey>baseline.monthKey)) baseline = h; });
  if(!baseline) return 0; // belum pernah diisi modal awal sampai bulan ini
  let balance = baseline.amount;
  let cursor = new Date(finParseMonthKey(baseline.monthKey));
  const target = finParseMonthKey(targetMonthKey);
  while(cursor <= target){
    balance += finAccountMonthDelta(accountId, finMonthKey(cursor));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth()+1, 1);
  }
  return balance;
}
function finParseMonthKey(mk){ const [y,m] = mk.split('-').map(Number); return new Date(y, m-1, 1); }
function finAccountBalanceAll(monthKey){
  const accounts = finGetCacheAccounts();
  const balances = {};
  accounts.forEach(a=>{ balances[a.id] = finAccountBalanceUpTo(a.id, monthKey); });
  return balances;
}
function finSaldoTotal(monthKey){
  return Object.values(finAccountBalanceAll(monthKey)).reduce((s,v)=>s+v,0);
}

/* ---------------- Export data (backup ke file, di luar Cloudflare) ---------------- */
function finExportAll(){
  const data = {
    exportedAt: new Date().toISOString(),
    transaksi: finGetCacheTx(),
    unitEksa: finGetCacheUnits(),
    hmEksa: finGetCacheHm(),
    rateEksa: finGetCacheRates(),
    akun: finGetCacheAccounts(),
    riwayatSaldoAkun: finGetCacheSaldo(),
    kategori: finGetCacheCategories(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'rutin-keuangan-'+new Date().toISOString().slice(0,10)+'.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Data keuangan diunduh');
}
document.getElementById('finExportBtn').addEventListener('click', finExportAll);

/* =======================================================================
   RENDER
   ======================================================================= */
let finActiveBiz = 'ringkasan';
let finEksaSubTab = 'input';
let finActiveEksaUnit = null;
let finMonthCursor = new Date();
let finEditingTx = null; // {business, tx} kalau lagi edit, null kalau tambah baru
let finEditingRate = null; // effectiveFrom kalau lagi edit rate
let finEditingAccount = null; // account id kalau lagi edit akun
let finPribadiSearch = ''; // query pencarian transaksi Pribadi
let finPribadiShowAll = false; // true = tampilin semua transaksi (semua bulan), bukan cuma bulan yang lagi dilihat
let finExpSearch = {rental_eksa:'', sawit:''}; // query pencarian Pengeluaran, per-business (Eksa & Sawit reuse sheet yang sama)
let finExpShowAll = {rental_eksa:false, sawit:false}; // toggle 'semua data' Pengeluaran, per-business
let finTxItems = []; // rincian barang opsional di sheet transaksi biasa (Pribadi/Walet)

function finTxAddItemRow(){
  finTxItems.push({id: finNewId('i'), nama:'', harga:0, jumlah:1});
}
function finTxValidItems(){ return finTxItems.filter(it=>it.nama && it.nama.trim()); }
function finTxRecalcAmount(){
  const valid = finTxValidItems();
  if(!valid.length) return; // belum ada barang yang beneran diisi namanya = Jumlah diisi manual
  const total = valid.reduce((s,it)=>s+(Number(it.harga)||0)*(Number(it.jumlah)||0), 0);
  document.getElementById('finTxAmount').value = total;
}
function finTxSyncAmountFieldMode(){
  const amountInput = document.getElementById('finTxAmount');
  const hasValid = finTxValidItems().length>0;
  amountInput.readOnly = hasValid;
  amountInput.style.opacity = hasValid ? '0.7' : '1';
}
function finTxRenderItemRows(){
  const wrap = document.getElementById('finTxItemsList');
  wrap.innerHTML = finTxItems.map(it=>`
    <div class="fin-item-row" data-id="${it.id}">
      <input type="text" class="fin-item-nama" placeholder="mis. Beras 5kg" value="${escapeHtml(it.nama)}">
      <input type="number" class="fin-item-harga" placeholder="0" value="${it.harga||''}" inputmode="numeric">
      <input type="number" class="fin-item-jumlah" placeholder="1" value="${it.jumlah||''}" inputmode="numeric">
      <button type="button" class="fin-item-remove" data-remove="${it.id}">✕</button>
    </div>
  `).join('');
  wrap.querySelectorAll('.fin-item-row').forEach(row=>{
    const it = finTxItems.find(x=>x.id===row.dataset.id); if(!it) return;
    row.querySelector('.fin-item-nama').addEventListener('input', e=>{ it.nama = e.target.value; finTxSyncAmountFieldMode(); finTxRecalcAmount(); });
    row.querySelector('.fin-item-harga').addEventListener('input', e=>{ it.harga = Number(e.target.value)||0; finTxRecalcAmount(); });
    row.querySelector('.fin-item-jumlah').addEventListener('input', e=>{ it.jumlah = Number(e.target.value)||0; finTxRecalcAmount(); });
  });
  wrap.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      finTxItems = finTxItems.filter(x=>x.id!==btn.dataset.remove);
      finTxRenderItemRows();
      finTxSyncAmountFieldMode();
      finTxRecalcAmount();
    });
  });
  finTxSyncAmountFieldMode();
  finTxRecalcAmount();
}
document.getElementById('finTxAddItemBtn').addEventListener('click', ()=>{
  finTxAddItemRow();
  finTxRenderItemRows();
});
let finSawitSubTab = 'ringkasan';
let finSawitPanenLastDate = null; // sama pola kayak finHmLastDate, biar input panen harian berturut-turut gampang
let finEditingSawitRate = null; // effectiveFrom kalau lagi edit rate Sawit

function renderKeuangan(){
  finRenderQueueBadge();
  if(!finGetVaultId()){
    renderFinVaultSetup();
    return;
  }
  finSyncAll();
  renderKeuanganBody();
}

function renderFinVaultSetup(){
  const wrap = document.getElementById('keuanganContent'); wrap.innerHTML='';
  const box = document.createElement('div'); box.className='fin-vault-box';
  box.innerHTML = `
    <h3>Buka Keuangan</h3>
    <p>Masukin passphrase buat buka/buat data keuangan kamu. Passphrase ini yang mengunci data di server — kalau lupa, data nggak bisa diambil balik. Kalau kamu pernah setup di HP lain, masukin passphrase yang sama persis biar datanya nyambung.</p>
    <div class="field"><label>Passphrase</label><input type="password" id="finPassInput" placeholder="Bikin atau masukin passphrase kamu"></div>
    <button class="btn primary" id="finPassSubmit" style="width:100%;">Buka Keuangan</button>
  `;
  wrap.appendChild(box);
  document.getElementById('finPassSubmit').addEventListener('click', async ()=>{
    const pass = document.getElementById('finPassInput').value;
    if(!pass || pass.length<4){ showToast('Passphrase minimal 4 karakter'); return; }
    await finSetupVault(pass);
    renderKeuangan();
  });
}

function renderKeuanganBody(){
  if(!finGetVaultId()) return;
  if(finActiveBiz==='ringkasan') renderFinRingkasan();
  else if(finActiveBiz==='rental_eksa') renderFinEksa();
  else if(finActiveBiz==='sawit') renderFinSawit();
  else if(finActiveBiz==='pribadi') renderFinPribadi();
  else renderFinSimpleBusiness(finActiveBiz);
}

function finGoBiz(biz){
  finActiveBiz = biz;
  renderKeuanganBody();
}
function finBackLinkHtml(){
  return `<button type="button" class="fin-back-link" id="finBackToRingkasan"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>Ringkasan</button>`;
}
function finWireBackLink(){
  const btn = document.getElementById('finBackToRingkasan');
  if(btn) btn.addEventListener('click', ()=>finGoBiz('ringkasan'));
}

function finMonthNavHtml(){
  return `<div class="fin-month-nav">
    <button type="button" id="finMonthPrev">&lsaquo;</button>
    <div class="fin-month-label">${finMonthLabel(finMonthCursor)}</div>
    <button type="button" id="finMonthNext">&rsaquo;</button>
  </div>`;
}
function finWireMonthNav(afterChange){
  document.getElementById('finMonthPrev').addEventListener('click', ()=>{
    finMonthCursor = new Date(finMonthCursor.getFullYear(), finMonthCursor.getMonth()-1, 1);
    afterChange();
  });
  document.getElementById('finMonthNext').addEventListener('click', ()=>{
    finMonthCursor = new Date(finMonthCursor.getFullYear(), finMonthCursor.getMonth()+1, 1);
    afterChange();
  });
}

/* ---------------- RINGKASAN (Dashboard + Saldo per Akun) ---------------- */
function renderFinRingkasan(){
  const wrap = document.getElementById('keuanganContent'); wrap.innerHTML='';
  const monthKey = finMonthKey(finMonthCursor);
  const main = document.createElement('div');
  main.innerHTML = finMonthNavHtml();
  wrap.appendChild(main);
  finWireMonthNav(renderFinRingkasan);

  const saldoTotal = finSaldoTotal(monthKey);
  const totalCard = document.createElement('div'); totalCard.className='fin-saldo-total-card';
  totalCard.innerHTML = `<div class="fin-saldo-total-label">Saldo Total</div><div class="fin-saldo-total-val">${finFmt(saldoTotal)}</div>`;
  main.appendChild(totalCard);

  // --- Saldo per akun (pindah dari Pribadi — ini soal saldo total, bukan cuma sehari-hari) ---
  const accounts = finGetCacheAccounts();
  const balances = finAccountBalanceAll(monthKey);
  const acctSection = document.createElement('div');
  acctSection.innerHTML = `<div class="fin-section-label">Saldo per Akun</div><div id="finAcctList"></div><button class="btn ghost" id="finAcctAddBtn" style="width:100%; margin-top:8px;">+ Tambah Akun</button>`;
  main.appendChild(acctSection);
  const acctListEl = acctSection.querySelector('#finAcctList');
  acctListEl.innerHTML = accounts.length ? accounts.map(a=>`
    <div class="fin-acct-row" data-id="${a.id}">
      <div class="fin-acct-name">${escapeHtml(a.name)}</div>
      <div class="fin-acct-val" style="color:${(balances[a.id]||0)>=0?'var(--ink)':'var(--danger)'}">${finFmt(balances[a.id]||0)}</div>
    </div>
  `).join('') : '<div class="fin-empty">Belum ada akun. Tambahin BRI/BNI/e-wallet dulu.</div>';
  acctListEl.querySelectorAll('[data-id]').forEach(row=>{
    row.addEventListener('click', ()=>openFinAcctSheet(accounts.find(a=>a.id===row.dataset.id)));
  });
  acctSection.querySelector('#finAcctAddBtn').addEventListener('click', ()=>openFinAcctSheet(null));

  const rowsWrap = document.createElement('div');
  let html = '';
  FIN_BUSINESSES.forEach(biz=>{
    const r = finBusinessMonthNet(biz, monthKey);
    const sub = biz==='rental_eksa'
      ? `${r.hariKerja||0} hari kerja · ${r.totalHM||0} HM`
      : `Masuk ${finFmt(r.masuk)} · Keluar ${finFmt(r.keluar)}`;
    html += `<div class="fin-dash-row" data-goto="${biz}">
      <div>
        <div class="fin-dash-name">${FIN_BIZ_LABEL[biz]}</div>
        <div class="fin-dash-sub">${sub}</div>
      </div>
      <div style="display:flex; align-items:center;">
        <div class="fin-dash-val" style="color:${r.net>=0?'var(--positive)':'var(--danger)'}">${finFmt(r.net)}</div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </div>
    </div>`;
  });
  rowsWrap.innerHTML = html;
  main.appendChild(rowsWrap);
  rowsWrap.querySelectorAll('[data-goto]').forEach(row=>{
    row.addEventListener('click', ()=>finGoBiz(row.dataset.goto));
  });
}

/* ---------------- PRIBADI (khusus pengeluaran sehari-hari + ringkasan bisnis) ---------------- */
function renderFinPribadi(){
  const wrap = document.getElementById('keuanganContent'); wrap.innerHTML='';

  const main = document.createElement('div');
  main.innerHTML = finBackLinkHtml() +
    `<div class="fin-search-row" style="margin-top:12px;">
      <div class="search-bar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input type="text" id="finPribadiSearchInput" placeholder="Cari kategori, catatan, tanggal..." value="${escapeHtml(finPribadiSearch)}"></div>
      <button type="button" class="fin-toggle-chip ${finPribadiShowAll?'active':''}" id="finPribadiShowAllBtn">${finPribadiShowAll?'Semua':'Bulan Ini'}</button>
    </div>
    <div id="finPribadiMonthNavWrap"></div>
    <div id="finPribadiListArea"></div>`;
  wrap.appendChild(main);
  finWireBackLink();

  const monthNavWrap = main.querySelector('#finPribadiMonthNavWrap');
  function renderMonthNavArea(){
    if(finPribadiShowAll){
      monthNavWrap.innerHTML = `<div class="fin-month-nav"><div class="fin-month-label">Semua Transaksi</div></div>`;
    } else {
      monthNavWrap.innerHTML = finMonthNavHtml();
      finWireMonthNav(updatePribadiList);
    }
  }

  function updatePribadiList(){
    renderMonthNavArea();
    const monthKey = finMonthKey(finMonthCursor);
    const cache = finGetCacheTx();
    const base = finPribadiShowAll ? (cache.pribadi||[]) : finTxInMonth(cache.pribadi||[], monthKey);
    const txAll = base.filter(t=>finTxMatchesQuery(t, finPribadiSearch)).sort((a,b)=>b.date.localeCompare(a.date));
    const masuk = finSumIn(txAll), keluar = finSumOut(txAll);
    const listArea = main.querySelector('#finPribadiListArea');
    listArea.innerHTML = `
      <div class="fin-total-card" style="margin-bottom:14px;">
        <div><div class="fin-total-label">Masuk</div><div class="fin-total-val" style="color:var(--positive); font-size:15px;">${finFmt(masuk)}</div></div>
        <div><div class="fin-total-label">Keluar</div><div class="fin-total-val" style="color:var(--danger); font-size:15px;">${finFmt(keluar)}</div></div>
      </div>
      ${txAll.length ? '<div id="finTxList"></div>' : `<div class="fin-empty">${finPribadiSearch ? 'Gak ada transaksi yang cocok.' : (finPribadiShowAll ? 'Belum ada transaksi sama sekali.' : 'Belum ada transaksi bulan ini.')}</div>`}
    `;
    if(txAll.length){
      const listEl = listArea.querySelector('#finTxList');
      listEl.innerHTML = txAll.map(t=>{
        const hasItems = Array.isArray(t.items) && t.items.length;
        const judul = hasItems ? (t.items[0].nama + (t.items.length>1 ? ' +'+(t.items.length-1)+' lainnya' : '')) : (t.category||'Lainnya');
        return `
        <div class="fin-tx-item" data-id="${t.id}">
          <div>
            <div class="fin-tx-cat">${escapeHtml(judul)}</div>
            ${(!hasItems && t.note)?`<div class="fin-tx-note">${escapeHtml(t.note)}</div>`:''}
            <div class="fin-tx-date">${t.date.split('-').reverse().join('/')}${finPribadiShowAll?' · '+finMonthLabel(finParseMonthKey(t.date.slice(0,7))):''}</div>
          </div>
          <div class="fin-tx-amt ${t.type}">${t.type==='out'?'-':'+'}${finFmt(t.amount)}</div>
        </div>
      `;
      }).join('');
      listEl.querySelectorAll('.fin-tx-item').forEach(row=>{
        row.addEventListener('click', ()=>{
          const t = txAll.find(t=>t.id===row.dataset.id);
          openFinTxDetailView(t, ()=>openFinTxSheet('pribadi', t));
        });
      });
    }
  }
  updatePribadiList();

  const searchInput = main.querySelector('#finPribadiSearchInput');
  searchInput.addEventListener('input', ()=>{ finPribadiSearch = searchInput.value; updatePribadiList(); });
  main.querySelector('#finPribadiShowAllBtn').addEventListener('click', ()=>{
    finPribadiShowAll = !finPribadiShowAll;
    renderFinPribadi(); // rebuild penuh biar tombol & label ke-refresh, search tetep kepake dari state
  });

  // --- Pemasukan & pengeluaran dari bisnis (ringkasan, biar keliatan dari Pribadi juga) ---
  const monthKey = finMonthKey(finMonthCursor);
  const bizSection = document.createElement('div');
  let bizHtml = `<div class="fin-section-label">Dari Bisnis</div>`;
  ['rental_eksa','sawit','walet'].forEach(biz=>{
    const r = finBusinessMonthNet(biz, monthKey);
    bizHtml += `<div class="fin-acct-row"><div class="fin-acct-name">${FIN_BIZ_LABEL[biz]}</div><div class="fin-acct-val" style="color:${r.net>=0?'var(--positive)':'var(--danger)'}">${finFmt(r.net)}</div></div>`;
  });
  bizSection.innerHTML = bizHtml;
  wrap.appendChild(bizSection);

  const fab = document.createElement('button');
  fab.className='fin-fab'; fab.innerHTML='+';
  fab.addEventListener('click', ()=>openFinTxSheet('pribadi', null));
  wrap.appendChild(fab);
}

function openFinAcctSheet(acc){
  finEditingAccount = acc ? acc.id : null;
  document.getElementById('finAcctSheetTitle').textContent = acc ? 'Edit Akun' : 'Tambah Akun';
  document.getElementById('finAcctName').value = acc ? acc.name : '';
  const monthKey = finMonthKey(finMonthCursor);
  document.getElementById('finAcctSaldoMonthLabel').textContent = finMonthLabel(finMonthCursor);
  // Defaultnya nilai saldo kumulatif sampai bulan yang lagi dilihat (sudah termasuk carry-forward
  // dari bulan-bulan lalu). Kalau user gak ubah apa-apa & langsung simpan, gak ada efek apapun —
  // ini cuma jadi checkpoint koreksi kalau user beneran ubah angkanya.
  document.getElementById('finAcctSaldoAwal').value = acc ? finAccountBalanceUpTo(acc.id, monthKey) : 0;
  document.getElementById('finAcctDeleteBtn').style.display = acc ? '' : 'none';
  document.getElementById('finAcctOverlay').classList.add('show');
}
document.getElementById('finAcctCancelBtn').addEventListener('click', ()=>document.getElementById('finAcctOverlay').classList.remove('show'));
document.getElementById('finAcctOverlay').addEventListener('click', e=>{ if(e.target.id==='finAcctOverlay') e.currentTarget.classList.remove('show'); });
document.getElementById('finAcctSaveBtn').addEventListener('click', async ()=>{
  const name = document.getElementById('finAcctName').value.trim();
  const saldoAwal = Number(document.getElementById('finAcctSaldoAwal').value)||0;
  if(!name){ showToast('Isi nama akun dulu'); return; }
  const monthKey = finMonthKey(finMonthCursor);
  let accId = finEditingAccount;
  if(accId){ await finRenameAccount(accId, name); }
  else{ const acc = await finAddAccount(name); accId = acc.id; }
  await finSetSaldoAwal(monthKey, accId, saldoAwal);
  document.getElementById('finAcctOverlay').classList.remove('show');
  showToast('Tersimpan');
  renderKeuanganBody();
});
document.getElementById('finAcctDeleteBtn').addEventListener('click', async ()=>{
  if(!finEditingAccount) return;
  if(!confirm('Hapus akun ini? Transaksi yang udah ditandain ke akun ini gak ikut kehapus, cuma tautannya aja yang hilang.')) return;
  await finDeleteAccount(finEditingAccount);
  document.getElementById('finAcctOverlay').classList.remove('show');
  showToast('Akun dihapus');
  renderKeuanganBody();
});

/* ---------------- BISNIS SIMPEL (Sawit/Walet) ---------------- */
function renderFinSimpleBusiness(biz){
  const wrap = document.getElementById('keuanganContent'); wrap.innerHTML='';
  const monthKey = finMonthKey(finMonthCursor);
  const cache = finGetCacheTx();
  const txAll = finTxInMonth(cache[biz]||[], monthKey).sort((a,b)=>b.date.localeCompare(a.date));
  const masuk = finSumIn(txAll), keluar = finSumOut(txAll);

  const main = document.createElement('div');
  main.innerHTML = finBackLinkHtml() + finMonthNavHtml() +
    `<div class="fin-total-card" style="margin-bottom:14px;">
      <div><div class="fin-total-label">Masuk</div><div class="fin-total-val" style="color:var(--positive); font-size:15px;">${finFmt(masuk)}</div></div>
      <div><div class="fin-total-label">Keluar</div><div class="fin-total-val" style="color:var(--danger); font-size:15px;">${finFmt(keluar)}</div></div>
      <div><div class="fin-total-label">Saldo</div><div class="fin-total-val" style="font-size:15px;">${finFmt(masuk-keluar)}</div></div>
    </div>` +
    (txAll.length ? `<div id="finTxList"></div>` : `<div class="fin-empty">Belum ada transaksi bulan ini.<br>Tap tombol + buat nambah.</div>`);
  wrap.appendChild(main);
  finWireBackLink();
  finWireMonthNav(()=>renderFinSimpleBusiness(biz));

  if(txAll.length){
    const listEl = document.getElementById('finTxList');
    listEl.innerHTML = txAll.map(t=>`
      <div class="fin-tx-item" data-id="${t.id}">
        <div>
          <div class="fin-tx-cat">${escapeHtml(t.category||'Lainnya')}</div>
          ${t.note?`<div class="fin-tx-note">${escapeHtml(t.note)}</div>`:''}
          <div class="fin-tx-date">${t.date.split('-').reverse().join('/')}</div>
        </div>
        <div class="fin-tx-amt ${t.type}">${t.type==='out'?'-':'+'}${finFmt(t.amount)}</div>
      </div>
    `).join('');
    listEl.querySelectorAll('.fin-tx-item').forEach(row=>{
      row.addEventListener('click', ()=>{
        const tx = txAll.find(t=>t.id===row.dataset.id);
        openFinTxSheet(biz, tx);
      });
    });
  }

  const fab = document.createElement('button');
  fab.className='fin-fab'; fab.innerHTML='+';
  fab.addEventListener('click', ()=>openFinTxSheet(biz, null));
  wrap.appendChild(fab);
}

/* ---------------- Sheet transaksi (dipakai Pribadi/Sawit/Walet/Eksa-pengeluaran) ---------------- */
let finSelectedTxCategory = '';
function renderFinTxCategoryChips(business, current){
  const wrap = document.getElementById('finTxCategoryChips'); wrap.innerHTML='';
  finSelectedTxCategory = current || '';
  finGetCategoriesFor(business).forEach(cat=>{
    const chip = document.createElement('button');
    chip.type='button'; chip.className='chip'+(finSelectedTxCategory===cat?' active':'');
    chip.textContent = cat;
    chip.addEventListener('click', ()=>{ finSelectedTxCategory = cat; renderFinTxCategoryChips(business, cat); });
    wrap.appendChild(chip);
  });
}
function renderFinCatManagedList(){
  const wrap = document.getElementById('finCatManageList'); wrap.innerHTML='';
  finGetCategoriesFor('pribadi').forEach(cat=>{
    const row = document.createElement('div');
    row.className = 'opt-row';
    row.innerHTML = `<span>${escapeHtml(cat)}</span><button type="button" data-cat="${escapeHtml(cat)}" style="background:none;border:none;color:var(--ink-soft);font-size:18px;cursor:pointer;padding:0 6px;">&times;</button>`;
    row.querySelector('button').addEventListener('click', async ()=>{
      if(finGetCategoriesFor('pribadi').length<=1){ showToast('Minimal harus ada 1 kategori'); return; }
      if(!confirm('Hapus kategori "'+cat+'"?')) return;
      await finDeleteCategory('pribadi', cat);
      renderFinCatManagedList();
    });
    wrap.appendChild(row);
  });
}
function openFinCatSheet(){
  renderFinCatManagedList();
  document.getElementById('finCatOverlay').classList.add('show');
}
document.getElementById('finCatAddBtn').addEventListener('click', async ()=>{
  const input = document.getElementById('finCatNewInput');
  const name = input.value.trim(); if(!name) return;
  await finAddCategory('pribadi', name);
  input.value='';
  renderFinCatManagedList();
});
document.getElementById('finCatDoneBtn').addEventListener('click', ()=>{
  document.getElementById('finCatOverlay').classList.remove('show');
  setTimeout(()=>{
    renderFinTxCategoryChips('pribadi', finSelectedTxCategory);
    document.getElementById('finTxOverlay').classList.add('show');
  }, 200);
});
document.getElementById('finCatOverlay').addEventListener('click', e=>{ if(e.target.id==='finCatOverlay') e.currentTarget.classList.remove('show'); });

/* ---------------- Detail view (read-only) sebelum edit — dipakai Pribadi & Pengeluaran Eksa/Sawit ---------------- */
let finTxDetailEditCallback = null;
function openFinTxDetailView(t, editCallback){
  finTxDetailEditCallback = editCallback;
  const hasItems = Array.isArray(t.items) && t.items.length;
  document.getElementById('finTxDetailTitle').textContent = hasItems
    ? (t.items[0].nama + (t.items.length>1 ? ' +'+(t.items.length-1)+' lainnya' : ''))
    : (t.category||'Lainnya');
  const fcache = finGetCacheFotos();
  let itemsHtml = '';
  if(hasItems){
    itemsHtml = t.items.map(it=>`
      <div class="fin-detail-item-row">
        <span>${escapeHtml(it.nama||'Barang')}${it.jumlah!==1?' × '+it.jumlah:''}</span>
        <span>${finFmt((Number(it.harga)||0)*(Number(it.jumlah)||0))}</span>
      </div>
    `).join('');
  }
  const thumbs = (t.notaFotoIds||[]).filter(fid=>fcache[fid]).map(fid=>`<img src="${fcache[fid]}" data-view="${fid}">`).join('');
  const bodyEl = document.getElementById('finTxDetailBody');
  bodyEl.innerHTML = `
    <div class="fin-detail-row"><span>Tanggal</span><span>${t.date.split('-').reverse().join('/')}</span></div>
    ${t.type ? `<div class="fin-detail-row"><span>Tipe</span><span>${t.type==='out'?'Pengeluaran':'Pemasukan'}</span></div>` : ''}
    ${(!hasItems && t.category) ? `<div class="fin-detail-row"><span>Kategori</span><span>${escapeHtml(t.category)}</span></div>` : ''}
    ${itemsHtml}
    ${t.note ? `<div class="fin-detail-note">${escapeHtml(t.note)}</div>` : ''}
    ${thumbs ? `<div class="fin-item-thumb-row" style="margin-top:10px;">${thumbs}</div>` : ''}
    <div class="fin-detail-row" style="margin-top:10px; font-weight:700;">
      <span>Total</span><span style="color:${t.type==='out'?'var(--danger)':'var(--positive)'}">${t.type==='out'?'-':'+'}${finFmt(t.amount)}</span>
    </div>
  `;
  bodyEl.querySelectorAll('[data-view]').forEach(img=>{
    img.addEventListener('click', ()=>{ const f=fcache[img.dataset.view]; if(f) window.open(f, '_blank'); });
  });
  document.getElementById('finTxDetailOverlay').classList.add('show');
}
document.getElementById('finTxDetailCloseBtn').addEventListener('click', ()=>document.getElementById('finTxDetailOverlay').classList.remove('show'));
document.getElementById('finTxDetailOverlay').addEventListener('click', e=>{ if(e.target.id==='finTxDetailOverlay') e.currentTarget.classList.remove('show'); });
document.getElementById('finTxDetailEditBtn').addEventListener('click', ()=>{
  document.getElementById('finTxDetailOverlay').classList.remove('show');
  const cb = finTxDetailEditCallback;
  setTimeout(()=>{ if(cb) cb(); }, 150); // kasih jeda dikit biar transisi overlay lama-baru gak tabrakan
});

function openFinTxSheet(business, tx){
  finEditingTx = tx ? {business, tx} : {business, tx:null};
  document.getElementById('finTxSheetTitle').textContent = tx ? 'Edit Transaksi' : (business==='rental_eksa' ? 'Tambah Pengeluaran' : 'Tambah Transaksi');
  const forceOut = business==='rental_eksa'; // Eksa: pemasukan udah otomatis dari Input HM, di sini cuma biaya
  const type = forceOut ? 'out' : (tx ? tx.type : 'in');
  document.getElementById('finTxTypeToggle').style.display = forceOut ? 'none' : '';
  document.querySelectorAll('#finTxTypeToggle button').forEach(b=>{
    b.classList.toggle('active', b.dataset.type===type);
    b.classList.toggle('in', b.dataset.type==='in');
    b.classList.toggle('out', b.dataset.type==='out');
  });
  document.getElementById('finTxAmount').value = tx ? tx.amount : '';
  document.getElementById('finTxDate').value = tx ? tx.date : finTodayStr();
  document.getElementById('finTxNote').value = tx ? tx.note : '';
  const isPribadi = business==='pribadi';
  document.getElementById('finTxCategoryTextField').style.display = isPribadi ? 'none' : '';
  document.getElementById('finTxCategoryChipField').style.display = isPribadi ? '' : 'none';
  if(isPribadi){
    renderFinTxCategoryChips('pribadi', tx?tx.category:'');
  } else {
    document.getElementById('finTxCategory').value = tx ? tx.category : '';
    const dl = document.getElementById('finTxCategoryList');
    dl.innerHTML = (FIN_CATEGORY_PRESET[business]||[]).map(c=>`<option value="${escapeHtml(c)}">`).join('');
  }
  const accSel = document.getElementById('finTxAccount');
  const accounts = finGetCacheAccounts();
  accSel.innerHTML = '<option value="">— Gak dicatat ke akun manapun —</option>' + accounts.map(a=>`<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  accSel.value = tx ? (tx.account||'') : '';
  document.getElementById('finTxDeleteBtn').style.display = tx ? '' : 'none';
  finTxItems = (tx && Array.isArray(tx.items)) ? tx.items.map(it=>({id: it.id||finNewId('i'), nama: it.nama||'', harga: Number(it.harga)||0, jumlah: Number(it.jumlah)||0})) : [];
  if(!finTxItems.length) finTxItems.push({id: finNewId('i'), nama:'', harga:0, jumlah:1});
  finTxRenderItemRows();
  document.getElementById('finTxOverlay').classList.add('show');
}
document.getElementById('finCatManageBtn').addEventListener('click', ()=>{
  document.getElementById('finTxOverlay').classList.remove('show');
  setTimeout(()=>openFinCatSheet(), 200);
});
document.querySelectorAll('#finTxTypeToggle button').forEach(b=>{
  b.addEventListener('click', ()=>{
    document.querySelectorAll('#finTxTypeToggle button').forEach(x=>{
      x.classList.toggle('active', x===b);
      x.classList.toggle('in', x.dataset.type==='in');
      x.classList.toggle('out', x.dataset.type==='out');
    });
  });
});
document.getElementById('finTxCancelBtn').addEventListener('click', ()=>document.getElementById('finTxOverlay').classList.remove('show'));
document.getElementById('finTxOverlay').addEventListener('click', e=>{ if(e.target.id==='finTxOverlay') e.currentTarget.classList.remove('show'); });
document.getElementById('finTxSaveBtn').addEventListener('click', async ()=>{
  const validItems = finTxValidItems();
  const amount = validItems.length ? validItems.reduce((s,it)=>s+(Number(it.harga)||0)*(Number(it.jumlah)||0),0) : Number(document.getElementById('finTxAmount').value);
  const {business, tx} = finEditingTx;
  const isPribadi = business==='pribadi';
  const category = isPribadi ? finSelectedTxCategory : document.getElementById('finTxCategory').value.trim();
  const account = document.getElementById('finTxAccount').value;
  const date = document.getElementById('finTxDate').value;
  const note = document.getElementById('finTxNote').value.trim();
  const type = document.querySelector('#finTxTypeToggle button.active').dataset.type;
  if(!amount || amount<=0){ showToast('Isi jumlahnya dulu ya'); return; }
  if(!date){ showToast('Pilih tanggal dulu ya'); return; }
  if(isPribadi && !category){ showToast('Pilih kategori dulu ya'); return; }
  const items = validItems.length ? validItems : undefined;
  if(tx) await finUpdateTx(business, {...tx, type, amount, category, date, note, account, items});
  else await finAddTx(business, {type, amount, category, date, note, account, items});
  document.getElementById('finTxOverlay').classList.remove('show');
  showToast('Tersimpan');
  renderKeuanganBody();
});
document.getElementById('finTxDeleteBtn').addEventListener('click', async ()=>{
  const {business, tx} = finEditingTx; if(!tx) return;
  if(!confirm('Hapus transaksi ini?')) return;
  await finDeleteTx(business, tx.id);
  document.getElementById('finTxOverlay').classList.remove('show');
  showToast('Dihapus');
  renderKeuanganBody();
});

/* ---------------- SHEET PENGELUARAN RENTAL EKSA (rincian barang + foto nota) ---------------- */
let finEksaExpEditingTx = null;
let finEksaExpBusiness = 'rental_eksa'; // business yang lagi diedit di sheet Pengeluaran ('rental_eksa' atau 'sawit')
let finEksaExpItems = [];
let finEksaExpFotos = []; // {id, dataUrl}
let finEksaExpFotosRemoved = [];

function finEksaExpRecalcTotal(){
  const total = finEksaExpItems.reduce((s,it)=>s+(Number(it.harga)||0)*(Number(it.jumlah)||0), 0);
  document.getElementById('finEksaExpTotalVal').textContent = finFmt(total);
  return total;
}
function finEksaExpAddItemRow(){
  finEksaExpItems.push({id: finNewId('i'), nama:'', harga:0, jumlah:1});
}
function finEksaExpRenderItemRows(){
  const wrap = document.getElementById('finEksaExpItemsList');
  wrap.innerHTML = finEksaExpItems.map(it=>`
    <div class="fin-item-row" data-id="${it.id}">
      <input type="text" class="fin-item-nama" placeholder="mis. Filter Kit" value="${escapeHtml(it.nama)}">
      <input type="number" class="fin-item-harga" placeholder="0" value="${it.harga||''}" inputmode="numeric">
      <input type="number" class="fin-item-jumlah" placeholder="1" value="${it.jumlah||''}" inputmode="numeric">
      <button type="button" class="fin-item-remove" data-remove="${it.id}">✕</button>
    </div>
  `).join('');
  wrap.querySelectorAll('.fin-item-row').forEach(row=>{
    const it = finEksaExpItems.find(x=>x.id===row.dataset.id); if(!it) return;
    row.querySelector('.fin-item-nama').addEventListener('input', e=>{ it.nama = e.target.value; });
    row.querySelector('.fin-item-harga').addEventListener('input', e=>{ it.harga = Number(e.target.value)||0; finEksaExpRecalcTotal(); });
    row.querySelector('.fin-item-jumlah').addEventListener('input', e=>{ it.jumlah = Number(e.target.value)||0; finEksaExpRecalcTotal(); });
  });
  wrap.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      finEksaExpItems = finEksaExpItems.filter(x=>x.id!==btn.dataset.remove);
      if(!finEksaExpItems.length) finEksaExpAddItemRow(); // minimal 1 baris biar gak kosong total
      finEksaExpRenderItemRows();
    });
  });
  finEksaExpRecalcTotal();
}
function finEksaExpRenderPhotoGrid(){
  const grid = document.getElementById('finEksaExpPhotoGrid');
  grid.innerHTML = finEksaExpFotos.map(f=>`
    <div class="fin-photo-thumb" data-id="${f.id}">
      <img src="${f.dataUrl}" data-view="${f.id}">
      <button type="button" class="fin-photo-remove" data-remove="${f.id}">✕</button>
    </div>
  `).join('') + (finEksaExpFotos.length<10 ? '<div class="fin-photo-add" id="finEksaExpAddPhotoBtn">+</div>' : '');
  grid.querySelectorAll('[data-view]').forEach(img=>{
    img.addEventListener('click', ()=>{
      const f = finEksaExpFotos.find(x=>x.id===img.dataset.view);
      if(f) window.open(f.dataUrl, '_blank');
    });
  });
  grid.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      finEksaExpFotosRemoved.push(btn.dataset.remove);
      finEksaExpFotos = finEksaExpFotos.filter(f=>f.id!==btn.dataset.remove);
      finEksaExpRenderPhotoGrid();
    });
  });
  const addBtn = document.getElementById('finEksaExpAddPhotoBtn');
  if(addBtn) addBtn.addEventListener('click', ()=>document.getElementById('finEksaExpPhotoInput').click());
}
function openFinEksaExpSheet(business, tx){
  finEksaExpBusiness = business;
  finEksaExpEditingTx = tx || null;
  finEksaExpFotosRemoved = [];
  document.getElementById('finEksaExpSheetTitle').textContent = tx ? 'Edit Pengeluaran' : 'Tambah Pengeluaran';
  document.getElementById('finEksaExpDate').value = tx ? tx.date : finTodayStr();
  document.getElementById('finEksaExpNote').value = tx ? (tx.note||'') : '';
  const accSel = document.getElementById('finEksaExpAccount');
  const accounts = finGetCacheAccounts();
  accSel.innerHTML = '<option value="">— Gak dicatat ke akun manapun —</option>' + accounts.map(a=>`<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  accSel.value = tx ? (tx.account||'') : '';

  if(tx && Array.isArray(tx.items) && tx.items.length){
    finEksaExpItems = tx.items.map(it=>({id: it.id||finNewId('i'), nama: it.nama||'', harga: Number(it.harga)||0, jumlah: Number(it.jumlah)||0}));
  } else if(tx){
    // transaksi lama sebelum ada fitur rincian — tampilin sebagai 1 baris barang biar gak ilang datanya
    finEksaExpItems = [{id: finNewId('i'), nama: tx.category||'Lainnya', harga: tx.amount||0, jumlah: 1}];
  } else {
    finEksaExpItems = [{id: finNewId('i'), nama:'', harga:0, jumlah:1}];
  }
  finEksaExpRenderItemRows();

  const fcache = finGetCacheFotos();
  const fotoIds = (tx && tx.notaFotoIds) || [];
  finEksaExpFotos = fotoIds.filter(fid=>fcache[fid]).map(fid=>({id:fid, dataUrl:fcache[fid]}));
  finEksaExpRenderPhotoGrid();
  if(fotoIds.length){
    // kalau ada foto yang belum kepegang di cache lokal (misal baru buka app ini di HP lain),
    // ambil dari server dulu, baru render ulang grid-nya begitu dapet
    finEnsureNotaFotos(fotoIds).then(gotNew=>{
      if(!gotNew) return;
      const fcache2 = finGetCacheFotos();
      finEksaExpFotos = fotoIds.filter(fid=>fcache2[fid]).map(fid=>({id:fid, dataUrl:fcache2[fid]}));
      finEksaExpRenderPhotoGrid();
    });
  }

  document.getElementById('finEksaExpDeleteBtn').style.display = tx ? '' : 'none';
  document.getElementById('finEksaExpOverlay').classList.add('show');
}
document.getElementById('finEksaExpAddItemBtn').addEventListener('click', ()=>{
  finEksaExpAddItemRow();
  finEksaExpRenderItemRows();
});
document.getElementById('finEksaExpPhotoInput').addEventListener('change', async (e)=>{
  const file = e.target.files[0]; e.target.value=''; if(!file) return;
  try{
    const dataUrl = await finCompressImageFile(file);
    finEksaExpFotos.push({id: finNewId('f'), dataUrl});
    finEksaExpRenderPhotoGrid();
  }catch(err){ showToast('Gagal proses foto, coba foto lain'); }
});
document.getElementById('finEksaExpCancelBtn').addEventListener('click', ()=>document.getElementById('finEksaExpOverlay').classList.remove('show'));
document.getElementById('finEksaExpOverlay').addEventListener('click', e=>{ if(e.target.id==='finEksaExpOverlay') e.currentTarget.classList.remove('show'); });
document.getElementById('finEksaExpSaveBtn').addEventListener('click', async ()=>{
  const date = document.getElementById('finEksaExpDate').value;
  const note = document.getElementById('finEksaExpNote').value.trim();
  const account = document.getElementById('finEksaExpAccount').value;
  if(!date){ showToast('Pilih tanggal dulu ya'); return; }
  const items = finEksaExpItems
    .filter(it=>(it.nama||'').trim() && (Number(it.harga)||0)>0 && (Number(it.jumlah)||0)>0)
    .map(it=>({id: it.id, nama: it.nama.trim(), harga: Number(it.harga), jumlah: Number(it.jumlah)}));
  if(!items.length){ showToast('Isi minimal 1 barang (nama, harga, jumlah) dulu ya'); return; }
  const amount = items.reduce((s,it)=>s+it.harga*it.jumlah, 0);
  const category = items[0].nama + (items.length>1 ? ' +'+(items.length-1)+' lainnya' : '');
  const notaFotoIds = finEksaExpFotos.map(f=>f.id);
  const partial = {type:'out', amount, category, date, note, account, items, notaFotoIds};

  if(finEksaExpEditingTx) await finUpdateTx(finEksaExpBusiness, {...finEksaExpEditingTx, ...partial});
  else await finAddTx(finEksaExpBusiness, partial);

  // upload semua foto yang lagi nempel (idempotent per fotoId, jadi yang lama gak masalah di-upload ulang)
  finEksaExpFotos.forEach(f=>{ finUploadNotaFoto(f.id, f.dataUrl); });
  // hapus foto yang di-remove pas edit (best-effort, gak dikawal antrian retry biar simple)
  const vaultId = finGetVaultId();
  finEksaExpFotosRemoved.forEach(fid=>{ finApiRaw('nota-foto-delete', {vaultId, fotoId:fid}).catch(()=>{}); });

  document.getElementById('finEksaExpOverlay').classList.remove('show');
  showToast('Tersimpan');
  if(finEksaExpBusiness==='sawit') renderFinSawit(); else renderFinEksa();
});
document.getElementById('finEksaExpDeleteBtn').addEventListener('click', async ()=>{
  if(!finEksaExpEditingTx) return;
  if(!confirm('Hapus pengeluaran ini?')) return;
  await finDeleteTx(finEksaExpBusiness, finEksaExpEditingTx.id);
  document.getElementById('finEksaExpOverlay').classList.remove('show');
  showToast('Dihapus');
  if(finEksaExpBusiness==='sawit') renderFinSawit(); else renderFinEksa();
});

/* ---------------- RENTAL EKSA ---------------- */
function finOpenUnitActions(u){
  if(!u) return;
  const input = prompt('Ganti nama unit ini, atau ketik "hapus" buat menghapusnya:', u.name);
  if(input===null) return; // batal
  const trimmed = input.trim();
  if(!trimmed) return;
  if(trimmed.toLowerCase()==='hapus'){
    if(finGetCacheUnits().length<=1){ showToast('Minimal harus ada 1 unit Eksa'); return; }
    if(!confirm('Yakin hapus unit "'+u.name+'"? Semua data HM & rate unit ini ikut terhapus.')) return;
    finDeleteUnit(u.id).then(()=>{ finActiveEksaUnit = null; renderFinEksa(); });
    return;
  }
  if(trimmed!==u.name) finRenameUnit(u.id, trimmed).then(()=>renderFinEksa());
}

function renderFinEksa(){
  const wrap = document.getElementById('keuanganContent'); wrap.innerHTML='';
  const units = finGetCacheUnits();
  if(!finActiveEksaUnit || !units.find(u=>u.id===finActiveEksaUnit)) finActiveEksaUnit = units[0] ? units[0].id : null;

  const backWrap = document.createElement('div'); backWrap.innerHTML = finBackLinkHtml();
  wrap.appendChild(backWrap);
  finWireBackLink();

  const sub = document.createElement('div');
  sub.className='segmented'; sub.style.marginBottom='14px';
  sub.innerHTML = ['input','pengeluaran','laporan','rate'].map(t=>{
    const label = {input:'Input HM', pengeluaran:'Pengeluaran', laporan:'Laporan', rate:'Rate'}[t];
    return `<button type="button" class="${finEksaSubTab===t?'active':''}" data-sub="${t}">${label}</button>`;
  }).join('');
  wrap.appendChild(sub);
  sub.querySelectorAll('button').forEach(b=>{
    b.addEventListener('click', ()=>{ finEksaSubTab = b.dataset.sub; renderFinEksa(); });
  });

  // pemilih unit — cuma buat sub-tab yang memang beda per excavator (Input HM/Laporan/Rate),
  // Pengeluaran tetap 1 kolam bareng buat semua unit
  if(finEksaSubTab!=='pengeluaran'){
    const unitBar = document.createElement('div');
    unitBar.style.cssText='display:flex; gap:8px; overflow-x:auto; padding-bottom:12px; margin-bottom:2px;';
    unitBar.innerHTML = units.map(u=>{
      const active = u.id===finActiveEksaUnit;
      return `<button type="button" data-unit="${u.id}" style="flex:0 0 auto; padding:8px 14px; border-radius:20px; border:none; font-size:12.5px; font-weight:700; cursor:pointer; background:${active?'var(--ig-gradient)':'var(--surface-2)'}; color:${active?'#fff':'var(--ink-soft)'};">${escapeHtml(u.name)}${active?' ✎':''}</button>`;
    }).join('')
      + `<button type="button" id="finUnitAddBtn" style="flex:0 0 auto; padding:8px 14px; border-radius:20px; border:1px dashed var(--line); font-size:12.5px; font-weight:700; cursor:pointer; background:none; color:var(--ink-soft);">+ Unit</button>`;
    wrap.appendChild(unitBar);
    unitBar.querySelectorAll('[data-unit]').forEach(b=>{
      b.addEventListener('click', ()=>{
        if(b.dataset.unit===finActiveEksaUnit){
          finOpenUnitActions(units.find(u=>u.id===b.dataset.unit));
        } else {
          finActiveEksaUnit = b.dataset.unit; renderFinEksa();
        }
      });
    });
    document.getElementById('finUnitAddBtn').addEventListener('click', async ()=>{
      const name = prompt('Nama unit baru (mis. Eksa 2):'); if(!name || !name.trim()) return;
      const unit = await finAddUnit(name.trim());
      finActiveEksaUnit = unit.id;
      renderFinEksa();
    });
  }

  const body = document.createElement('div');
  wrap.appendChild(body);

  if(finEksaSubTab==='input') renderFinEksaInput(body);
  else if(finEksaSubTab==='pengeluaran') renderFinEksaPengeluaran(body);
  else if(finEksaSubTab==='laporan') renderFinEksaLaporan(body);
  else renderFinEksaRate(body);
}

function renderFinEksaInput(body){
  const unitId = finActiveEksaUnit;
  const unit = finGetCacheUnits().find(u=>u.id===unitId) || {};
  const accounts = finGetCacheAccounts();
  const rows = finGetHmForUnit(unitId);
  const lastRow = rows[rows.length-1];
  const today = finHmLastDate || finTodayStr();
  const accOptions = '<option value="">— Belum dipilih —</option>' + accounts.map(a=>`<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  body.innerHTML = `
    <div class="fin-section-label">Akun buat gaji &amp; pemasukan (unit ini)</div>
    <div class="field"><label>Uang sewa masuk ke akun</label><select id="finHmIncomeAcc">${accOptions}</select></div>
    <div class="field"><label>Gaji operator dibayar dari akun</label><select id="finHmSalaryAcc">${accOptions}</select></div>
    <div class="field-hint" style="margin-bottom:16px;">Nominalnya tetap otomatis dari hasil hitungan HM &amp; rate — ini cuma nandain duitnya lewat akun yang mana.</div>
    <div class="fin-section-label">Input HM Harian</div>
    <div class="field"><label>Tanggal</label><input type="date" id="finHmTgl" value="${today}"></div>
    <div class="row2" style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
      <div class="field"><label>HM Awal</label><input type="number" step="0.1" id="finHmAwal" placeholder="isi manual" ${lastRow?'readonly':''} value="${lastRow?lastRow.hmAkhir:''}" style="${lastRow?'color:var(--positive);':''}"></div>
      <div class="field"><label>HM Akhir</label><input type="number" step="0.1" id="finHmAkhir" placeholder="0.0"></div>
    </div>
    <div class="fin-total-card" style="margin-bottom:14px;">
      <div><div class="fin-total-label">Durasi</div><div class="fin-total-val" id="finHmDurPreview" style="font-size:15px;">— HM</div></div>
      <div><div class="fin-total-label">Hari Kerja Bulan Ini</div><div class="fin-total-val" id="finHmHariPreview" style="font-size:15px;">—</div></div>
    </div>
    <button class="btn primary" id="finHmSaveBtn" style="width:100%; margin-bottom:20px;">Simpan</button>
    <div class="field-hint" style="margin-bottom:10px;">Riwayat HM terakhir</div>
    <div id="finHmHistory"></div>
  `;
  document.getElementById('finHmIncomeAcc').value = unit.incomeAccountId||'';
  document.getElementById('finHmSalaryAcc').value = unit.salaryAccountId||'';
  document.getElementById('finHmIncomeAcc').addEventListener('change', e=>{
    finSetUnitAccounts(unitId, e.target.value, document.getElementById('finHmSalaryAcc').value);
    showToast('Tersimpan');
  });
  document.getElementById('finHmSalaryAcc').addEventListener('change', e=>{
    finSetUnitAccounts(unitId, document.getElementById('finHmIncomeAcc').value, e.target.value);
    showToast('Tersimpan');
  });
  const tglEl = document.getElementById('finHmTgl');
  const awalEl = document.getElementById('finHmAwal');
  const akhirEl = document.getElementById('finHmAkhir');
  function preview(){
    const awal = parseFloat(awalEl.value)||0, akhir = parseFloat(akhirEl.value)||0;
    const dur = akhir>awal ? finFmtN(akhir-awal) : 0;
    document.getElementById('finHmDurPreview').textContent = dur ? dur+' HM' : '— HM';
    const monthKey = tglEl.value ? tglEl.value.slice(0,7) : finMonthKey(new Date());
    const hariKerja = finHmInMonth(rows, monthKey).length + (dur>0?1:0);
    document.getElementById('finHmHariPreview').textContent = hariKerja+' hari';
  }
  awalEl.addEventListener('input', preview); akhirEl.addEventListener('input', preview); tglEl.addEventListener('input', preview);
  preview();

  document.getElementById('finHmSaveBtn').addEventListener('click', async ()=>{
    const tgl = tglEl.value, hmAwal = parseFloat(awalEl.value), hmAkhir = parseFloat(akhirEl.value);
    if(!tgl){ showToast('Pilih tanggal dulu'); return; }
    if(isNaN(hmAwal)){ showToast('HM Awal kosong'); return; }
    if(isNaN(hmAkhir) || hmAkhir<=hmAwal){ showToast('HM Akhir harus lebih besar dari HM Awal'); return; }
    await finAddHm(unitId, tgl, hmAwal, hmAkhir);
    // inget tanggal ini biar sheet gak balik ke "hari ini" pas dibuka lagi — dimajuin 1 hari
    // biar gampang lanjut input HM hari berikutnya (khas kalo lagi ngejar backlog HM lama).
    finHmLastDate = finAddDaysStr(tgl, 1);
    showToast('Tersimpan');
    renderFinEksa();
  });

  const histEl = document.getElementById('finHmHistory');
  const recent = [...rows].reverse().slice(0,15);
  histEl.innerHTML = recent.length ? recent.map(r=>`
    <div class="fin-hm-row" data-id="${r.id}">
      <div><div class="fin-hm-date">${r.tgl.split('-').reverse().join('/')}</div><div class="fin-hm-sub">${r.hmAwal} → ${r.hmAkhir}</div></div>
      <div style="display:flex; align-items:center; gap:10px;"><div class="fin-hm-dur">${r.dur} HM</div><button class="del" data-del="${r.id}" style="background:none;border:1px solid var(--line);border-radius:8px;color:var(--ink-soft);cursor:pointer;padding:4px 8px;font-size:12px;">✕</button></div>
    </div>
  `).join('') : '<div class="fin-empty">Belum ada data HM.</div>';
  histEl.querySelectorAll('[data-del]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      if(!confirm('Hapus data HM ini?')) return;
      await finDeleteHm(unitId, btn.dataset.del);
      showToast('Dihapus');
      renderFinEksa();
    });
  });
}

function renderFinEksaPengeluaran(body){ renderFinPengeluaranRincian(body, 'rental_eksa'); }
function renderFinSawitPengeluaran(body){ renderFinPengeluaranRincian(body, 'sawit'); }

function renderFinPengeluaranRincian(body, business){
  body.innerHTML = `
    <div class="fin-search-row">
      <div class="search-bar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input type="text" id="finEksaExpSearchInput" placeholder="Cari barang, catatan, tanggal..." value="${escapeHtml(finExpSearch[business]||'')}"></div>
      <button type="button" class="fin-toggle-chip ${finExpShowAll[business]?'active':''}" id="finEksaExpShowAllBtn">${finExpShowAll[business]?'Semua':'Bulan Ini'}</button>
    </div>
    <div id="finEksaExpMonthNavWrap"></div>
    <div id="finEksaExpListArea"></div>
  `;

  const monthNavWrap = body.querySelector('#finEksaExpMonthNavWrap');
  function renderMonthNavArea(){
    if(finExpShowAll[business]){
      monthNavWrap.innerHTML = `<div class="fin-month-nav"><div class="fin-month-label">Semua Pengeluaran</div></div>`;
    } else {
      monthNavWrap.innerHTML = finMonthNavHtml();
      finWireMonthNav(updateExpList);
    }
  }

  function updateExpList(){
    renderMonthNavArea();
    const monthKey = finMonthKey(finMonthCursor);
    const cache = finGetCacheTx();
    const base = finExpShowAll[business] ? (cache[business]||[]) : finTxInMonth(cache[business]||[], monthKey);
    const onlyOut = base.filter(t=>t.type==='out'); // tab ini emang khusus pengeluaran; pemasukan (mis. tx Pendapatan Sewa hasil konfirmasi) tampil di Laporan, bukan di sini
    const txAll = onlyOut.filter(t=>finTxMatchesQuery(t, finExpSearch[business])).sort((a,b)=>b.date.localeCompare(a.date));
    const keluar = finSumOut(txAll);
    const listArea = body.querySelector('#finEksaExpListArea');
    listArea.innerHTML = `<div class="fin-total-card" style="margin-bottom:14px;">
        <div class="fin-total-label">Total Pengeluaran${finExpShowAll[business]?' (Semua)':' Bulan Ini'}</div><div class="fin-total-val" style="color:var(--danger);">${finFmt(keluar)}</div>
      </div>` +
      (txAll.length ? `<div id="finTxList"></div>` : `<div class="fin-empty">${finExpSearch[business] ? 'Gak ada pengeluaran yang cocok.' : (finExpShowAll[business] ? 'Belum ada pengeluaran sama sekali.' : 'Belum ada pengeluaran tambahan bulan ini.<br>Tap tombol + buat nambah (perawatan, sparepart, dll).')}</div>`);

    if(txAll.length){
      const listEl = listArea.querySelector('#finTxList');
      listEl.innerHTML = txAll.map(t=>{
        const hasItems = Array.isArray(t.items) && t.items.length;
        const judul = hasItems ? (t.items[0].nama + (t.items.length>1 ? ' +'+(t.items.length-1)+' lainnya' : '')) : (t.category||'Lainnya');
        return `
        <div class="fin-tx-item" data-id="${t.id}">
          <div style="flex:1; min-width:0;">
            <div class="fin-tx-cat">${escapeHtml(judul)}</div>
            ${(!hasItems && t.note)?`<div class="fin-tx-note">${escapeHtml(t.note)}</div>`:''}
            <div class="fin-tx-date">${t.date.split('-').reverse().join('/')}${finExpShowAll[business]?' · '+finMonthLabel(finParseMonthKey(t.date.slice(0,7))):''}</div>
          </div>
          <div class="fin-tx-amt out">-${finFmt(t.amount)}</div>
        </div>
      `;
      }).join('');
      listEl.querySelectorAll('.fin-tx-item').forEach(row=>{
        row.addEventListener('click', ()=>{
          const tx = txAll.find(t=>t.id===row.dataset.id);
          openFinTxDetailView(tx, ()=>openFinEksaExpSheet(business, tx));
        });
      });

      // ambil foto yang belum ada di cache lokal (misal buka dari HP lain), render ulang kalau dapet yang baru
      const allFotoIds = [...new Set(txAll.flatMap(t=>t.notaFotoIds||[]))];
      if(allFotoIds.length){
        finEnsureNotaFotos(allFotoIds).then(gotNew=>{ if(gotNew) updateExpList(); });
      }
    }
  }
  updateExpList();

  const searchInput = body.querySelector('#finEksaExpSearchInput');
  searchInput.addEventListener('input', ()=>{ finExpSearch[business] = searchInput.value; updateExpList(); });
  body.querySelector('#finEksaExpShowAllBtn').addEventListener('click', ()=>{
    finExpShowAll[business] = !finExpShowAll[business];
    renderKeuanganBody();
  });

  const fab = document.createElement('button');
  fab.className='fin-fab'; fab.innerHTML='+';
  fab.addEventListener('click', ()=>openFinEksaExpSheet(business, null));
  body.appendChild(fab);
}

function renderFinEksaLaporan(body){
  const monthKey = finMonthKey(finMonthCursor);
  const unitId = finActiveEksaUnit;
  const units = finGetCacheUnits();
  const unit = units.find(u=>u.id===unitId);
  body.innerHTML = finMonthNavHtml() + '<div id="finLaporanCard"></div>';
  finWireMonthNav(renderFinEksa);
  const cardWrap = document.getElementById('finLaporanCard');
  const ur = finEksaUnitMonthNet(unitId, monthKey);
  if(!ur.rate){ cardWrap.innerHTML = '<div class="fin-empty">Rate belum di-setup buat unit ini. Buka tab Rate dulu.</div>'; return; }

  const total = finBusinessMonthNet('rental_eksa', monthKey);
  let html = `
    <div class="fin-report-card">
      <div class="fin-report-note" style="margin:0 0 10px; font-weight:700; color:var(--ink);">${unit?escapeHtml(unit.name):''}</div>
      <div class="fin-report-row"><span>Pendapatan Kotor${ur.confirmed.pemasukan?'':' (proyeksi)'}</span><span>${finFmt(ur.pendapatan)}</span></div>
      <div class="fin-report-row"><span>Gaji Operator${ur.confirmed.pengeluaran?'':' (proyeksi)'}</span><span>-${finFmt(ur.gajiOperator)}</span></div>
      <div class="fin-report-row"><span>Subtotal Unit Ini</span><span>${finFmt(ur.pendapatan-ur.gajiOperator)}</span></div>
      <div class="fin-report-note">${ur.hariKerja} hari kerja · ${ur.totalHM} HM · rate berlaku sejak ${ur.rate.effectiveFrom}</div>
    </div>
    <div class="fin-report-card">
      <div class="fin-report-row" style="align-items:center;">
        <span>Status Pendapatan</span>
        ${ur.confirmed.pemasukan
          ? `<span style="display:flex; align-items:center; gap:8px;"><span style="color:var(--positive); font-weight:700; font-size:12.5px;">✓ Sudah diterima</span><button type="button" class="fin-toggle-chip" id="finEksaUnconfirmMasuk" style="padding:6px 10px; font-size:11.5px;">Batalkan</button></span>`
          : `<button type="button" class="fin-toggle-chip active" id="finEksaConfirmMasuk" style="padding:8px 12px;">Tandai Sudah Diterima</button>`}
      </div>
      <div class="fin-report-row" style="align-items:center;">
        <span>Status Gaji Operator</span>
        ${ur.confirmed.pengeluaran
          ? `<span style="display:flex; align-items:center; gap:8px;"><span style="color:var(--positive); font-weight:700; font-size:12.5px;">✓ Sudah dibayar</span><button type="button" class="fin-toggle-chip" id="finEksaUnconfirmKeluar" style="padding:6px 10px; font-size:11.5px;">Batalkan</button></span>`
          : `<button type="button" class="fin-toggle-chip active" id="finEksaConfirmKeluar" style="padding:8px 12px;">Tandai Sudah Dibayar</button>`}
      </div>
      <div class="fin-report-note">Pendapatan/gaji operator di atas cuma kalkulasi dari Input HM — baru kehitung ke saldo akun & Laba Bersih di bawah kalau ditandai di sini.</div>
    </div>
  `;
  const judulTotal = units.length>1 ? 'Ringkasan Semua Unit Eksa (Aktual)' : 'Ringkasan Bulan Ini (Aktual)';
  html += `
    <div class="fin-report-card">
      <div class="fin-report-note" style="margin:0 0 10px; font-weight:700; color:var(--ink);">${judulTotal}</div>
      <div class="fin-report-row"><span>Pemasukan Aktual</span><span>+${finFmt(total.masukAktual)}</span></div>
      <div class="fin-report-row"><span>Pengeluaran Aktual</span><span>-${finFmt(total.keluarAktual)}</span></div>
      <div class="fin-report-row"><span>Laba Bersih</span><span style="color:${total.net>=0?'var(--positive)':'var(--danger)'}">${finFmt(total.net)}</span></div>
    </div>`;
  if(total.pendapatanProjeksi>0 || total.gajiOperatorProjeksi>0){
    html += `
    <div class="fin-report-card" style="border:1px dashed var(--line); background:transparent;">
      <div class="fin-report-note" style="margin:0 0 10px; font-weight:700; color:var(--ink);">Estimasi Belum Dikonfirmasi</div>
      ${total.pendapatanProjeksi>0?`<div class="fin-report-row"><span>Pendapatan (proyeksi)</span><span>+${finFmt(total.pendapatanProjeksi)}</span></div>`:''}
      ${total.gajiOperatorProjeksi>0?`<div class="fin-report-row"><span>Gaji Operator (proyeksi)</span><span>-${finFmt(total.gajiOperatorProjeksi)}</span></div>`:''}
      <div class="fin-report-note">Belum ikut ke Laba Bersih di atas sampai ditandai "Sudah Diterima/Dibayar".</div>
    </div>`;
  }
  cardWrap.innerHTML = html;

  const confirmMasukBtn = document.getElementById('finEksaConfirmMasuk');
  if(confirmMasukBtn) confirmMasukBtn.addEventListener('click', async ()=>{
    await finConfirmEksaPemasukan(unitId, monthKey); showToast('Pendapatan ditandai diterima'); renderFinEksa();
  });
  const unconfirmMasukBtn = document.getElementById('finEksaUnconfirmMasuk');
  if(unconfirmMasukBtn) unconfirmMasukBtn.addEventListener('click', async ()=>{
    if(!confirm('Batalkan status "sudah diterima"? Transaksi pendapatan yang udah tercatat bakal dihapus.')) return;
    await finUnconfirmEksa(unitId, monthKey, 'pemasukan'); showToast('Dibatalkan'); renderFinEksa();
  });
  const confirmKeluarBtn = document.getElementById('finEksaConfirmKeluar');
  if(confirmKeluarBtn) confirmKeluarBtn.addEventListener('click', async ()=>{
    await finConfirmEksaPengeluaran(unitId, monthKey); showToast('Gaji operator ditandai dibayar'); renderFinEksa();
  });
  const unconfirmKeluarBtn = document.getElementById('finEksaUnconfirmKeluar');
  if(unconfirmKeluarBtn) unconfirmKeluarBtn.addEventListener('click', async ()=>{
    if(!confirm('Batalkan status "sudah dibayar"? Transaksi gaji yang udah tercatat bakal dihapus.')) return;
    await finUnconfirmEksa(unitId, monthKey, 'pengeluaran'); showToast('Dibatalkan'); renderFinEksa();
  });
}

function renderFinEksaRate(body){
  const unitId = finActiveEksaUnit;
  const rates = [...finGetRatesForUnit(unitId)].sort((a,b)=>b.effectiveFrom.localeCompare(a.effectiveFrom));
  body.innerHTML = `<div id="finRateList"></div><button class="btn primary" id="finRateAddBtn" style="width:100%; margin-top:8px;">+ Tambah Rate Baru</button>`;
  const listEl = document.getElementById('finRateList');
  listEl.innerHTML = rates.length ? rates.map(r=>{
    let gajiDesc;
    if(r.progresif && r.lebarTingkat>0){
      gajiDesc = `Rp${(r.gajiOperatorHM||0).toLocaleString('id-ID')}/HM (≤${r.batasHM} HM), lalu naik Rp${(r.kenaikanTingkat||0).toLocaleString('id-ID')}/HM tiap ${r.lebarTingkat} HM (progresif, tanpa batas atas)`;
    } else {
      const tier3 = r.batasHM2 ? ` , Rp${(r.gajiOperatorLebih2||0).toLocaleString('id-ID')}/HM (&gt;${r.batasHM2} HM)` : '';
      gajiDesc = `Rp${(r.gajiOperatorHM||0).toLocaleString('id-ID')}/HM (≤${r.batasHM} HM), Rp${(r.gajiOperatorLebih||0).toLocaleString('id-ID')}/HM (${r.batasHM}-${r.batasHM2||'∞'} HM)${tier3}`;
    }
    return `
    <div class="fin-rate-card" data-from="${r.effectiveFrom}">
      <div class="fin-rate-title"><span>Berlaku sejak ${r.effectiveFrom}</span><span style="color:var(--ink-soft); font-size:12px;">Edit ›</span></div>
      <div class="fin-rate-detail">
        Rp${(r.gajiPerHM||0).toLocaleString('id-ID')}/HM · PPN ${r.ppnPct}% · Tunjangan Rp${(r.tunjanganHarian||0).toLocaleString('id-ID')}/hari<br>
        Gaji operator: ${gajiDesc} + Rp${(r.tunjanganOperatorHarian||0).toLocaleString('id-ID')}/hari
      </div>
    </div>
  `;
  }).join('') : '<div class="fin-empty">Belum ada rate buat unit ini.</div>';
  listEl.querySelectorAll('[data-from]').forEach(card=>{
    card.addEventListener('click', ()=>openFinRateSheet(rates.find(r=>r.effectiveFrom===card.dataset.from)));
  });
  document.getElementById('finRateAddBtn').addEventListener('click', ()=>openFinRateSheet(null));
}

function finPopulateRateMonthSelects(selectedMonthKey){
  const bulanSel = document.getElementById('finRateFromBulan');
  const tahunSel = document.getElementById('finRateFromTahun');
  bulanSel.innerHTML = FIN_MONTHS.map((m,i)=>`<option value="${String(i+1).padStart(2,'0')}">${m}</option>`).join('');
  const thisYear = new Date().getFullYear();
  const years = []; for(let y=thisYear-2; y<=thisYear+3; y++) years.push(y);
  tahunSel.innerHTML = years.map(y=>`<option value="${y}">${y}</option>`).join('');
  const [y, m] = selectedMonthKey.split('-');
  tahunSel.value = y; bulanSel.value = m;
}
function finToggleRateModeFields(){
  const on = document.getElementById('finRateProgresif').checked;
  document.getElementById('finRateFixedFields').style.display = on ? 'none' : '';
  document.getElementById('finRateProgresifFields').style.display = on ? '' : 'none';
}
document.getElementById('finRateProgresif').addEventListener('change', finToggleRateModeFields);

function openFinRateSheet(rate){
  finEditingRate = rate ? rate.effectiveFrom : null;
  document.getElementById('finRateSheetTitle').textContent = rate ? 'Edit Rate' : 'Tambah Rate Baru';
  const nextMonth = new Date(finMonthCursor.getFullYear(), finMonthCursor.getMonth()+1, 1);
  finPopulateRateMonthSelects(rate ? rate.effectiveFrom : finMonthKey(nextMonth));
  document.getElementById('finRateFromBulan').disabled = !!rate;
  document.getElementById('finRateFromTahun').disabled = !!rate;
  document.getElementById('finRateGajiPerHM').value = rate ? rate.gajiPerHM : 275000;
  document.getElementById('finRatePpn').value = rate ? rate.ppnPct : 2;
  document.getElementById('finRateTunjanganHarian').value = rate ? rate.tunjanganHarian : 50000;
  document.getElementById('finRateGajiOpHM').value = rate ? rate.gajiOperatorHM : 50000;
  document.getElementById('finRateBatasHM').value = rate ? rate.batasHM : 175;
  document.getElementById('finRateGajiOpLebih').value = rate ? rate.gajiOperatorLebih : 60000;
  document.getElementById('finRateBatasHM2').value = rate ? (rate.batasHM2||'') : 200;
  document.getElementById('finRateGajiOpLebih2').value = rate ? (rate.gajiOperatorLebih2||'') : 70000;
  document.getElementById('finRateProgresif').checked = rate ? !!rate.progresif : false;
  document.getElementById('finRateLebarTingkat').value = rate ? (rate.lebarTingkat||'') : 25;
  document.getElementById('finRateKenaikanTingkat').value = rate ? (rate.kenaikanTingkat||'') : 10000;
  finToggleRateModeFields();
  document.getElementById('finRateTunjanganOp').value = rate ? rate.tunjanganOperatorHarian : 100000;
  document.getElementById('finRateDeleteBtn').style.display = rate ? '' : 'none';
  document.getElementById('finRateOverlay').classList.add('show');
}
document.getElementById('finRateCancelBtn').addEventListener('click', ()=>document.getElementById('finRateOverlay').classList.remove('show'));
document.getElementById('finRateOverlay').addEventListener('click', e=>{ if(e.target.id==='finRateOverlay') e.currentTarget.classList.remove('show'); });
document.getElementById('finRateSaveBtn').addEventListener('click', async ()=>{
  const effectiveFrom = document.getElementById('finRateFromTahun').value+'-'+document.getElementById('finRateFromBulan').value;
  const progresif = document.getElementById('finRateProgresif').checked;
  const rates = {
    gajiPerHM: Number(document.getElementById('finRateGajiPerHM').value)||0,
    ppnPct: Number(document.getElementById('finRatePpn').value)||0,
    tunjanganHarian: Number(document.getElementById('finRateTunjanganHarian').value)||0,
    gajiOperatorHM: Number(document.getElementById('finRateGajiOpHM').value)||0,
    batasHM: Number(document.getElementById('finRateBatasHM').value)||0,
    gajiOperatorLebih: Number(document.getElementById('finRateGajiOpLebih').value)||0,
    batasHM2: Number(document.getElementById('finRateBatasHM2').value)||0,
    gajiOperatorLebih2: Number(document.getElementById('finRateGajiOpLebih2').value)||0,
    progresif,
    lebarTingkat: Number(document.getElementById('finRateLebarTingkat').value)||0,
    kenaikanTingkat: Number(document.getElementById('finRateKenaikanTingkat').value)||0,
    tunjanganOperatorHarian: Number(document.getElementById('finRateTunjanganOp').value)||0,
  };
  if(progresif && (!rates.lebarTingkat || !rates.kenaikanTingkat)){ showToast('Isi lebar tingkat & kenaikan tarif dulu'); return; }
  await finAddRate(finActiveEksaUnit, effectiveFrom, rates);
  document.getElementById('finRateOverlay').classList.remove('show');
  showToast('Rate tersimpan');
  renderFinEksa();
});
document.getElementById('finRateDeleteBtn').addEventListener('click', async ()=>{
  if(!finEditingRate) return;
  if(!confirm('Hapus rate ini?')) return;
  await finDeleteRate(finActiveEksaUnit, finEditingRate);
  document.getElementById('finRateOverlay').classList.remove('show');
  showToast('Rate dihapus');
  renderFinEksa();
});

/* ---------------- SAWIT: kerangka halaman (Ringkasan|Panen|Pengeluaran|Rate) ---------------- */
function renderFinSawit(){
  const wrap = document.getElementById('keuanganContent'); wrap.innerHTML='';

  const backWrap = document.createElement('div'); backWrap.innerHTML = finBackLinkHtml();
  wrap.appendChild(backWrap);
  finWireBackLink();

  const sub = document.createElement('div');
  sub.className='segmented'; sub.style.marginBottom='14px';
  sub.innerHTML = ['ringkasan','panen','pengeluaran','rate'].map(t=>{
    const label = {ringkasan:'Ringkasan', panen:'Panen', pengeluaran:'Pengeluaran', rate:'Rate'}[t];
    return `<button type="button" class="${finSawitSubTab===t?'active':''}" data-sub="${t}">${label}</button>`;
  }).join('');
  wrap.appendChild(sub);
  sub.querySelectorAll('button').forEach(b=>{
    b.addEventListener('click', ()=>{ finSawitSubTab = b.dataset.sub; renderFinSawit(); });
  });

  const body = document.createElement('div');
  wrap.appendChild(body);

  if(finSawitSubTab==='ringkasan') renderFinSawitRingkasan(body);
  else if(finSawitSubTab==='panen') renderFinSawitPanenTab(body);
  else if(finSawitSubTab==='pengeluaran') renderFinSawitPengeluaran(body);
  else renderFinSawitRateTab(body);
}

function renderFinSawitRingkasan(body){
  const monthKey = finMonthKey(finMonthCursor);
  const profil = finGetCacheSawitProfil();
  body.innerHTML = `
    <div class="fin-report-card" id="finSawitProfilCard" style="cursor:pointer;">
      <div class="fin-report-note" style="margin:0 0 4px; font-weight:700; color:var(--ink);">Data Kebun <span style="font-weight:400; color:var(--ink-soft); font-size:12px;">— ketuk buat edit</span></div>
      <div class="fin-report-note">${profil.luasHektar ? finFmtN(profil.luasHektar)+' ha' : 'Luas belum diisi'}${profil.tahunTanam?' · tanam '+profil.tahunTanam:''}${profil.jumlahPohon?' · '+profil.jumlahPohon+' pohon':''}</div>
    </div>
    <div id="finSawitMonthNavWrap"></div>
    <div id="finSawitReportCard"></div>
  `;
  document.getElementById('finSawitProfilCard').addEventListener('click', openFinSawitProfilSheet);

  document.getElementById('finSawitMonthNavWrap').innerHTML = finMonthNavHtml();
  finWireMonthNav(renderFinSawit);

  const cardWrap = document.getElementById('finSawitReportCard');
  const r = finSawitMonthNet(monthKey);
  if(!r.rate){
    cardWrap.innerHTML = '<div class="fin-empty">Rate harga TBS belum di-setup. Buka tab Rate dulu.</div>';
    return;
  }
  const tx = finTxInMonth((finGetCacheTx().sawit||[]), monthKey);
  const pemasukanLain = finSumIn(tx), pengeluaranLain = finSumOut(tx);
  const labaBersih = r.pendapatanBersih + pemasukanLain - r.upahPanen - pengeluaranLain;
  cardWrap.innerHTML = `
    <div class="fin-report-card">
      <div class="fin-report-row"><span>Total Panen</span><span>${r.totalKg} kg</span></div>
      <div class="fin-report-row"><span>Pendapatan Kotor</span><span>${finFmt(r.pendapatanKotor)}</span></div>
      <div class="fin-report-row"><span>Pendapatan Bersih</span><span>${finFmt(r.pendapatanBersih)}</span></div>
      <div class="fin-report-row"><span>Upah Panen</span><span>-${finFmt(r.upahPanen)}</span></div>
      <div class="fin-report-note">rate berlaku sejak ${r.rate.effectiveFrom} · Rp${(r.rate.hargaPerKg||0).toLocaleString('id-ID')}/kg · potongan ${r.rate.potonganPercent||0}% · pajak ${r.rate.pajakPercent||0}%</div>
    </div>
    <div class="fin-report-card">
      ${pemasukanLain ? `<div class="fin-report-row"><span>Pemasukan Lain</span><span>+${finFmt(pemasukanLain)}</span></div>` : ''}
      <div class="fin-report-row"><span>Pengeluaran Lain (pupuk/gaji/dll)</span><span>-${finFmt(pengeluaranLain)}</span></div>
      <div class="fin-report-row"><span>Laba Bersih</span><span style="color:${labaBersih>=0?'var(--positive)':'var(--danger)'}">${finFmt(labaBersih)}</span></div>
    </div>
  `;
}

function renderFinSawitPanenTab(body){
  const rows = finGetCachePanen();
  const today = finSawitPanenLastDate || finTodayStr();
  body.innerHTML = `
    <div class="fin-section-label">Input Panen Harian</div>
    <div class="field"><label>Tanggal</label><input type="date" id="finSawitPanenTgl" value="${today}"></div>
    <div class="field"><label>Berat TBS (kg)</label><input type="number" step="0.1" id="finSawitPanenKg" placeholder="0"></div>
    <button class="btn primary" id="finSawitPanenSaveBtn" style="width:100%; margin-bottom:20px;">Simpan</button>
    <div class="field-hint" style="margin-bottom:10px;">Riwayat panen terakhir</div>
    <div id="finSawitPanenHistory"></div>
  `;
  document.getElementById('finSawitPanenSaveBtn').addEventListener('click', async ()=>{
    const tgl = document.getElementById('finSawitPanenTgl').value;
    const kg = parseFloat(document.getElementById('finSawitPanenKg').value);
    if(!tgl){ showToast('Pilih tanggal dulu'); return; }
    if(isNaN(kg) || kg<=0){ showToast('Isi berat panen dulu'); return; }
    await finAddPanen(tgl, kg);
    // inget tanggal ini biar gampang lanjut input panen hari berikutnya, sama pola kayak HM Eksa
    finSawitPanenLastDate = finAddDaysStr(tgl, 1);
    showToast('Tersimpan');
    renderFinSawit();
  });

  const histEl = document.getElementById('finSawitPanenHistory');
  const recent = [...rows].reverse().slice(0,15);
  histEl.innerHTML = recent.length ? recent.map(r=>`
    <div class="fin-hm-row" data-id="${r.id}">
      <div><div class="fin-hm-date">${r.tgl.split('-').reverse().join('/')}</div></div>
      <div style="display:flex; align-items:center; gap:10px;"><div class="fin-hm-dur">${finFmtN(r.kg)} kg</div><button class="del" data-del="${r.id}" style="background:none;border:1px solid var(--line);border-radius:8px;color:var(--ink-soft);cursor:pointer;padding:4px 8px;font-size:12px;">✕</button></div>
    </div>
  `).join('') : '<div class="fin-empty">Belum ada data panen.</div>';
  histEl.querySelectorAll('[data-del]').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      if(!confirm('Hapus data panen ini?')) return;
      await finDeletePanen(btn.dataset.del);
      showToast('Dihapus');
      renderFinSawit();
    });
  });
}

function renderFinSawitRateTab(body){
  const rates = [...finGetCacheSawitRates()].sort((a,b)=>b.effectiveFrom.localeCompare(a.effectiveFrom));
  body.innerHTML = `<div id="finSawitRateList"></div><button class="btn primary" id="finSawitRateAddBtn" style="width:100%; margin-top:8px;">+ Tambah Rate Baru</button>`;
  const listEl = document.getElementById('finSawitRateList');
  listEl.innerHTML = rates.length ? rates.map(r=>`
    <div class="fin-rate-card" data-from="${r.effectiveFrom}">
      <div class="fin-rate-title"><span>Berlaku sejak ${r.effectiveFrom}</span><span style="color:var(--ink-soft); font-size:12px;">Edit ›</span></div>
      <div class="fin-rate-detail">
        Rp${(r.hargaPerKg||0).toLocaleString('id-ID')}/kg · Potongan ${r.potonganPercent||0}% · Pajak ${r.pajakPercent||0}%<br>
        Upah panen borongan: Rp${(r.upahPanenPerKg||0).toLocaleString('id-ID')}/kg
      </div>
    </div>
  `).join('') : '<div class="fin-empty">Belum ada rate harga TBS.</div>';
  listEl.querySelectorAll('[data-from]').forEach(card=>{
    card.addEventListener('click', ()=>openFinSawitRateSheet(rates.find(r=>r.effectiveFrom===card.dataset.from)));
  });
  document.getElementById('finSawitRateAddBtn').addEventListener('click', ()=>openFinSawitRateSheet(null));
}

function finPopulateSawitRateMonthSelects(selectedMonthKey){
  const bulanSel = document.getElementById('finSawitRateFromBulan');
  const tahunSel = document.getElementById('finSawitRateFromTahun');
  bulanSel.innerHTML = FIN_MONTHS.map((m,i)=>`<option value="${String(i+1).padStart(2,'0')}">${m}</option>`).join('');
  const thisYear = new Date().getFullYear();
  const years = []; for(let y=thisYear-2; y<=thisYear+3; y++) years.push(y);
  tahunSel.innerHTML = years.map(y=>`<option value="${y}">${y}</option>`).join('');
  const [y, m] = selectedMonthKey.split('-');
  tahunSel.value = y; bulanSel.value = m;
}

function openFinSawitRateSheet(rate){
  finEditingSawitRate = rate ? rate.effectiveFrom : null;
  document.getElementById('finSawitRateSheetTitle').textContent = rate ? 'Edit Rate' : 'Tambah Rate Baru';
  const nextMonth = new Date(finMonthCursor.getFullYear(), finMonthCursor.getMonth()+1, 1);
  finPopulateSawitRateMonthSelects(rate ? rate.effectiveFrom : finMonthKey(nextMonth));
  document.getElementById('finSawitRateFromBulan').disabled = !!rate;
  document.getElementById('finSawitRateFromTahun').disabled = !!rate;
  document.getElementById('finSawitRateHarga').value = rate ? rate.hargaPerKg : '';
  document.getElementById('finSawitRatePotongan').value = rate ? rate.potonganPercent : 0;
  document.getElementById('finSawitRatePajak').value = rate ? rate.pajakPercent : 0;
  document.getElementById('finSawitRateUpahPanen').value = rate ? rate.upahPanenPerKg : '';
  document.getElementById('finSawitRateDeleteBtn').style.display = rate ? '' : 'none';
  document.getElementById('finSawitRateOverlay').classList.add('show');
}
document.getElementById('finSawitRateCancelBtn').addEventListener('click', ()=>document.getElementById('finSawitRateOverlay').classList.remove('show'));
document.getElementById('finSawitRateOverlay').addEventListener('click', e=>{ if(e.target.id==='finSawitRateOverlay') e.currentTarget.classList.remove('show'); });
document.getElementById('finSawitRateSaveBtn').addEventListener('click', async ()=>{
  const effectiveFrom = document.getElementById('finSawitRateFromTahun').value+'-'+document.getElementById('finSawitRateFromBulan').value;
  const hargaPerKg = Number(document.getElementById('finSawitRateHarga').value)||0;
  if(hargaPerKg<=0){ showToast('Isi harga TBS per kg dulu'); return; }
  const rates = {
    hargaPerKg,
    potonganPercent: Number(document.getElementById('finSawitRatePotongan').value)||0,
    pajakPercent: Number(document.getElementById('finSawitRatePajak').value)||0,
    upahPanenPerKg: Number(document.getElementById('finSawitRateUpahPanen').value)||0,
  };
  await finAddSawitRate(effectiveFrom, rates);
  document.getElementById('finSawitRateOverlay').classList.remove('show');
  showToast('Rate tersimpan');
  renderFinSawit();
});
document.getElementById('finSawitRateDeleteBtn').addEventListener('click', async ()=>{
  if(!finEditingSawitRate) return;
  if(!confirm('Hapus rate ini?')) return;
  await finDeleteSawitRate(finEditingSawitRate);
  document.getElementById('finSawitRateOverlay').classList.remove('show');
  showToast('Rate dihapus');
  renderFinSawit();
});

function openFinSawitProfilSheet(){
  const p = finGetCacheSawitProfil();
  document.getElementById('finSawitProfilLuas').value = p.luasHektar || '';
  document.getElementById('finSawitProfilTahun').value = p.tahunTanam || '';
  document.getElementById('finSawitProfilPohon').value = p.jumlahPohon || '';
  document.getElementById('finSawitProfilOverlay').classList.add('show');
}
document.getElementById('finSawitProfilCancelBtn').addEventListener('click', ()=>document.getElementById('finSawitProfilOverlay').classList.remove('show'));
document.getElementById('finSawitProfilOverlay').addEventListener('click', e=>{ if(e.target.id==='finSawitProfilOverlay') e.currentTarget.classList.remove('show'); });
document.getElementById('finSawitProfilSaveBtn').addEventListener('click', async ()=>{
  const profil = {
    luasHektar: Number(document.getElementById('finSawitProfilLuas').value)||0,
    tahunTanam: Number(document.getElementById('finSawitProfilTahun').value)||0,
    jumlahPohon: Number(document.getElementById('finSawitProfilPohon').value)||0,
  };
  await finSetSawitProfil(profil);
  document.getElementById('finSawitProfilOverlay').classList.remove('show');
  showToast('Tersimpan');
  renderFinSawit();
});
