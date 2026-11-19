// ==========================================
// INISIALISASI SUPABASE & STATE GLOBAL
// ==========================================
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let state = {
  user: null,
  settings: { company_name: 'SISTEM INVENTARIS ATK', subtitle: 'Manajemen Stok & Operasional', address: '', gdrive_script_url: '', gdrive_secret_key: '' },
  categories: [],
  partners: [],
  items: [],
  transactions: []
};

// ==========================================
// UTILITAS & FORMATTER
// ==========================================
function formatRupiah(num) {
  return 'Rp ' + Math.round(Number(num) || 0).toLocaleString('id-ID');
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  const bg = type === 'error' ? 'bg-swiss-red text-white' : 'bg-swiss-ink text-white';
  el.className = `${bg} px-4 py-3 text-xs font-mono border border-swiss-ink shadow-sm transition-opacity duration-300`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// Konversi saldo base_unit menjadi pecahan satuan besar otomatis (misal: 9 RIM -> "1 BOX, 4 RIM")
function formatStockBreakdown(item) {
  const total = Number(item.current_stock) || 0;
  const baseUnit = item.base_unit || 'PCS';
  const units = (item.item_units || [])
    .filter(u => Number(u.conversion_factor) > 1)
    .sort((a, b) => Number(b.conversion_factor) - Number(a.conversion_factor));

  if (total === 0 || units.length === 0) {
    return `${total} ${baseUnit}`;
  }

  const isNegative = total < 0;
  let remaining = Math.abs(total);
  const parts = [];

  for (const u of units) {
    const factor = Number(u.conversion_factor);
    const count = Math.floor(remaining / factor);
    if (count > 0) {
      parts.push(`${count} ${u.unit_name}`);
      remaining = Math.round((remaining - count * factor) * 1000) / 1000;
    }
  }

  if (remaining > 0 || parts.length === 0) {
    parts.push(`${remaining} ${baseUnit}`);
  }

  const formatted = (isNegative ? '-' : '') + parts.join(', ');
  return units.length > 0 && parts.length > 0 && formatted !== `${total} ${baseUnit}`
    ? `${formatted} <span class="text-swiss-muted font-normal">(${total} ${baseUnit})</span>`
    : formatted;
}

function formatStockPlain(item) {
  return formatStockBreakdown(item).replace(/<[^>]+>/g, '');
}

// ==========================================
// AUTENTIKASI (LOGIN / LOGOUT)
// ==========================================
async function checkSession() {
  const { data: { session } } = await db.auth.getSession();
  if (session) {
    state.user = session.user;
    showApp();
  } else {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-screen').classList.add('hidden');
}

async function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-screen').classList.remove('hidden');
  document.getElementById('user-email-display').textContent = state.user.email;

  // Set default tanggal & filter bulan hari ini
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('tx-date').value = today;
  document.getElementById('filter-tx-month').value = today.substring(0, 7);

  await loadAllData();
  switchTab('dashboard');
  onTxTypeChange();
  resetCart();
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Memeriksa akun...';

  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  const { data, error } = await db.auth.signInWithPassword({ email, password });
  btn.disabled = false;
  btn.textContent = 'Masuk ke Sistem →';

  if (error) {
    errEl.textContent = 'Login gagal: ' + error.message;
    errEl.classList.remove('hidden');
    return;
  }
  state.user = data.user;
  showApp();
});

async function logout() {
  await db.auth.signOut();
  state.user = null;
  showLogin();
}

// Mobile Menu Toggle
document.getElementById('mobile-menu-toggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('hidden');
});

// ==========================================
// NAVIGASI TAB
// ==========================================
function switchTab(tabName) {
  document.querySelectorAll('.tab-section').forEach(s => s.classList.add('hidden'));
  document.getElementById(`tab-${tabName}`).classList.remove('hidden');

  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabName);
  });

  // Tutup menu di HP setelah klik
  if (window.innerWidth < 768) {
    document.getElementById('sidebar').classList.add('hidden');
  }

  if (tabName === 'reports') {
    loadStockCard();
    renderReceiptGallery();
  }
}

// ==========================================
// MUAT SEMUA DATA DARI SUPABASE
// ==========================================
async function loadAllData() {
  try {
    const [setRes, catRes, partRes, itemRes, txRes] = await Promise.all([
      db.from('app_settings').select('*').eq('id', 1).single(),
      db.from('categories').select('*').order('name'),
      db.from('partners').select('*').order('name'),
      db.from('items').select('*, categories(name), item_units(*)').order('name'),
      db.from('transactions').select('*, partners(name, type)').order('transaction_date', { ascending: false }).order('created_at', { ascending: false }).limit(200)
    ]);

    if (setRes.data) state.settings = setRes.data;
    state.categories = catRes.data || [];
    state.partners = partRes.data || [];
    state.items = itemRes.data || [];
    state.transactions = txRes.data || [];

    applyWhiteLabel();
    renderDashboard();
    renderMasterData();
    renderItemsTable();
    renderTransactionsTable();
    populateDropdowns();
  } catch (err) {
    showToast('Gagal memuat data: ' + err.message, 'error');
  }
}

function applyWhiteLabel() {
  const s = state.settings;
  document.title = s.company_name || 'Sistem Inventaris ATK';
  document.querySelectorAll('.brand-name').forEach(el => el.textContent = s.company_name || 'SISTEM INVENTARIS ATK');
  document.querySelectorAll('.brand-subtitle').forEach(el => el.textContent = s.subtitle || '');
  const loginTitle = document.getElementById('login-company-name');
  if (loginTitle) loginTitle.textContent = s.company_name || 'SISTEM INVENTARIS ATK';

  // Isi form pengaturan
  document.getElementById('set-company').value = s.company_name || '';
  document.getElementById('set-subtitle').value = s.subtitle || '';
  document.getElementById('set-address').value = s.address || '';
  document.getElementById('set-gdrive-url').value = s.gdrive_script_url || '';
  document.getElementById('set-gdrive-key').value = s.gdrive_secret_key || '';
}

function populateDropdowns() {
  // Filter kategori di halaman Master Barang
  const filterCat = document.getElementById('filter-item-cat');
  const prevCat = filterCat.value;
  filterCat.innerHTML = '<option value="">Semua Kategori</option>' +
    state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  filterCat.value = prevCat;

  // Pilihan kategori di Modal Barang
  document.getElementById('item-category').innerHTML = '<option value="">-- Tanpa Kategori --</option>' +
    state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');

  // Pilihan barang di Kartu Stok
  const repItem = document.getElementById('report-item-select');
  const prevRep = repItem.value;
  repItem.innerHTML = '<option value="">-- Pilih Barang --</option>' +
    state.items.map(i => `<option value="${i.id}">[${escapeHtml(i.sku)}] ${escapeHtml(i.name)}</option>`).join('');
  if (prevRep) repItem.value = prevRep;

  updatePartnerDropdown();
}

// ==========================================
// 1. DASHBOARD
// ==========================================
function renderDashboard() {
  const lowItems = state.items.filter(i => Number(i.current_stock) <= Number(i.min_stock));
  const currentMonth = new Date().toISOString().substring(0, 7);
  const monthTx = state.transactions.filter(t => (t.transaction_date || '').startsWith(currentMonth));
  const totalValue = state.items.reduce((sum, i) => sum + (Math.max(0, Number(i.current_stock)) * Number(i.avg_cost || 0)), 0);

  document.getElementById('kpi-total-items').textContent = state.items.length;
  document.getElementById('kpi-low-stock').textContent = lowItems.length;
  document.getElementById('kpi-month-tx').textContent = monthTx.length;
  document.getElementById('kpi-stock-value').textContent = formatRupiah(totalValue);

  // Tabel Stok Menipis
  const lowBody = document.getElementById('dash-low-stock-body');
  if (lowItems.length === 0) {
    lowBody.innerHTML = '<tr><td colspan="3" class="p-4 text-center text-swiss-muted font-mono">Semua stok dalam batas aman.</td></tr>';
  } else {
    lowBody.innerHTML = lowItems.slice(0, 8).map(i => `
      <tr>
        <td class="p-3"><div class="font-semibold">${escapeHtml(i.name)}</div><div class="font-mono text-[10px] text-swiss-muted">${escapeHtml(i.sku)}</div></td>
        <td class="p-3 font-mono font-bold text-swiss-red">${formatStockBreakdown(i)}</td>
        <td class="p-3 font-mono text-swiss-muted">${i.min_stock} ${escapeHtml(i.base_unit)}</td>
      </tr>
    `).join('');
  }

  // Tabel Transaksi Terakhir
  const recentBody = document.getElementById('dash-recent-tx-body');
  if (state.transactions.length === 0) {
    recentBody.innerHTML = '<tr><td colspan="3" class="p-4 text-center text-swiss-muted font-mono">Belum ada transaksi.</td></tr>';
  } else {
    recentBody.innerHTML = state.transactions.slice(0, 8).map(t => `
      <tr class="hover:bg-neutral-50 cursor-pointer" onclick="openTxDetail('${t.id}')">
        <td class="p-3"><div class="font-mono font-semibold">${escapeHtml(t.reference_no)}</div><div class="text-[10px] text-swiss-muted font-mono">${t.transaction_date}</div></td>
        <td class="p-3">${renderTypeBadge(t.type)}</td>
        <td class="p-3">${escapeHtml(t.partners?.name || '-')}</td>
      </tr>
    `).join('');
  }
}

function renderTypeBadge(type) {
  if (type === 'IN') return '<span class="px-2 py-0.5 bg-swiss-ink text-white font-mono text-[10px] uppercase">MASUK</span>';
  if (type === 'OUT') return '<span class="px-2 py-0.5 bg-swiss-red text-white font-mono text-[10px] uppercase">KELUAR</span>';
  return '<span class="px-2 py-0.5 border border-swiss-ink font-mono text-[10px] uppercase">OPNAME</span>';
}

// ==========================================
// 2. TRANSAKSI (MODE KERANJANG + FOTO NOTA)
// ==========================================
function generateRefNo(type) {
  const prefix = type === 'IN' ? 'IN' : type === 'OUT' ? 'OUT' : 'ADJ';
  const now = new Date();
  const ym = String(now.getFullYear()).slice(-2) + String(now.getMonth() + 1).padStart(2, '0');
  const rand = String(Math.floor(100 + Math.random() * 900));
  return `${prefix}-${ym}-${rand}`;
}

function onTxTypeChange() {
  const type = document.getElementById('tx-type').value;
  document.getElementById('tx-ref').value = generateRefNo(type);
  const label = document.getElementById('tx-partner-label');
  if (type === 'IN') label.textContent = 'Supplier / Toko';
  else if (type === 'OUT') label.textContent = 'Divisi / Penerima';
  else label.textContent = 'Unit / Keterangan (Opsional)';
  updatePartnerDropdown();
}

function updatePartnerDropdown() {
  const type = document.getElementById('tx-type').value;
  const select = document.getElementById('tx-partner');
  const filtered = state.partners.filter(p => {
    if (type === 'IN') return p.type === 'SUPPLIER';
    if (type === 'OUT') return p.type === 'INTERNAL' || p.type === 'CUSTOMER';
    return true;
  });

  select.innerHTML = '<option value="">-- Pilih / Opsional --</option>' +
    filtered.map(p => `<option value="${p.id}">${escapeHtml(p.name)} (${p.type})</option>`).join('');
}

function resetCart() {
  document.getElementById('cart-rows').innerHTML = '';
  document.getElementById('tx-notes').value = '';
  document.getElementById('tx-receipt-file').value = '';
  addCartRow();
  recalcGrandTotal();
}

function addCartRow() {
  const container = document.getElementById('cart-rows');
  const rowId = 'row-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const div = document.createElement('div');
  div.id = rowId;
  div.className = 'cart-row grid grid-cols-1 md:grid-cols-12 gap-2 p-3 border border-swiss-line bg-neutral-50 items-end';

  const itemOptions = '<option value="">-- Pilih Barang --</option>' +
    state.items.map(i => `<option value="${i.id}">[${escapeHtml(i.sku)}] ${escapeHtml(i.name)} (Stok: ${i.current_stock} ${escapeHtml(i.base_unit)})</option>`).join('');

  div.innerHTML = `
    <div class="md:col-span-4">
      <label class="block font-mono text-[10px] uppercase text-swiss-muted mb-1">Barang</label>
      <select class="cart-item swiss-input text-xs" onchange="onCartItemChange('${rowId}')">${itemOptions}</select>
    </div>
    <div class="md:col-span-2">
      <label class="block font-mono text-[10px] uppercase text-swiss-muted mb-1">Qty</label>
      <input type="number" step="any" value="1" class="cart-qty swiss-input text-xs font-mono" oninput="recalcRow('${rowId}')" />
    </div>
    <div class="md:col-span-2">
      <label class="block font-mono text-[10px] uppercase text-swiss-muted mb-1">Satuan</label>
      <select class="cart-unit swiss-input text-xs font-mono" onchange="recalcRow('${rowId}')">
        <option value="1|PCS">PCS</option>
      </select>
    </div>
    <div class="md:col-span-3">
      <label class="block font-mono text-[10px] uppercase text-swiss-muted mb-1">Total Harga Baris (Rp)</label>
      <input type="number" min="0" value="0" class="cart-subtotal swiss-input text-xs font-mono" oninput="recalcGrandTotal()" placeholder="0" />
    </div>
    <div class="md:col-span-1 flex items-center justify-between md:justify-end gap-2">
      <span class="cart-base-preview font-mono text-[10px] text-swiss-muted md:hidden"></span>
      <button type="button" onclick="removeCartRow('${rowId}')" class="border border-swiss-ink px-2.5 py-2 text-xs font-mono hover:bg-swiss-red hover:text-white hover:border-swiss-red">✕</button>
    </div>
  `;
  container.appendChild(div);
}

function removeCartRow(rowId) {
  const rows = document.querySelectorAll('.cart-row');
  if (rows.length <= 1) return;
  document.getElementById(rowId)?.remove();
  recalcGrandTotal();
}

function onCartItemChange(rowId) {
  const row = document.getElementById(rowId);
  const itemId = row.querySelector('.cart-item').value;
  const unitSelect = row.querySelector('.cart-unit');
  const item = state.items.find(i => i.id === itemId);

  if (!item) {
    unitSelect.innerHTML = '<option value="1|PCS">PCS</option>';
    return;
  }

  let opts = `<option value="1|${escapeHtml(item.base_unit)}">${escapeHtml(item.base_unit)} (x1)</option>`;
  (item.item_units || []).forEach(u => {
    opts += `<option value="${u.conversion_factor}|${escapeHtml(u.unit_name)}">${escapeHtml(u.unit_name)} (x${u.conversion_factor})</option>`;
  });
  unitSelect.innerHTML = opts;
  recalcRow(rowId);
}

function recalcRow(rowId) {
  const row = document.getElementById(rowId);
  const qty = Number(row.querySelector('.cart-qty').value) || 0;
  const [factor, unitName] = row.querySelector('.cart-unit').value.split('|');
  const baseQty = qty * (Number(factor) || 1);
  const preview = row.querySelector('.cart-base-preview');
  if (preview) preview.textContent = `= ${baseQty} base`;
}

function recalcGrandTotal() {
  let total = 0;
  document.querySelectorAll('.cart-subtotal').forEach(el => {
    total += Number(el.value) || 0;
  });
  document.getElementById('tx-grand-total').textContent = formatRupiah(total);
}

// Kompres gambar di browser sebelum dikirim ke Apps Script
function compressImageToBase64(file, maxWidth = 1280, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxWidth) {
          h = Math.round((h * maxWidth) / w);
          w = maxWidth;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(dataUrl.split(',')[1]);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadReceiptToDrive(file, dateStr, refNo) {
  const url = (state.settings.gdrive_script_url || '').trim();
  const secretKey = (state.settings.gdrive_secret_key || '').trim();
  if (!url || !secretKey) {
    throw new Error('URL Apps Script atau Secret Key belum diisi di menu 06 / Pengaturan.');
  }

  const base64 = await compressImageToBase64(file);
  const fileName = `${dateStr}_${refNo.replace(/[^a-zA-Z0-9-_]/g, '')}.jpg`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      secretKey,
      date: dateStr,
      fileName,
      mimeType: 'image/jpeg',
      base64
    })
  });

  const result = await response.json();
  if (result.status !== 'ok') {
    throw new Error(result.message || 'Gagal upload ke Google Drive.');
  }
  return result.url;
}

async function saveTransaction() {
  const btn = document.getElementById('btn-save-tx');
  const type = document.getElementById('tx-type').value;
  const txDate = document.getElementById('tx-date').value;
  const refNo = document.getElementById('tx-ref').value.trim();
  const partnerId = document.getElementById('tx-partner').value || null;
  const notes = document.getElementById('tx-notes').value.trim();
  const receiptFile = document.getElementById('tx-receipt-file').files[0];

  if (!txDate || !refNo) {
    return showToast('Tanggal dan No. Bukti wajib diisi.', 'error');
  }

  // Validasi isi keranjang
  const rows = Array.from(document.querySelectorAll('.cart-row'));
  const itemsPayload = [];
  for (const r of rows) {
    const itemId = r.querySelector('.cart-item').value;
    const inputQty = Number(r.querySelector('.cart-qty').value);
    const [factorStr, inputUnit] = r.querySelector('.cart-unit').value.split('|');
    const factor = Number(factorStr) || 1;
    const subtotal = Number(r.querySelector('.cart-subtotal').value) || 0;

    if (!itemId) continue;
    if (!inputQty || (type !== 'ADJUSTMENT' && inputQty <= 0)) {
      return showToast('Qty harus lebih dari 0 (kecuali Stock Opname boleh negatif).', 'error');
    }

    const baseQty = inputQty * factor;
    const unitPrice = baseQty !== 0 ? subtotal / Math.abs(baseQty) : 0;

    itemsPayload.push({
      transaction_type: type,
      item_id: itemId,
      input_qty: inputQty,
      input_unit: inputUnit,
      conversion_factor: factor,
      base_qty: baseQty,
      unit_price: unitPrice,
      subtotal
    });
  }

  if (itemsPayload.length === 0) {
    return showToast('Pilih minimal 1 barang di daftar keranjang.', 'error');
  }

  btn.disabled = true;
  btn.textContent = receiptFile ? 'Mengupload foto nota...' : 'Menyimpan transaksi...';

  try {
    let receiptUrl = null;
    if (receiptFile) {
      receiptUrl = await uploadReceiptToDrive(receiptFile, txDate, refNo);
    }

    // 1. Simpan Header Transaksi
    const { data: txData, error: txErr } = await db
      .from('transactions')
      .insert([{
        reference_no: refNo,
        transaction_date: txDate,
        type,
        partner_id: partnerId,
        receipt_url: receiptUrl,
        notes,
        created_by: state.user.id
      }])
      .select()
      .single();

    if (txErr) throw txErr;

    // 2. Simpan Rincian Barang (Database Trigger otomatis mengubah stok)
    const detailRows = itemsPayload.map(p => ({ ...p, transaction_id: txData.id }));
    const { error: detErr } = await db.from('transaction_items').insert(detailRows);
    if (detErr) throw detErr;

    showToast(`Transaksi ${refNo} berhasil disimpan!`);
    await loadAllData();
    onTxTypeChange();
    resetCart();
  } catch (err) {
    showToast('Gagal menyimpan: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan Transaksi';
  }
}

function renderTransactionsTable() {
  const typeFilter = document.getElementById('filter-tx-type').value;
  const monthFilter = document.getElementById('filter-tx-month').value;

  const filtered = state.transactions.filter(t => {
    const matchType = typeFilter === 'ALL' || t.type === typeFilter;
    const matchMonth = !monthFilter || (t.transaction_date || '').startsWith(monthFilter);
    return matchType && matchMonth;
  });

  const tbody = document.getElementById('tx-history-body');
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="p-6 text-center text-swiss-muted font-mono">Tidak ada transaksi pada periode ini.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(t => `
    <tr class="hover:bg-neutral-50">
      <td class="p-3 font-mono">${t.transaction_date}</td>
      <td class="p-3 font-mono font-semibold">${escapeHtml(t.reference_no)}</td>
      <td class="p-3">${renderTypeBadge(t.type)}</td>
      <td class="p-3">${escapeHtml(t.partners?.name || '-')}</td>
      <td class="p-3">
        ${t.receipt_url ? `<a href="${escapeHtml(t.receipt_url)}" target="_blank" class="font-mono text-[11px] underline text-swiss-red">Lihat Nota ↗</a>` : '<span class="text-swiss-muted">-</span>'}
      </td>
      <td class="p-3 text-right space-x-2">
        <button onclick="openTxDetail('${t.id}')" class="font-mono text-[11px] underline">Detail / Cetak</button>
        <button onclick="deleteTransaction('${t.id}', '${escapeHtml(t.reference_no)}')" class="font-mono text-[11px] text-swiss-red underline">Hapus</button>
      </td>
    </tr>
  `).join('');
}

async function openTxDetail(txId) {
  const tx = state.transactions.find(t => t.id === txId);
  if (!tx) return;

  const { data: details, error } = await db
    .from('transaction_items')
    .select('*, items(sku, name, base_unit)')
    .eq('transaction_id', txId);

  if (error) return showToast(error.message, 'error');

  document.getElementById('detail-tx-ref').textContent = `${tx.reference_no} — ${tx.transaction_date}`;
  const grandTotal = (details || []).reduce((s, d) => s + Number(d.subtotal || 0), 0);

  document.getElementById('detail-tx-content').innerHTML = `
    <div class="grid grid-cols-2 gap-2 border-b border-swiss-line pb-3">
      <div><span class="text-swiss-muted font-mono">JENIS:</span> ${renderTypeBadge(tx.type)}</div>
      <div><span class="text-swiss-muted font-mono">PARTNER:</span> <strong>${escapeHtml(tx.partners?.name || '-')}</strong></div>
      <div class="col-span-2"><span class="text-swiss-muted font-mono">CATATAN:</span> ${escapeHtml(tx.notes || '-')}</div>
      ${tx.receipt_url ? `<div class="col-span-2 no-print"><a href="${escapeHtml(tx.receipt_url)}" target="_blank" class="text-swiss-red font-mono underline">Buka Foto Nota di Google Drive ↗</a></div>` : ''}
    </div>
    <table class="w-full text-left border border-swiss-line">
      <thead class="bg-neutral-50 border-b border-swiss-line font-mono text-[10px] uppercase">
        <tr>
          <th class="p-2">Barang</th>
          <th class="p-2">Input</th>
          <th class="p-2">Aktual</th>
          <th class="p-2 text-right">Subtotal</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-swiss-line">
        ${(details || []).map(d => `
          <tr>
            <td class="p-2"><strong>${escapeHtml(d.items?.name)}</strong><div class="font-mono text-[10px] text-swiss-muted">${escapeHtml(d.items?.sku)}</div></td>
            <td class="p-2 font-mono">${d.input_qty} ${escapeHtml(d.input_unit)}</td>
            <td class="p-2 font-mono">${d.base_qty} ${escapeHtml(d.items?.base_unit)}</td>
            <td class="p-2 font-mono text-right">${formatRupiah(d.subtotal)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div class="text-right font-mono font-bold text-sm">TOTAL: ${formatRupiah(grandTotal)}</div>
  `;

  document.getElementById('modal-tx-detail').classList.remove('hidden');
}

function closeTxDetailModal() {
  document.getElementById('modal-tx-detail').classList.add('hidden');
}

async function deleteTransaction(txId, refNo) {
  if (!confirm(`Hapus transaksi ${refNo}? Stok barang akan otomatis dikembalikan seperti semula.`)) return;
  const { error } = await db.from('transactions').delete().eq('id', txId);
  if (error) return showToast('Gagal menghapus: ' + error.message, 'error');
  showToast(`Transaksi ${refNo} dihapus & stok dikembalikan.`);
  await loadAllData();
}

// ==========================================
// 3. MASTER BARANG & KONVERSI SATUAN
// ==========================================
function renderItemsTable() {
  const q = (document.getElementById('search-item').value || '').toLowerCase();
  const catId = document.getElementById('filter-item-cat').value;

  const filtered = state.items.filter(i => {
    const matchText = i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q);
    const matchCat = !catId || i.category_id === catId;
    return matchText && matchCat;
  });

  const tbody = document.getElementById('items-table-body');
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="p-6 text-center text-swiss-muted font-mono">Belum ada data barang.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(i => {
    const isLow = Number(i.current_stock) <= Number(i.min_stock);
    const unitsText = (i.item_units || []).map(u => `1 ${escapeHtml(u.unit_name)} = ${u.conversion_factor} ${escapeHtml(i.base_unit)}`).join(', ') || '-';
    return `
      <tr class="hover:bg-neutral-50">
        <td class="p-3 font-mono font-semibold">${escapeHtml(i.sku)}</td>
        <td class="p-3"><div class="font-semibold">${escapeHtml(i.name)}</div><div class="text-[10px] text-swiss-muted font-mono">${escapeHtml(i.location || '')}</div></td>
        <td class="p-3">${escapeHtml(i.categories?.name || '-')}</td>
        <td class="p-3 font-mono font-bold ${isLow ? 'text-swiss-red' : ''}">${formatStockBreakdown(i)}</td>
        <td class="p-3 font-mono text-[11px] text-swiss-muted">${unitsText}</td>
        <td class="p-3 text-right space-x-2">
          <button onclick="openItemModal('${i.id}')" class="font-mono text-[11px] underline">Edit</button>
          <button onclick="deleteItem('${i.id}', '${escapeHtml(i.name)}')" class="font-mono text-[11px] text-swiss-red underline">Hapus</button>
        </td>
      </tr>
    `;
  }).join('');
}

function openItemModal(itemId = null) {
  document.getElementById('form-item').reset();
  document.getElementById('item-id').value = '';
  document.getElementById('item-units-container').innerHTML = '';

  if (itemId) {
    const item = state.items.find(i => i.id === itemId);
    if (!item) return;
    document.getElementById('modal-item-title').textContent = 'Edit Barang';
    document.getElementById('item-id').value = item.id;
    document.getElementById('item-sku').value = item.sku;
    document.getElementById('item-category').value = item.category_id || '';
    document.getElementById('item-name').value = item.name;
    document.getElementById('item-base-unit').value = item.base_unit;
    document.getElementById('item-min-stock').value = item.min_stock;
    document.getElementById('item-location').value = item.location || '';
    (item.item_units || []).forEach(u => addUnitRow(u.unit_name, u.conversion_factor));
  } else {
    document.getElementById('modal-item-title').textContent = 'Tambah Barang Baru';
  }

  document.getElementById('modal-item').classList.remove('hidden');
}

function closeItemModal() {
  document.getElementById('modal-item').classList.add('hidden');
}

function addUnitRow(unitName = '', factor = '') {
  const container = document.getElementById('item-units-container');
  const div = document.createElement('div');
  div.className = 'unit-row flex gap-2 items-center';
  div.innerHTML = `
    <input type="text" placeholder="Nama (BOX/PAK)" value="${escapeHtml(unitName)}" class="unit-name swiss-input text-xs font-mono uppercase flex-1" required />
    <span class="font-mono text-xs">=</span>
    <input type="number" min="2" step="any" placeholder="Isi (5/12)" value="${factor}" class="unit-factor swiss-input text-xs font-mono w-24" required />
    <button type="button" onclick="this.parentElement.remove()" class="border border-swiss-ink px-2 py-1.5 text-xs font-mono">✕</button>
  `;
  container.appendChild(div);
}

document.getElementById('form-item').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('item-id').value;
  const payload = {
    sku: document.getElementById('item-sku').value.trim().toUpperCase(),
    category_id: document.getElementById('item-category').value || null,
    name: document.getElementById('item-name').value.trim(),
    base_unit: document.getElementById('item-base-unit').value.trim().toUpperCase(),
    min_stock: Number(document.getElementById('item-min-stock').value) || 0,
    location: document.getElementById('item-location').value.trim()
  };

  try {
    let savedId = id;
    if (id) {
      const { error } = await db.from('items').update(payload).eq('id', id);
      if (error) throw error;
      await db.from('item_units').delete().eq('item_id', id);
    } else {
      const { data, error } = await db.from('items').insert([payload]).select().single();
      if (error) throw error;
      savedId = data.id;
    }

    // Simpan konversi satuan
    const unitRows = Array.from(document.querySelectorAll('.unit-row'));
    const unitsPayload = unitRows.map(r => ({
      item_id: savedId,
      unit_name: r.querySelector('.unit-name').value.trim().toUpperCase(),
      conversion_factor: Number(r.querySelector('.unit-factor').value)
    })).filter(u => u.unit_name && u.conversion_factor > 0);

    if (unitsPayload.length > 0) {
      const { error: uErr } = await db.from('item_units').insert(unitsPayload);
      if (uErr) throw uErr;
    }

    closeItemModal();
    showToast('Data barang berhasil disimpan.');
    await loadAllData();
  } catch (err) {
    showToast('Gagal menyimpan barang: ' + err.message, 'error');
  }
});

async function deleteItem(id, name) {
  if (!confirm(`Hapus barang "${name}"? Barang yang sudah punya riwayat transaksi tidak bisa dihapus.`)) return;
  const { error } = await db.from('items').delete().eq('id', id);
  if (error) return showToast('Tidak bisa dihapus (kemungkinan sudah dipakai di transaksi).', 'error');
  showToast('Barang dihapus.');
  await loadAllData();
}

// ==========================================
// 4. KARTU STOK, ARSIP NOTA & EXPORT CSV
// ==========================================
async function loadStockCard() {
  const itemId = document.getElementById('report-item-select').value;
  const tbody = document.getElementById('stock-card-body');
  if (!itemId) {
    tbody.innerHTML = '<tr><td colspan="7" class="p-6 text-center text-swiss-muted font-mono">Pilih barang di atas untuk melihat kartu stok.</td></tr>';
    return;
  }

  const { data, error } = await db
    .from('transaction_items')
    .select('*, transactions(reference_no, transaction_date, type, partners(name))')
    .eq('item_id', itemId)
    .order('created_at', { ascending: false });

  if (error) return showToast(error.message, 'error');
  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="p-6 text-center text-swiss-muted font-mono">Belum ada mutasi untuk barang ini.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(d => {
    const sign = d.transaction_type === 'OUT' ? '-' : (d.base_qty >= 0 ? '+' : '');
    return `
      <tr>
        <td class="p-3 font-mono">${d.transactions?.transaction_date || '-'}</td>
        <td class="p-3 font-mono font-semibold">${escapeHtml(d.transactions?.reference_no || '-')}</td>
        <td class="p-3">${renderTypeBadge(d.transaction_type)}</td>
        <td class="p-3">${escapeHtml(d.transactions?.partners?.name || '-')}</td>
        <td class="p-3 font-mono">${d.input_qty} ${escapeHtml(d.input_unit)}</td>
        <td class="p-3 font-mono font-bold">${sign}${d.base_qty}</td>
        <td class="p-3 font-mono text-right">${formatRupiah(d.subtotal)}</td>
      </tr>
    `;
  }).join('');
}

function renderReceiptGallery() {
  const gallery = document.getElementById('receipt-gallery');
  const withReceipts = state.transactions.filter(t => t.receipt_url);
  if (withReceipts.length === 0) {
    gallery.innerHTML = '<p class="text-xs font-mono text-swiss-muted col-span-full">Belum ada foto nota yang diunggah.</p>';
    return;
  }

  gallery.innerHTML = withReceipts.map(t => `
    <div class="border border-swiss-ink p-4 bg-neutral-50 flex flex-col justify-between gap-3">
      <div>
        <div class="flex items-center justify-between mb-1">
          <span class="font-mono text-xs font-bold">${escapeHtml(t.reference_no)}</span>
          ${renderTypeBadge(t.type)}
        </div>
        <p class="font-mono text-[11px] text-swiss-muted">${t.transaction_date}</p>
        <p class="text-xs font-semibold mt-1">${escapeHtml(t.partners?.name || 'Tanpa Partner')}</p>
      </div>
      <a href="${escapeHtml(t.receipt_url)}" target="_blank" class="block text-center bg-swiss-ink text-white py-2 text-xs font-mono uppercase hover:bg-swiss-red transition-colors">
        Buka Foto Nota ↗
      </a>
    </div>
  `).join('');
}

function downloadCSV(filename, rows) {
  const csvContent = '\uFEFF' + rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}

function exportStockSummaryCSV() {
  const header = ['SKU', 'Nama Barang', 'Kategori', 'Stok (Base)', 'Satuan Terkecil', 'Stok Pecahan', 'Stok Min', 'Lokasi'];
  const rows = state.items.map(i => [
    i.sku, i.name, i.categories?.name || '', i.current_stock, i.base_unit, formatStockPlain(i), i.min_stock, i.location || ''
  ]);
  downloadCSV(`Rekap_Stok_${new Date().toISOString().split('T')[0]}.csv`, [header, ...rows]);
}

async function exportTransactionsCSV() {
  const { data, error } = await db
    .from('transaction_items')
    .select('*, items(sku, name, base_unit), transactions(reference_no, transaction_date, type, notes, receipt_url, partners(name))')
    .order('created_at', { ascending: false });

  if (error) return showToast(error.message, 'error');
  const header = ['Tanggal', 'No Bukti', 'Jenis', 'Partner', 'SKU', 'Nama Barang', 'Qty Input', 'Satuan Input', 'Qty Aktual', 'Satuan Base', 'Subtotal', 'Catatan', 'Link Nota'];
  const rows = (data || []).map(d => [
    d.transactions?.transaction_date, d.transactions?.reference_no, d.transaction_type,
    d.transactions?.partners?.name || '', d.items?.sku, d.items?.name,
    d.input_qty, d.input_unit, d.base_qty, d.items?.base_unit, d.subtotal,
    d.transactions?.notes || '', d.transactions?.receipt_url || ''
  ]);
  downloadCSV(`Jurnal_Transaksi_${new Date().toISOString().split('T')[0]}.csv`, [header, ...rows]);
}

// ==========================================
// 5. KATEGORI & PARTNER
// ==========================================
function renderMasterData() {
  document.getElementById('categories-list').innerHTML = state.categories.length === 0
    ? '<li class="py-3 text-swiss-muted font-mono">Belum ada kategori.</li>'
    : state.categories.map(c => `
      <li class="py-2.5 flex items-center justify-between">
        <span><strong class="font-mono">${escapeHtml(c.code_prefix || '-')}</strong> — ${escapeHtml(c.name)}</span>
        <button onclick="deleteCategory('${c.id}')" class="font-mono text-[11px] text-swiss-red underline">Hapus</button>
      </li>
    `).join('');

  document.getElementById('partners-list').innerHTML = state.partners.length === 0
    ? '<li class="py-3 text-swiss-muted font-mono">Belum ada partner.</li>'
    : state.partners.map(p => `
      <li class="py-2.5 flex items-center justify-between">
        <div>
          <span class="px-1.5 py-0.5 border border-swiss-ink font-mono text-[10px] mr-1">${p.type}</span>
          <strong>${escapeHtml(p.name)}</strong>
          ${p.phone ? `<span class="text-swiss-muted font-mono text-[11px] ml-1">(${escapeHtml(p.phone)})</span>` : ''}
        </div>
        <button onclick="deletePartner('${p.id}')" class="font-mono text-[11px] text-swiss-red underline">Hapus</button>
      </li>
    `).join('');
}

document.getElementById('form-category').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code_prefix = document.getElementById('cat-prefix').value.trim().toUpperCase();
  const name = document.getElementById('cat-name').value.trim();
  const { error } = await db.from('categories').insert([{ code_prefix, name }]);
  if (error) return showToast(error.message, 'error');
  e.target.reset();
  showToast('Kategori ditambahkan.');
  await loadAllData();
});

async function deleteCategory(id) {
  if (!confirm('Hapus kategori ini?')) return;
  const { error } = await db.from('categories').delete().eq('id', id);
  if (error) return showToast(error.message, 'error');
  await loadAllData();
}

document.getElementById('form-partner').addEventListener('submit', async (e) => {
  e.preventDefault();
  const type = document.getElementById('partner-type').value;
  const name = document.getElementById('partner-name').value.trim();
  const phone = document.getElementById('partner-phone').value.trim();
  const { error } = await db.from('partners').insert([{ type, name, phone }]);
  if (error) return showToast(error.message, 'error');
  e.target.reset();
  showToast('Partner ditambahkan.');
  await loadAllData();
});

async function deletePartner(id) {
  if (!confirm('Hapus partner ini?')) return;
  const { error } = await db.from('partners').delete().eq('id', id);
  if (error) return showToast(error.message, 'error');
  await loadAllData();
}

// ==========================================
// 6. PENGATURAN WHITE-LABEL
// ==========================================
document.getElementById('form-settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    company_name: document.getElementById('set-company').value.trim(),
    subtitle: document.getElementById('set-subtitle').value.trim(),
    address: document.getElementById('set-address').value.trim(),
    gdrive_script_url: document.getElementById('set-gdrive-url').value.trim(),
    gdrive_secret_key: document.getElementById('set-gdrive-key').value.trim(),
    updated_at: new Date().toISOString()
  };
  const { error } = await db.from('app_settings').update(payload).eq('id', 1);
  if (error) return showToast('Gagal menyimpan pengaturan: ' + error.message, 'error');
  showToast('Pengaturan white-label & Google Drive disimpan.');
  await loadAllData();
});

// Mulai aplikasi
checkSession();
