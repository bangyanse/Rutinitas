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
function finGetCacheUnits(){ try{ return JSON.parse(localStorage.getItem('fin_cache_units'))||[]; }catch(e){ return []; } }
function finSetCacheUnits(units){ localStorage.setItem('fin_cache_units', JSON.stringify(units)); }
function finGetCacheHm(){ try{ return JSON.parse(localStorage.getItem('fin_cache_hm'))||{}; }catch(e){ return {}; } } // {unitId:[...]}
function finSetCacheHm(data){ localStorage.setItem('fin_cache_hm', JSON.stringify(data)); }
function finGetCacheRates(){ try{ return JSON.parse(localStorage.getItem('fin_cache_rates'))||{}; }catch(e){ return {}; } } // {unitId:[...]}
function finSetCacheRates(data){ localStorage.setItem('fin_cache_rates', JSON.stringify(data)); }
function finGetHmForUnit(unitId){ return finGetCacheHm()[unitId]||[]; }
function finGetRatesForUnit(unitId){ return finGetCacheRates()[unitId]||[]; }
function finGetCacheAccounts(){ try{ return JSON.parse(localStorage.getItem('fin_cache_accounts'))||[]; }catch(e){ return []; } }
function finSetCacheAccounts(data){ localStorage.setItem('fin_cache_accounts', JSON.stringify(data)); }
function finGetCacheSaldo(){ try{ return JSON.parse(localStorage.getItem('fin_cache_saldo'))||{}; }catch(e){ return {}; } } // {monthKey:{accountId:amount}}
function finSetCacheSaldo(data){ localStorage.setItem('fin_cache_saldo', JSON.stringify(data)); }
function finGetSaldoForMonth(monthKey){ return finGetCacheSaldo()[monthKey]||{}; }
function finGetCacheCategories(){ try{ return JSON.parse(localStorage.getItem('fin_cache_categories'))||{}; }catch(e){ return {}; } } // {business:[...]}
function finSetCacheCategories(data){ localStorage.setItem('fin_cache_categories', JSON.stringify(data)); }
function finGetCategoriesFor(business){ return finGetCacheCategories()[business]||[]; }

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
  'acct-add':'/finance/accounts/add', 'acct-rename':'/finance/accounts/rename', 'acct-delete':'/finance/accounts/delete',
  'acct-saldo-set':'/finance/accounts/saldo/set',
  'cat-add':'/finance/categories/add', 'cat-delete':'/finance/categories/delete',
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
    date: partial.date || new Date().toISOString().slice(0,10),
    account: partial.account || '',
  };
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
  cache[business] = (cache[business]||[]).filter(t=>t.id!==txId);
  finSetCacheTx(cache);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('tx-delete', {vaultId, business, txId}); }
  catch(e){ finHandleSaveError(e, 'tx-delete', {business, txId}); }
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
async function finSetSaldoAwal(monthKey, accountId, amount){
  const all = finGetCacheSaldo(); all[monthKey] = all[monthKey]||{}; all[monthKey][accountId] = amount; finSetCacheSaldo(all);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('acct-saldo-set', {vaultId, monthKey, accountId, amount}); }
  catch(e){ finHandleSaveError(e, 'acct-saldo-set', {monthKey, accountId, amount}); }
}
async function finEnsureSaldoForMonth(monthKey){
  if(finGetCacheSaldo()[monthKey]) return; // udah pernah diambil
  const vaultId = finGetVaultId(); if(!vaultId) return;
  try{
    const saldo = await finApiPath('/finance/accounts/saldo/list', {vaultId, monthKey});
    const all = finGetCacheSaldo(); all[monthKey] = saldo; finSetCacheSaldo(all);
    renderKeuanganBody();
  }catch(e){ /* offline, biarin kosong dulu */ }
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
    const hmAll = {}, ratesAll = {};
    for(const u of units){
      hmAll[u.id] = await finApiPath('/finance/eksa/hm/list', {vaultId, unitId:u.id});
      ratesAll[u.id] = await finApiPath('/finance/eksa/rates/list', {vaultId, unitId:u.id});
    }
    finSetCacheHm(hmAll);
    finSetCacheRates(ratesAll);
    for(const u of units){
      if(!ratesAll[u.id] || ratesAll[u.id].length===0) await finSeedDefaultRates(u.id);
    }
    const accounts = await finApiPath('/finance/accounts/list', {vaultId});
    finSetCacheAccounts(accounts);
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
function finFmtN(n){ return parseFloat(parseFloat(n).toFixed(1)); }
function finMonthKey(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }
function finMonthLabel(d){ return FIN_MONTHS[d.getMonth()]+' '+d.getFullYear(); }
function finTxInMonth(list, monthKey){ return (list||[]).filter(t=>t.date && t.date.slice(0,7)===monthKey); }
function finHmInMonth(rows, monthKey){ return (rows||[]).filter(r=>r.tgl && r.tgl.slice(0,7)===monthKey); }
function finSumIn(list){ return list.filter(t=>t.type==='in').reduce((s,t)=>s+t.amount,0); }
function finSumOut(list){ return list.filter(t=>t.type==='out').reduce((s,t)=>s+t.amount,0); }

// Pendapatan & gaji operator 1 unit Eksa, bulan tertentu (belum dikurangi pengeluaran — itu dihitung gabungan semua unit)
function finEksaUnitMonthNet(unitId, monthKey){
  const rates = finGetRatesForUnit(unitId);
  if(!rates.length) return {pendapatan:0, gajiOperator:0, totalHM:0, hariKerja:0, rate:null};
  const hmRows = finHmInMonth(finGetHmForUnit(unitId), monthKey);
  const totalHM = finFmtN(hmRows.reduce((s,r)=>s+r.dur,0));
  const hariKerja = hmRows.length;
  const r = finRateForMonth(rates, monthKey);
  const pendapatan = finHitungPendapatan(totalHM, hariKerja, r);
  const gajiOperator = finHitungGajiOperator(totalHM, hariKerja, r);
  return {pendapatan, gajiOperator, totalHM, hariKerja, rate:r};
}

// Laba/rugi bersih 1 bulan untuk 1 bisnis (Eksa = jumlah semua unit dikurangi pengeluaran bareng; yang lain simpel masuk-keluar)
function finBusinessMonthNet(business, monthKey){
  if(business==='rental_eksa'){
    const units = finGetCacheUnits();
    let pendapatan=0, gajiOperator=0, totalHM=0, hariKerja=0;
    units.forEach(u=>{
      const r = finEksaUnitMonthNet(u.id, monthKey);
      pendapatan += r.pendapatan; gajiOperator += r.gajiOperator; totalHM += r.totalHM; hariKerja += r.hariKerja;
    });
    const tx = finTxInMonth((finGetCacheTx().rental_eksa||[]), monthKey);
    const pengeluaran = finSumOut(tx) - finSumIn(tx);
    const net = pendapatan - gajiOperator - pengeluaran;
    return {pendapatan, gajiOperator, pengeluaran, net, totalHM:finFmtN(totalHM), hariKerja};
  }
  const tx = finTxInMonth((finGetCacheTx()[business]||[]), monthKey);
  const masuk = finSumIn(tx), keluar = finSumOut(tx);
  return {masuk, keluar, net: masuk-keluar};
}

// Saldo tiap akun bank/e-wallet buat bulan tertentu = saldo awal (alokasi manual) +
// transaksi apapun (lintas bisnis) yang ditandain ke akun itu + pendapatan/gaji
// operator Eksa yang ditandain ke akun itu di setting unitnya.
function finAccountBalanceAll(monthKey){
  const accounts = finGetCacheAccounts();
  const saldoAwal = finGetSaldoForMonth(monthKey);
  const balances = {};
  accounts.forEach(a=>{ balances[a.id] = saldoAwal[a.id]||0; });
  const txAll = finGetCacheTx();
  Object.keys(txAll).forEach(biz=>{
    finTxInMonth(txAll[biz]||[], monthKey).forEach(t=>{
      if(t.account && balances.hasOwnProperty(t.account)){
        balances[t.account] += (t.type==='in'? t.amount : -t.amount);
      }
    });
  });
  finGetCacheUnits().forEach(u=>{
    const r = finEksaUnitMonthNet(u.id, monthKey);
    if(u.incomeAccountId && balances.hasOwnProperty(u.incomeAccountId)) balances[u.incomeAccountId] += r.pendapatan;
    if(u.salaryAccountId && balances.hasOwnProperty(u.salaryAccountId)) balances[u.salaryAccountId] -= r.gajiOperator;
  });
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
    saldoAwalBulanan: finGetCacheSaldo(),
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
  return `<button type="button" class="day-select-btn" id="finMonthSelectBtn" style="margin-top:0; margin-bottom:14px;">
    <span>${finMonthLabel(finMonthCursor)}</span>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
  </button>`;
}
function finWireMonthNav(afterChange){
  document.getElementById('finMonthSelectBtn').addEventListener('click', ()=>{
    const list = document.getElementById('finMonthOptionList'); list.innerHTML='';
    const cursorKey = finMonthKey(finMonthCursor);
    const options = [];
    const base = new Date();
    for(let i=-12;i<=3;i++) options.push(new Date(base.getFullYear(), base.getMonth()+i, 1));
    options.forEach(d=>{
      const key = finMonthKey(d);
      const row = document.createElement('div');
      row.className = 'opt-row'+(key===cursorKey?' selected':'');
      row.innerHTML = `<span>${finMonthLabel(d)}</span>` + (key===cursorKey?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>':'');
      row.addEventListener('click', ()=>{
        finMonthCursor = d;
        document.getElementById('finMonthOverlay').classList.remove('show');
        afterChange();
      });
      list.appendChild(row);
    });
    document.getElementById('finMonthOverlay').classList.add('show');
  });
}
document.getElementById('finMonthOverlay').addEventListener('click', e=>{ if(e.target.id==='finMonthOverlay') e.currentTarget.classList.remove('show'); });

/* ---------------- RINGKASAN (Dashboard) ---------------- */
function renderFinRingkasan(){
  const wrap = document.getElementById('keuanganContent'); wrap.innerHTML='';
  const monthKey = finMonthKey(finMonthCursor);
  finEnsureSaldoForMonth(monthKey);
  const main = document.createElement('div');
  main.innerHTML = finMonthNavHtml();
  wrap.appendChild(main);
  finWireMonthNav(renderFinRingkasan);

  const saldoTotal = finSaldoTotal(monthKey);
  const totalCard = document.createElement('div'); totalCard.className='fin-saldo-total-card';
  totalCard.innerHTML = `<div class="fin-saldo-total-label">Saldo Total</div><div class="fin-saldo-total-val">${finFmt(saldoTotal)}</div>`;
  main.appendChild(totalCard);

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

/* ---------------- PRIBADI (akun + pengeluaran harian + ringkasan bisnis) ---------------- */
function renderFinPribadi(){
  const wrap = document.getElementById('keuanganContent'); wrap.innerHTML='';
  const monthKey = finMonthKey(finMonthCursor);
  finEnsureSaldoForMonth(monthKey);
  const accounts = finGetCacheAccounts();
  const balances = finAccountBalanceAll(monthKey);

  const main = document.createElement('div');
  main.innerHTML = finBackLinkHtml() + finMonthNavHtml();
  wrap.appendChild(main);
  finWireBackLink();
  finWireMonthNav(renderFinPribadi);

  // --- Saldo per akun ---
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

  // --- Pengeluaran sehari-hari (kategori custom) ---
  const cache = finGetCacheTx();
  const txAll = finTxInMonth(cache.pribadi||[], monthKey).sort((a,b)=>b.date.localeCompare(a.date));
  const masuk = finSumIn(txAll), keluar = finSumOut(txAll);
  const expSection = document.createElement('div');
  expSection.innerHTML = `<div class="fin-section-label">Pengeluaran Sehari-hari</div>
    <div class="fin-total-card" style="margin-bottom:14px;">
      <div><div class="fin-total-label">Masuk</div><div class="fin-total-val" style="color:var(--positive); font-size:15px;">${finFmt(masuk)}</div></div>
      <div><div class="fin-total-label">Keluar</div><div class="fin-total-val" style="color:var(--danger); font-size:15px;">${finFmt(keluar)}</div></div>
      <div><div class="fin-total-label">Saldo</div><div class="fin-total-val" style="font-size:15px;">${finFmt(masuk-keluar)}</div></div>
    </div>
    ${txAll.length ? '<div id="finTxList"></div>' : '<div class="fin-empty">Belum ada transaksi bulan ini.</div>'}`;
  main.appendChild(expSection);
  if(txAll.length){
    const listEl = expSection.querySelector('#finTxList');
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
      row.addEventListener('click', ()=>openFinTxSheet('pribadi', txAll.find(t=>t.id===row.dataset.id)));
    });
  }

  // --- Pemasukan & pengeluaran dari bisnis (ringkasan, biar keliatan dari Pribadi juga) ---
  const bizSection = document.createElement('div');
  let bizHtml = `<div class="fin-section-label">Dari Bisnis</div>`;
  ['rental_eksa','sawit','walet'].forEach(biz=>{
    const r = finBusinessMonthNet(biz, monthKey);
    bizHtml += `<div class="fin-acct-row"><div class="fin-acct-name">${FIN_BIZ_LABEL[biz]}</div><div class="fin-acct-val" style="color:${r.net>=0?'var(--positive)':'var(--danger)'}">${finFmt(r.net)}</div></div>`;
  });
  bizSection.innerHTML = bizHtml;
  main.appendChild(bizSection);

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
  document.getElementById('finAcctSaldoAwal').value = acc ? (finGetSaldoForMonth(monthKey)[acc.id]||0) : 0;
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
  document.getElementById('finTxDate').value = tx ? tx.date : new Date().toISOString().slice(0,10);
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
  const amount = Number(document.getElementById('finTxAmount').value);
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
  if(tx) await finUpdateTx(business, {...tx, type, amount, category, date, note, account});
  else await finAddTx(business, {type, amount, category, date, note, account});
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
  const today = new Date().toISOString().slice(0,10);
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

function renderFinEksaPengeluaran(body){
  const monthKey = finMonthKey(finMonthCursor);
  const cache = finGetCacheTx();
  const txAll = finTxInMonth(cache.rental_eksa||[], monthKey).sort((a,b)=>b.date.localeCompare(a.date));
  const keluar = finSumOut(txAll);
  body.innerHTML = finMonthNavHtml() +
    `<div class="fin-total-card" style="margin-bottom:14px;">
      <div class="fin-total-label">Total Pengeluaran Bulan Ini</div><div class="fin-total-val" style="color:var(--danger);">${finFmt(keluar)}</div>
    </div>` +
    (txAll.length ? `<div id="finTxList"></div>` : `<div class="fin-empty">Belum ada pengeluaran tambahan bulan ini.<br>Tap tombol + buat nambah (perawatan, sparepart, dll).</div>`);
  finWireMonthNav(renderFinEksa);

  if(txAll.length){
    const listEl = document.getElementById('finTxList');
    listEl.innerHTML = txAll.map(t=>`
      <div class="fin-tx-item" data-id="${t.id}">
        <div>
          <div class="fin-tx-cat">${escapeHtml(t.category||'Lainnya')}</div>
          ${t.note?`<div class="fin-tx-note">${escapeHtml(t.note)}</div>`:''}
          <div class="fin-tx-date">${t.date.split('-').reverse().join('/')}</div>
        </div>
        <div class="fin-tx-amt out">-${finFmt(t.amount)}</div>
      </div>
    `).join('');
    listEl.querySelectorAll('.fin-tx-item').forEach(row=>{
      row.addEventListener('click', ()=>{
        const tx = txAll.find(t=>t.id===row.dataset.id);
        openFinTxSheet('rental_eksa', tx);
      });
    });
  }
  const fab = document.createElement('button');
  fab.className='fin-fab'; fab.innerHTML='+';
  fab.addEventListener('click', ()=>openFinTxSheet('rental_eksa', null));
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
      <div class="fin-report-row"><span>Pendapatan Kotor</span><span>${finFmt(ur.pendapatan)}</span></div>
      <div class="fin-report-row"><span>Gaji Operator</span><span>-${finFmt(ur.gajiOperator)}</span></div>
      <div class="fin-report-row"><span>Subtotal Unit Ini</span><span>${finFmt(ur.pendapatan-ur.gajiOperator)}</span></div>
      <div class="fin-report-note">${ur.hariKerja} hari kerja · ${ur.totalHM} HM · rate berlaku sejak ${ur.rate.effectiveFrom}</div>
    </div>
  `;
  if(units.length>1){
    html += `
    <div class="fin-report-card">
      <div class="fin-report-note" style="margin:0 0 10px; font-weight:700; color:var(--ink);">Total Semua Unit Eksa</div>
      <div class="fin-report-row"><span>Total Pendapatan</span><span>${finFmt(total.pendapatan)}</span></div>
      <div class="fin-report-row"><span>Total Gaji Operator</span><span>-${finFmt(total.gajiOperator)}</span></div>
      <div class="fin-report-row"><span>Pengeluaran Tambahan (bareng)</span><span>${total.pengeluaran>=0?'-':'+'}${finFmt(Math.abs(total.pengeluaran))}</span></div>
      <div class="fin-report-row"><span>Laba Bersih</span><span style="color:${total.net>=0?'var(--positive)':'var(--danger)'}">${finFmt(total.net)}</span></div>
    </div>`;
  } else {
    html += `
    <div class="fin-report-card">
      <div class="fin-report-row"><span>Pengeluaran Tambahan</span><span>${total.pengeluaran>=0?'-':'+'}${finFmt(Math.abs(total.pengeluaran))}</span></div>
      <div class="fin-report-row"><span>Laba Bersih</span><span style="color:${total.net>=0?'var(--positive)':'var(--danger)'}">${finFmt(total.net)}</span></div>
    </div>`;
  }
  cardWrap.innerHTML = html;
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
