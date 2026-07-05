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
function finGetCacheHm(){ try{ return JSON.parse(localStorage.getItem('fin_cache_hm'))||[]; }catch(e){ return []; } }
function finSetCacheHm(rows){ localStorage.setItem('fin_cache_hm', JSON.stringify(rows)); }
function finGetCacheRates(){ try{ return JSON.parse(localStorage.getItem('fin_cache_rates'))||[]; }catch(e){ return []; } }
function finSetCacheRates(rates){ localStorage.setItem('fin_cache_rates', JSON.stringify(rates)); }

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
};
function finApiRaw(kind, body){
  return fetch(PUSH_SERVER_URL+FIN_ENDPOINT[kind], {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  }).then(r=>{ if(!r.ok) throw new Error('http '+r.status); return r.json(); });
}
function finApiPath(path, body){
  return fetch(PUSH_SERVER_URL+path, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  }).then(r=>{ if(!r.ok) throw new Error('http '+r.status); return r.json(); });
}

let finFlushing = false;
async function finFlushQueue(){
  if(finFlushing) return;
  const vaultId = finGetVaultId(); if(!vaultId) return;
  finFlushing = true;
  try{
    let q = finGetQueue();
    while(q.length){
      const item = q[0];
      try{
        await finApiRaw(item.kind, {...item.payload, vaultId});
        q.shift();
        finSetQueue(q);
      }catch(err){ break; } // masih offline / server gak bisa dihubungi, coba lagi nanti
    }
  } finally { finFlushing = false; }
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
  };
  const cache = finGetCacheTx(); cache[business] = cache[business]||[]; cache[business].push(tx); finSetCacheTx(cache);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('tx-add', {vaultId, business, tx}); }
  catch(e){ finQueuePush('tx-add', {business, tx}); }
  return tx;
}
async function finUpdateTx(business, tx){
  const cache = finGetCacheTx();
  const idx = (cache[business]||[]).findIndex(t=>t.id===tx.id);
  if(idx>-1) cache[business][idx]=tx;
  finSetCacheTx(cache);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('tx-update', {vaultId, business, tx}); }
  catch(e){ finQueuePush('tx-update', {business, tx}); }
}
async function finDeleteTx(business, txId){
  const cache = finGetCacheTx();
  cache[business] = (cache[business]||[]).filter(t=>t.id!==txId);
  finSetCacheTx(cache);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('tx-delete', {vaultId, business, txId}); }
  catch(e){ finQueuePush('tx-delete', {business, txId}); }
}

async function finAddHm(tgl, hmAwal, hmAkhir){
  const entry = { id:finNewId('hm'), tgl, hmAwal:Number(hmAwal), hmAkhir:Number(hmAkhir), dur:Math.round((Number(hmAkhir)-Number(hmAwal))*10)/10 };
  const rows = finGetCacheHm(); rows.push(entry); rows.sort((a,b)=>a.tgl.localeCompare(b.tgl)); finSetCacheHm(rows);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('hm-add', {vaultId, id:entry.id, tgl, hmAwal:entry.hmAwal, hmAkhir:entry.hmAkhir}); }
  catch(e){ finQueuePush('hm-add', {id:entry.id, tgl, hmAwal:entry.hmAwal, hmAkhir:entry.hmAkhir}); }
  return entry;
}
async function finDeleteHm(id){
  finSetCacheHm(finGetCacheHm().filter(r=>r.id!==id));
  const vaultId = finGetVaultId();
  try{ await finApiRaw('hm-delete', {vaultId, id}); }
  catch(e){ finQueuePush('hm-delete', {id}); }
}

async function finAddRate(effectiveFrom, rates){
  const list = finGetCacheRates();
  const idx = list.findIndex(r=>r.effectiveFrom===effectiveFrom);
  const entry = {effectiveFrom, ...rates};
  if(idx>-1) list[idx]=entry; else list.push(entry);
  list.sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom));
  finSetCacheRates(list);
  const vaultId = finGetVaultId();
  try{ await finApiRaw('rate-add', {vaultId, effectiveFrom, rates}); }
  catch(e){ finQueuePush('rate-add', {effectiveFrom, rates}); }
}
async function finDeleteRate(effectiveFrom){
  const list = finGetCacheRates();
  if(list.length<=1){ showToast('Minimal harus ada 1 rate aktif'); return; }
  finSetCacheRates(list.filter(r=>r.effectiveFrom!==effectiveFrom));
  const vaultId = finGetVaultId();
  try{ await finApiRaw('rate-delete', {vaultId, effectiveFrom}); }
  catch(e){ finQueuePush('rate-delete', {effectiveFrom}); }
}

/* ---------------- Sinkron penuh dari server ---------------- */
async function finSyncAll(){
  const vaultId = finGetVaultId(); if(!vaultId) return;
  await finFlushQueue();
  if(finGetQueue().length) return; // masih ada yang mengantri / lagi offline, jangan timpa cache lokal
  try{
    const [txRes, hmRes, rateRes] = await Promise.all([
      finApiPath('/finance/list', {vaultId}),
      finApiPath('/finance/eksa/hm/list', {vaultId}),
      finApiPath('/finance/eksa/rates/list', {vaultId}),
    ]);
    finSetCacheTx(txRes);
    finSetCacheHm(hmRes);
    if(rateRes.length===0) await finSeedDefaultRates();
    else finSetCacheRates(rateRes);
    renderKeuanganBody();
  }catch(e){ /* offline — biarin pakai cache lama */ }
}
async function finSeedDefaultRates(){
  // Rate dasar (sama seperti app HM Eksavator lama) + penyesuaian yang mulai berlaku Mei 2026
  await finAddRate('2000-01', {gajiPerHM:275000, ppnPct:2, tunjanganHarian:50000, gajiOperatorHM:50000, gajiOperatorLebih:60000, batasHM:175, tunjanganOperatorHarian:100000});
  await finAddRate('2026-05', {gajiPerHM:275000, ppnPct:2, tunjanganHarian:50000, gajiOperatorHM:50000, gajiOperatorLebih:60000, batasHM:175, tunjanganOperatorHarian:115000});
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
function finHitungGajiOperator(totalHM, hariKerja, r){
  let gaji;
  if(totalHM<=r.batasHM) gaji = totalHM*r.gajiOperatorHM;
  else gaji = r.batasHM*r.gajiOperatorHM + (totalHM-r.batasHM)*r.gajiOperatorLebih;
  return gaji + hariKerja*r.tunjanganOperatorHarian;
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

// Laba/rugi bersih 1 bulan untuk 1 bisnis (Eksa pakai rumus HM, yang lain simpel masuk-keluar)
function finBusinessMonthNet(business, monthKey){
  if(business==='rental_eksa'){
    const rates = finGetCacheRates();
    if(!rates.length) return {pendapatan:0, gajiOperator:0, pengeluaran:0, net:0};
    const hmRows = finHmInMonth(finGetCacheHm(), monthKey);
    const totalHM = finFmtN(hmRows.reduce((s,r)=>s+r.dur,0));
    const hariKerja = hmRows.length;
    const r = finRateForMonth(rates, monthKey);
    const pendapatan = finHitungPendapatan(totalHM, hariKerja, r);
    const gajiOperator = finHitungGajiOperator(totalHM, hariKerja, r);
    const tx = finTxInMonth((finGetCacheTx().rental_eksa||[]), monthKey);
    const pengeluaran = finSumOut(tx) - finSumIn(tx); // pemasukan tambahan (kalau ada) mengurangi biaya
    const net = pendapatan - gajiOperator - pengeluaran;
    return {pendapatan, gajiOperator, pengeluaran, net, totalHM, hariKerja, rate:r};
  }
  const tx = finTxInMonth((finGetCacheTx()[business]||[]), monthKey);
  const masuk = finSumIn(tx), keluar = finSumOut(tx);
  return {masuk, keluar, net: masuk-keluar};
}

/* =======================================================================
   RENDER
   ======================================================================= */
let finActiveBiz = 'ringkasan';
let finEksaSubTab = 'input';
let finMonthCursor = new Date();
let finEditingTx = null; // {business, tx} kalau lagi edit, null kalau tambah baru
let finEditingRate = null; // effectiveFrom kalau lagi edit rate

function renderKeuangan(){
  finRenderQueueBadge();
  const seg = document.getElementById('finBizSegmented');
  if(!finGetVaultId()){
    seg.style.display='none';
    renderFinVaultSetup();
    return;
  }
  seg.style.display='';
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
  else renderFinSimpleBusiness(finActiveBiz);
}

// segmented tab (biz) — dipasang sekali
document.querySelectorAll('#finBizSegmented button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('#finBizSegmented button').forEach(b=>b.classList.toggle('active', b===btn));
    finActiveBiz = btn.dataset.biz;
    renderKeuanganBody();
  });
});

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

/* ---------------- RINGKASAN ---------------- */
function renderFinRingkasan(){
  const wrap = document.getElementById('keuanganContent'); wrap.innerHTML='';
  const monthKey = finMonthKey(finMonthCursor);
  const main = document.createElement('div');
  main.innerHTML = finMonthNavHtml() + '<div id="finRingkasanRows"></div>';
  wrap.appendChild(main);
  finWireMonthNav(renderFinRingkasan);

  const rowsWrap = document.getElementById('finRingkasanRows');
  let grandTotal = 0;
  let html = '';
  FIN_BUSINESSES.forEach(biz=>{
    const r = finBusinessMonthNet(biz, monthKey);
    grandTotal += r.net;
    const sub = biz==='rental_eksa'
      ? `${r.hariKerja||0} hari kerja · ${r.totalHM||0} HM`
      : `Masuk ${finFmt(r.masuk)} · Keluar ${finFmt(r.keluar)}`;
    html += `<div class="fin-summary-row" data-goto="${biz}">
      <div>
        <div class="fin-summary-biz">${FIN_BIZ_LABEL[biz]}</div>
        <div class="fin-summary-sub">${sub}</div>
      </div>
      <div class="fin-summary-val ${r.net>=0?'pos':'neg'}">${finFmt(r.net)}</div>
    </div>`;
  });
  rowsWrap.innerHTML = html;
  rowsWrap.querySelectorAll('[data-goto]').forEach(row=>{
    row.addEventListener('click', ()=>{
      finActiveBiz = row.dataset.goto;
      document.querySelectorAll('#finBizSegmented button').forEach(b=>b.classList.toggle('active', b.dataset.biz===finActiveBiz));
      renderKeuanganBody();
    });
  });
  const totalCard = document.createElement('div'); totalCard.className='fin-total-card';
  totalCard.innerHTML = `<div class="fin-total-label">Total semua bisnis</div><div class="fin-total-val" style="color:${grandTotal>=0?'var(--positive)':'var(--danger)'}">${finFmt(grandTotal)}</div>`;
  main.appendChild(totalCard);
}

/* ---------------- BISNIS SIMPEL (Pribadi/Sawit/Walet) ---------------- */
function renderFinSimpleBusiness(biz){
  const wrap = document.getElementById('keuanganContent'); wrap.innerHTML='';
  const monthKey = finMonthKey(finMonthCursor);
  const cache = finGetCacheTx();
  const txAll = finTxInMonth(cache[biz]||[], monthKey).sort((a,b)=>b.date.localeCompare(a.date));
  const masuk = finSumIn(txAll), keluar = finSumOut(txAll);

  const main = document.createElement('div');
  main.innerHTML = finMonthNavHtml() +
    `<div class="fin-total-card" style="margin-bottom:14px;">
      <div><div class="fin-total-label">Masuk</div><div class="fin-total-val" style="color:var(--positive); font-size:15px;">${finFmt(masuk)}</div></div>
      <div><div class="fin-total-label">Keluar</div><div class="fin-total-val" style="color:var(--danger); font-size:15px;">${finFmt(keluar)}</div></div>
      <div><div class="fin-total-label">Saldo</div><div class="fin-total-val" style="font-size:15px;">${finFmt(masuk-keluar)}</div></div>
    </div>` +
    (txAll.length ? `<div id="finTxList"></div>` : `<div class="fin-empty">Belum ada transaksi bulan ini.<br>Tap tombol + buat nambah.</div>`);
  wrap.appendChild(main);
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
function openFinTxSheet(business, tx){
  finEditingTx = tx ? {business, tx} : {business, tx:null};
  document.getElementById('finTxSheetTitle').textContent = tx ? 'Edit Transaksi' : 'Tambah Transaksi';
  const type = tx ? tx.type : 'in';
  document.querySelectorAll('#finTxTypeToggle button').forEach(b=>{
    b.classList.toggle('active', b.dataset.type===type);
    b.classList.toggle('in', b.dataset.type==='in');
    b.classList.toggle('out', b.dataset.type==='out');
  });
  document.getElementById('finTxAmount').value = tx ? tx.amount : '';
  document.getElementById('finTxCategory').value = tx ? tx.category : '';
  document.getElementById('finTxDate').value = tx ? tx.date : new Date().toISOString().slice(0,10);
  document.getElementById('finTxNote').value = tx ? tx.note : '';
  const dl = document.getElementById('finTxCategoryList');
  dl.innerHTML = (FIN_CATEGORY_PRESET[business]||[]).map(c=>`<option value="${escapeHtml(c)}">`).join('');
  document.getElementById('finTxDeleteBtn').style.display = tx ? '' : 'none';
  document.getElementById('finTxOverlay').classList.add('show');
}
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
  const category = document.getElementById('finTxCategory').value.trim();
  const date = document.getElementById('finTxDate').value;
  const note = document.getElementById('finTxNote').value.trim();
  const type = document.querySelector('#finTxTypeToggle button.active').dataset.type;
  if(!amount || amount<=0){ showToast('Isi jumlahnya dulu ya'); return; }
  if(!date){ showToast('Pilih tanggal dulu ya'); return; }
  const {business, tx} = finEditingTx;
  if(tx) await finUpdateTx(business, {...tx, type, amount, category, date, note});
  else await finAddTx(business, {type, amount, category, date, note});
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
function renderFinEksa(){
  const wrap = document.getElementById('keuanganContent'); wrap.innerHTML='';
  const sub = document.createElement('div');
  sub.className='segmented'; sub.style.marginBottom='16px';
  sub.innerHTML = ['input','pengeluaran','laporan','rate'].map(t=>{
    const label = {input:'Input HM', pengeluaran:'Pengeluaran', laporan:'Laporan', rate:'Rate'}[t];
    return `<button type="button" class="${finEksaSubTab===t?'active':''}" data-sub="${t}">${label}</button>`;
  }).join('');
  wrap.appendChild(sub);
  sub.querySelectorAll('button').forEach(b=>{
    b.addEventListener('click', ()=>{ finEksaSubTab = b.dataset.sub; renderFinEksa(); });
  });

  const body = document.createElement('div');
  wrap.appendChild(body);

  if(finEksaSubTab==='input') renderFinEksaInput(body);
  else if(finEksaSubTab==='pengeluaran') renderFinEksaPengeluaran(body);
  else if(finEksaSubTab==='laporan') renderFinEksaLaporan(body);
  else renderFinEksaRate(body);
}

function renderFinEksaInput(body){
  const rows = finGetCacheHm();
  const lastRow = rows[rows.length-1];
  const today = new Date().toISOString().slice(0,10);
  body.innerHTML = `
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
    await finAddHm(tgl, hmAwal, hmAkhir);
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
      await finDeleteHm(btn.dataset.del);
      showToast('Dihapus');
      renderFinEksa();
    });
  });
}

function renderFinEksaPengeluaran(body){
  const monthKey = finMonthKey(finMonthCursor);
  const cache = finGetCacheTx();
  const txAll = finTxInMonth(cache.rental_eksa||[], monthKey).sort((a,b)=>b.date.localeCompare(a.date));
  const keluar = finSumOut(txAll), masuk = finSumIn(txAll);
  body.innerHTML = finMonthNavHtml() +
    `<div class="fin-total-card" style="margin-bottom:14px;">
      <div><div class="fin-total-label">Total Pengeluaran</div><div class="fin-total-val" style="color:var(--danger); font-size:15px;">${finFmt(keluar)}</div></div>
      <div><div class="fin-total-label">Pemasukan Lain</div><div class="fin-total-val" style="color:var(--positive); font-size:15px;">${finFmt(masuk)}</div></div>
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
        <div class="fin-tx-amt ${t.type}">${t.type==='out'?'-':'+'}${finFmt(t.amount)}</div>
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
  const rates = finGetCacheRates();
  body.innerHTML = finMonthNavHtml() + '<div id="finLaporanCard"></div>';
  finWireMonthNav(renderFinEksa);
  const cardWrap = document.getElementById('finLaporanCard');
  if(!rates.length){ cardWrap.innerHTML = '<div class="fin-empty">Rate belum di-setup. Buka tab Rate dulu.</div>'; return; }
  const r = finBusinessMonthNet('rental_eksa', monthKey);
  cardWrap.innerHTML = `
    <div class="fin-report-card">
      <div class="fin-report-row"><span>Pendapatan Kotor</span><span>${finFmt(r.pendapatan)}</span></div>
      <div class="fin-report-row"><span>Gaji Operator</span><span>-${finFmt(r.gajiOperator)}</span></div>
      <div class="fin-report-row"><span>Pengeluaran Tambahan</span><span>${r.pengeluaran>=0?'-':'+'}${finFmt(Math.abs(r.pengeluaran))}</span></div>
      <div class="fin-report-row"><span>Laba Bersih</span><span style="color:${r.net>=0?'var(--positive)':'var(--danger)'}">${finFmt(r.net)}</span></div>
      <div class="fin-report-note">${r.hariKerja} hari kerja · ${r.totalHM} total HM · pakai rate berlaku sejak ${r.rate.effectiveFrom}</div>
    </div>
  `;
}

function renderFinEksaRate(body){
  const rates = [...finGetCacheRates()].sort((a,b)=>b.effectiveFrom.localeCompare(a.effectiveFrom));
  body.innerHTML = `<div id="finRateList"></div><button class="btn primary" id="finRateAddBtn" style="width:100%; margin-top:8px;">+ Tambah Rate Baru</button>`;
  const listEl = document.getElementById('finRateList');
  listEl.innerHTML = rates.length ? rates.map(r=>`
    <div class="fin-rate-card" data-from="${r.effectiveFrom}">
      <div class="fin-rate-title"><span>Berlaku sejak ${r.effectiveFrom}</span><span style="color:var(--ink-soft); font-size:12px;">Edit ›</span></div>
      <div class="fin-rate-detail">
        Rp${(r.gajiPerHM||0).toLocaleString('id-ID')}/HM · PPN ${r.ppnPct}% · Tunjangan Rp${(r.tunjanganHarian||0).toLocaleString('id-ID')}/hari<br>
        Gaji operator Rp${(r.gajiOperatorHM||0).toLocaleString('id-ID')}/HM (≤${r.batasHM} HM), Rp${(r.gajiOperatorLebih||0).toLocaleString('id-ID')}/HM (lebihnya) + Rp${(r.tunjanganOperatorHarian||0).toLocaleString('id-ID')}/hari
      </div>
    </div>
  `).join('') : '<div class="fin-empty">Belum ada rate.</div>';
  listEl.querySelectorAll('[data-from]').forEach(card=>{
    card.addEventListener('click', ()=>openFinRateSheet(rates.find(r=>r.effectiveFrom===card.dataset.from)));
  });
  document.getElementById('finRateAddBtn').addEventListener('click', ()=>openFinRateSheet(null));
}

function openFinRateSheet(rate){
  finEditingRate = rate ? rate.effectiveFrom : null;
  document.getElementById('finRateSheetTitle').textContent = rate ? 'Edit Rate' : 'Tambah Rate Baru';
  const nextMonth = new Date(finMonthCursor.getFullYear(), finMonthCursor.getMonth()+1, 1);
  document.getElementById('finRateFrom').value = rate ? rate.effectiveFrom : finMonthKey(nextMonth);
  document.getElementById('finRateFrom').disabled = !!rate;
  document.getElementById('finRateGajiPerHM').value = rate ? rate.gajiPerHM : 275000;
  document.getElementById('finRatePpn').value = rate ? rate.ppnPct : 2;
  document.getElementById('finRateTunjanganHarian').value = rate ? rate.tunjanganHarian : 50000;
  document.getElementById('finRateGajiOpHM').value = rate ? rate.gajiOperatorHM : 50000;
  document.getElementById('finRateGajiOpLebih').value = rate ? rate.gajiOperatorLebih : 60000;
  document.getElementById('finRateBatasHM').value = rate ? rate.batasHM : 175;
  document.getElementById('finRateTunjanganOp').value = rate ? rate.tunjanganOperatorHarian : 100000;
  document.getElementById('finRateDeleteBtn').style.display = rate ? '' : 'none';
  document.getElementById('finRateOverlay').classList.add('show');
}
document.getElementById('finRateCancelBtn').addEventListener('click', ()=>document.getElementById('finRateOverlay').classList.remove('show'));
document.getElementById('finRateOverlay').addEventListener('click', e=>{ if(e.target.id==='finRateOverlay') e.currentTarget.classList.remove('show'); });
document.getElementById('finRateSaveBtn').addEventListener('click', async ()=>{
  const effectiveFrom = document.getElementById('finRateFrom').value;
  if(!effectiveFrom){ showToast('Pilih bulan berlaku dulu'); return; }
  const rates = {
    gajiPerHM: Number(document.getElementById('finRateGajiPerHM').value)||0,
    ppnPct: Number(document.getElementById('finRatePpn').value)||0,
    tunjanganHarian: Number(document.getElementById('finRateTunjanganHarian').value)||0,
    gajiOperatorHM: Number(document.getElementById('finRateGajiOpHM').value)||0,
    gajiOperatorLebih: Number(document.getElementById('finRateGajiOpLebih').value)||0,
    batasHM: Number(document.getElementById('finRateBatasHM').value)||0,
    tunjanganOperatorHarian: Number(document.getElementById('finRateTunjanganOp').value)||0,
  };
  await finAddRate(effectiveFrom, rates);
  document.getElementById('finRateOverlay').classList.remove('show');
  showToast('Rate tersimpan');
  renderFinEksa();
});
document.getElementById('finRateDeleteBtn').addEventListener('click', async ()=>{
  if(!finEditingRate) return;
  if(!confirm('Hapus rate ini?')) return;
  await finDeleteRate(finEditingRate);
  document.getElementById('finRateOverlay').classList.remove('show');
  showToast('Rate dihapus');
  renderFinEksa();
});
