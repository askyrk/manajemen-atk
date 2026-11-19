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
  transactions: [],
  partnerPrices: []
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

// Urutan Prioritas Auto-Fill Harga Jual:
// 1. Harga Khusus Customer untuk satuan yang dipilih (misal: BOX / PAK / PCS)
// 2. Harga Jual Satuan Besar di Master Barang (jika satuan besar & diisi)
// 3. Harga Khusus Customer untuk satuan terkecil (base_unit) x Isi
// 4. Harga Jual Standar satuan terkecil x Isi
function calculateAutoSellSubtotal(itemId, partnerId, inputQty, inputUnit, factor) {
  const item = state.items.find(i => i.id === itemId);
  if (!item || !inputQty) return 0;

  const qty = Number(inputQty) || 0;
  const f = Number(factor) || 1;
  const unitUpper = String(inputUnit || item.base_unit).toUpperCase();
  const baseUpper = String(item.base_unit || 'PCS').toUpperCase();

  // 1. Cek Harga Khusus Customer sesuai satuan yang dipilih
  if (partnerId) {
    const exactCustom = state.partnerPrices.find(
      pp => pp.partner_id === partnerId && pp.item_id === itemId && String(pp.unit_name || '').toUpperCase() === unitUpper
    );
    if (exactCustom && Number(exactCustom.custom_price) > 0) {
      return qty * Number(exactCustom.custom_price);
    }
  }

  // 2. Jika satuan besar & punya harga jual khusus grosir/pak di Master Barang
  if (unitUpper !== baseUpper) {
    const unitDef = (item.item_units || []).find(u => String(u.unit_name || '').toUpperCase() === unitUpper);
    if (unitDef && Number(unitDef.sell_price) > 0) {
      return qty * Number(unitDef.sell_price);
    }
  }

  // 3. Cek Harga Khusus Customer pada satuan terkecil (base_unit) x faktor konversi
  if (partnerId) {
    const baseCustom = state.partnerPrices.find(
      pp => pp.partner_id === partnerId && pp.item_id === itemId && String(pp.unit_name || '').toUpperCase() === baseUpper
    );
    if (baseCustom && Number(baseCustom.custom_price) > 0) {
      return (qty * f) * Number(baseCustom.custom_price);
    }
  }

  // 4. Fallback ke Harga Jual Standar satuan terkecil x faktor konversi
  const stdPrice = Number(item.default_sell_price) || 0;
  return stdPrice > 0 ? (qty * f * stdPrice) : 0;
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
    const [setRes, catRes, partRes, itemRes, txRes, ppRes] = await Promise.all([
      db.from('app_settings').select('*').eq('id', 1).single(),
      db.from('categories').select('*').order('name'),
      db.from('partners').select('*').order('name'),
      db.from('items').select('*, categories(name), item_units(*)').order('name'),
      db.from('transactions').select('*, partners(name, type)').order('transaction_date', { ascending: false }).order('created_at', { ascending: false }).limit(200),
      db.from('partner_prices').select('*, partners(name, type), items(sku, name, base_unit, avg_cost, default_sell_price, item_units(*))').order('updated_at', { ascending: false })
    ]);

    if (setRes.data) state.settings = setRes.data;
    state.categories = catRes.data || [];
    state.partners = partRes.data || [];
    state.items = itemRes.data || [];
    state.transactions = txRes.data || [];
    state.partnerPrices = ppRes.data || [];

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

  document.getElementById('set-company').value = s.company_name || '';
  document.getElementById('set-subtitle').value = s.subtitle || '';
  document.getElementById('set-address').value = s.address || '';
  document.getElementById('set-gdrive-url').value = s.gdrive_script_url || '';
  document.getElementById('set-gdrive-key').value = s.gdrive_secret_key || '';
}

function populateDropdowns() {
  const filterCat = document.getElementById('filter-item-cat');
  const prevCat = filterCat.value;
  filterCat.innerHTML = '<option value="">Semua Kategori</option>' +
    state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  filterCat.value = prevCat;

  document.getElementById('item-category').innerHTML = '<option value="">-- Tanpa Kategori --</option>' +
    state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');

  const repItem = document.getElementById('report-item-select');
  const prevRep = repItem.value;
  repItem.innerHTML = '<option value="">-- Pilih Barang --</option>' +
    state.items.map(i => `<option value="${i.id}">[${escapeHtml(i.sku)}] ${escapeHtml(i.name)}</option>`).join('');
  if (prevRep) repItem.value = prevRep;

  updatePartnerDropdown();
  populatePricingDropdowns();
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
// 2. TRANSAKSI (MODE KERANJANG + AUTO-FILL HARGA + FOTO NOTA)
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
  else if (type === 'OUT') label.textContent = 'Divisi / Customer';
  else label.textContent = 'Unit / Keterangan (Opsional)';
  updatePartnerDropdown();
  refreshCartAutoPrices();
}

function updatePartnerDropdown() {
  const type = document.getElementById('tx-type').value;
  const select = document.getElementById('tx-partner');
  const prevVal = select.value;
  const filtered = state.partners.filter(p => {
    if (type === 'IN') return p.type === 'SUPPLIER';
    if (type === 'OUT') return p.type === 'INTERNAL' || p.type === 'CUSTOMER';
    return true;
  });

  select.innerHTML = '<option value="">-- Pilih / Opsional --</option>' +
    filtered.map(p => `<option value="${p.id}">${escapeHtml(p.name)} (${p.type})</option>`).join('');
  if (filtered.some(p => p.id === prevVal)) select.value = prevVal;
}

document.getElementById('tx-partner').addEventListener('change', () => {
  refreshCartAutoPrices();
});

function refreshCartAutoPrices() {
  document.querySelectorAll('.cart-row').forEach(row => {
    autoFillRowPrice(row.id);
  });
}

function autoFillRowPrice(rowId) {
  const type = document.getElementById('tx-type').value;
  if (type !== 'OUT') return;

  const row = document.getElementById(rowId);
  if (!row) return;
  const itemId = row.querySelector('.cart-item').value;
  if (!itemId) return;

  const partnerId = document.getElementById('tx-partner').value || null;
  const qty = Number(row.querySelector('.cart-qty').value) || 0;
  const [factor, inputUnit] = row.querySelector('.cart-unit').value.split('|');

  const autoSub = calculateAutoSellSubtotal(itemId, partnerId, qty, inputUnit, factor);
  if (autoSub > 0) {
    row.querySelector('.cart-subtotal').value = Math.round(autoSub);
    recalcGrandTotal();
  }
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
    const priceTag = Number(u.sell_price) > 0 ? ` — ${formatRupiah(u.sell_price)}` : '';
    opts += `<option value="${u.conversion_factor}|${escapeHtml(u.unit_name)}">${escapeHtml(u.unit_name)} (x${u.conversion_factor}${priceTag})</option>`;
  });
  unitSelect.innerHTML = opts;
  recalcRow(rowId);
}

function recalcRow(rowId) {
  const row = document.getElementById(rowId);
  const qty = Number(row.querySelector('.cart-qty').value) || 0;
  const [factor] = row.querySelector('.cart-unit').value.split('|');
  const baseQty = qty * (Number(factor) || 1);
  const preview = row.querySelector('.cart-base-preview');
  if (preview) preview.textContent = `= ${baseQty} base`;
  autoFillRowPrice(rowId);
}

function recalcGrandTotal() {
  let total = 0;
  document.querySelectorAll('.cart-subtotal').forEach(el => {
    total += Number(el.value) || 0;
  });
  document.getElementById('tx-grand-total').textContent = formatRupiah(total);
}

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
    const itemObj = state.items.find(i => i.id === itemId);
    const lockedCost = type === 'OUT' ? (Number(itemObj?.avg_cost) || 0) : unitPrice;

    itemsPayload.push({
      transaction_type: type,
      item_id: itemId,
      input_qty: inputQty,
      input_unit: inputUnit,
      conversion_factor: factor,
      base_qty: baseQty,
      unit_price: unitPrice,
      cost_price: lockedCost,
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
// 3. MASTER BARANG, KONVERSI & KALKULATOR MARGIN
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
    tbody.innerHTML = '<tr><td colspan="7" class="p-6 text-center text-swiss-muted font-mono">Belum ada data barang.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(i => {
    const isLow = Number(i.current_stock) <= Number(i.min_stock);
    const unitsText = (i.item_units || []).map(u => {
      const pTag = Number(u.sell_price) > 0 ? ` (${formatRupiah(u.sell_price)})` : '';
      return `1 ${escapeHtml(u.unit_name)} = ${u.conversion_factor} ${escapeHtml(i.base_unit)}${pTag}`;
    }).join('<br>') || '-';
    const cost = Number(i.avg_cost) || 0;
    const sell = Number(i.default_sell_price) || 0;
    const isLoss = sell > 0 && cost > 0 && sell < cost;
    const marginPct = sell > 0 && cost > 0 ? (((sell - cost) / sell) * 100).toFixed(1) : null;

    return `
      <tr class="hover:bg-neutral-50">
        <td class="p-3 font-mono font-semibold">${escapeHtml(i.sku)}</td>
        <td class="p-3"><div class="font-semibold">${escapeHtml(i.name)}</div><div class="text-[10px] text-swiss-muted font-mono">${escapeHtml(i.location || '')}</div></td>
        <td class="p-3">${escapeHtml(i.categories?.name || '-')}</td>
        <td class="p-3 font-mono font-bold ${isLow ? 'text-swiss-red' : ''}">${formatStockBreakdown(i)}</td>
        <td class="p-3 font-mono text-[11px] text-swiss-muted">${unitsText}</td>
        <td class="p-3 font-mono text-[11px]">
          <div class="text-swiss-muted">HPP: ${formatRupiah(cost)}</div>
          <div class="font-bold ${isLoss ? 'text-swiss-red' : ''}">
            Jual: ${sell > 0 ? formatRupiah(sell) : '-'}
            ${marginPct !== null ? `<span class="text-[10px] font-normal">(${marginPct}%)</span>` : ''}
          </div>
          ${isLoss ? '<div class="text-[10px] text-swiss-red font-bold">⚠ JUAL &lt; HPP</div>' : ''}
        </td>
        <td class="p-3 text-right space-x-2">
          <button onclick="openItemModal('${i.id}')" class="font-mono text-[11px] underline">Edit</button>
          <button onclick="deleteItem('${i.id}', '${escapeHtml(i.name)}')" class="font-mono text-[11px] text-swiss-red underline">Hapus</button>
        </td>
      </tr>
    `;
  }).join('');
}

function updatePriceWarning(cost, sell) {
  const warn = document.getElementById('item-price-warning');
  if (!warn) return;
  warn.classList.toggle('hidden', !(sell > 0 && cost > 0 && sell < cost));
}

function onMarginInput() {
  const cost = Number(document.getElementById('item-avg-cost').value) || 0;
  const pctRaw = document.getElementById('item-margin-pct').value;
  if (pctRaw !== '' && cost > 0) {
    const pct = Number(pctRaw) || 0;
    const sell = Math.round(cost * (1 + pct / 100));
    document.getElementById('item-sell-price').value = sell;
    updatePriceWarning(cost, sell);
  } else {
    updatePriceWarning(cost, Number(document.getElementById('item-sell-price').value) || 0);
  }
}

function onSellPriceInput() {
  const cost = Number(document.getElementById('item-avg-cost').value) || 0;
  const sell = Number(document.getElementById('item-sell-price').value) || 0;
  if (cost > 0 && sell > 0) {
    const pct = (((sell - cost) / cost) * 100).toFixed(1);
    document.getElementById('item-margin-pct').value = pct;
  } else {
    document.getElementById('item-margin-pct').value = '';
  }
  updatePriceWarning(cost, sell);
}

function openItemModal(itemId = null) {
  document.getElementById('form-item').reset();
  document.getElementById('item-id').value = '';
  document.getElementById('item-units-container').innerHTML = '';
  document.getElementById('item-price-warning')?.classList.add('hidden');

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
    document.getElementById('item-avg-cost').value = Math.round(Number(item.avg_cost) || 0);
    document.getElementById('item-sell-price').value = Math.round(Number(item.default_sell_price) || 0);
    onSellPriceInput();
    (item.item_units || []).forEach(u => addUnitRow(u.unit_name, u.conversion_factor, u.sell_price));
  } else {
    document.getElementById('modal-item-title').textContent = 'Tambah Barang Baru';
  }

  document.getElementById('modal-item').classList.remove('hidden');
}

function closeItemModal() {
  document.getElementById('modal-item').classList.add('hidden');
}

function addUnitRow(unitName = '', factor = '', sellPrice = '') {
  const container = document.getElementById('item-units-container');
  const div = document.createElement('div');
  div.className = 'unit-row grid grid-cols-12 gap-1.5 items-center';
  const priceVal = Number(sellPrice) > 0 ? Math.round(Number(sellPrice)) : '';
  div.innerHTML = `
    <input type="text" placeholder="BOX/PAK" value="${escapeHtml(unitName)}" class="unit-name swiss-input text-xs font-mono uppercase col-span-4" required />
    <input type="number" min="2" step="any" placeholder="Isi (5/12)" value="${factor}" class="unit-factor swiss-input text-xs font-mono col-span-3" required />
    <input type="number" min="0" step="any" placeholder="Harga Jual (Ops)" value="${priceVal}" class="unit-sell-price swiss-input text-xs font-mono col-span-4" title="Kosongkan jika ikut harga eceran x isi" />
    <button type="button" onclick="this.parentElement.remove()" class="border border-swiss-ink py-2 text-xs font-mono col-span-1 text-center hover:bg-swiss-red hover:text-white">✕</button>
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
    location: document.getElementById('item-location').value.trim(),
    avg_cost: Number(document.getElementById('item-avg-cost').value) || 0,
    default_sell_price: Number(document.getElementById('item-sell-price').value) || 0
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

    const unitRows = Array.from(document.querySelectorAll('.unit-row'));
    const unitsPayload = unitRows.map(r => ({
      item_id: savedId,
      unit_name: r.querySelector('.unit-name').value.trim().toUpperCase(),
      conversion_factor: Number(r.querySelector('.unit-factor').value),
      sell_price: Number(r.querySelector('.unit-sell-price')?.value) || 0
    })).filter(u => u.unit_name && u.conversion_factor > 0);

    if (unitsPayload.length > 0) {
      const { error: uErr } = await db.from('item_units').insert(unitsPayload);
      if (uErr) throw uErr;
    }

    closeItemModal();
    showToast('Data barang & harga satuan berhasil disimpan.');
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
  const header = ['SKU', 'Nama Barang', 'Kategori', 'Stok (Base)', 'Satuan Terkecil', 'Stok Pecahan', 'Stok Min', 'HPP (Rp)', 'Harga Jual (Rp)', 'Lokasi'];
  const rows = state.items.map(i => [
    i.sku, i.name, i.categories?.name || '', i.current_stock, i.base_unit, formatStockPlain(i), i.min_stock, Math.round(i.avg_cost || 0), Math.round(i.default_sell_price || 0), i.location || ''
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

// ==========================================
// 7. IMPORT MASSAL MASTER BARANG (EXCEL / CSV)
// ==========================================
let pendingImportRows = [];

function openImportModal() {
  pendingImportRows = [];
  document.getElementById('import-file-input').value = '';
  document.getElementById('import-preview-wrapper').classList.add('hidden');
  document.getElementById('import-preview-body').innerHTML = '';
  document.getElementById('btn-run-import').disabled = true;
  document.getElementById('btn-run-import').textContent = 'Mulai Import ke Database';
  document.getElementById('modal-import-items').classList.remove('hidden');
}

function closeImportModal() {
  document.getElementById('modal-import-items').classList.add('hidden');
}

function downloadImportTemplate() {
  const sampleData = [
    {
      SKU: 'ATK-001',
      NAMA_BARANG: 'Kertas HVS A4 70gr',
      KATEGORI: 'Alat Tulis Kantor',
      SATUAN_TERKECIL: 'RIM',
      STOK_MIN: 5,
      LOKASI: 'Rak A1',
      SATUAN_BESAR: 'BOX',
      ISI_SATUAN_BESAR: 5
    },
    {
      SKU: 'KLT-001',
      NAMA_BARANG: 'Tisu Kamar Mandi Roll',
      KATEGORI: 'Kebersihan',
      SATUAN_TERKECIL: 'PCS',
      STOK_MIN: 20,
      LOKASI: 'Gudang B',
      SATUAN_BESAR: 'PACK',
      ISI_SATUAN_BESAR: 10
    }
  ];

  const ws = XLSX.utils.json_to_sheet(sampleData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Template_Master_Barang');
  XLSX.writeFile(wb, 'Template_Import_Master_ATK.xlsx');
}

function normalizeRowKeys(rawRow) {
  const normalized = {};
  Object.keys(rawRow).forEach(k => {
    const cleanKey = String(k).trim().toUpperCase().replace(/\s+/g, '_');
    normalized[cleanKey] = rawRow[k];
  });
  return normalized;
}

function handleImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });

      const skuMap = new Map();
      rawRows.forEach(raw => {
        const r = normalizeRowKeys(raw);
        const sku = String(r.SKU || '').trim().toUpperCase();
        const name = String(r.NAMA_BARANG || r.NAMA_PRODUK || r.NAMA || '').trim();
        if (!sku || !name) return;

        skuMap.set(sku, {
          sku,
          name,
          categoryName: String(r.KATEGORI || '').trim(),
          base_unit: String(r.SATUAN_TERKECIL || r.SATUAN || 'PCS').trim().toUpperCase() || 'PCS',
          min_stock: Number(r.STOK_MIN || r.MIN_STOCK || 0) || 0,
          location: String(r.LOKASI || '').trim(),
          big_unit: String(r.SATUAN_BESAR || '').trim().toUpperCase(),
          big_factor: Number(r.ISI_SATUAN_BESAR || r.ISI_PER_SATUAN || 0) || 0
        });
      });

      pendingImportRows = Array.from(skuMap.values());

      if (pendingImportRows.length === 0) {
        showToast('Tidak ada baris valid. Pastikan kolom SKU dan NAMA_BARANG terisi.', 'error');
        document.getElementById('import-preview-wrapper').classList.add('hidden');
        document.getElementById('btn-run-import').disabled = true;
        return;
      }

      document.getElementById('import-summary-text').textContent = `Siap diimport: ${pendingImportRows.length} barang unik.`;
      document.getElementById('import-preview-body').innerHTML = pendingImportRows.slice(0, 10).map(r => `
        <tr>
          <td class="p-2 font-mono font-semibold">${escapeHtml(r.sku)}</td>
          <td class="p-2">${escapeHtml(r.name)}</td>
          <td class="p-2">${escapeHtml(r.categoryName || '-')}</td>
          <td class="p-2 font-mono">${escapeHtml(r.base_unit)}</td>
          <td class="p-2 font-mono text-swiss-muted">${r.big_unit && r.big_factor > 1 ? `1 ${escapeHtml(r.big_unit)} = ${r.big_factor} ${escapeHtml(r.base_unit)}` : '-'}</td>
        </tr>
      `).join('');

      document.getElementById('import-preview-wrapper').classList.remove('hidden');
      document.getElementById('btn-run-import').disabled = false;
    } catch (err) {
      showToast('Gagal membaca file: ' + err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

async function executeBulkImport() {
  if (pendingImportRows.length === 0) return;
  const btn = document.getElementById('btn-run-import');
  btn.disabled = true;
  btn.textContent = 'Mengimport data...';

  try {
    const existingCatMap = new Map(state.categories.map(c => [c.name.toLowerCase(), c.id]));
    const newCategories = [];
    const seenNewCats = new Set();

    pendingImportRows.forEach(r => {
      if (r.categoryName) {
        const key = r.categoryName.toLowerCase();
        if (!existingCatMap.has(key) && !seenNewCats.has(key)) {
          seenNewCats.add(key);
          const prefix = r.sku.includes('-') ? r.sku.split('-')[0].substring(0, 5) : r.categoryName.substring(0, 3).toUpperCase();
          newCategories.push({ name: r.categoryName, code_prefix: prefix });
        }
      }
    });

    if (newCategories.length > 0) {
      const { data: insertedCats, error: catErr } = await db.from('categories').insert(newCategories).select();
      if (catErr) throw catErr;
      (insertedCats || []).forEach(c => existingCatMap.set(c.name.toLowerCase(), c.id));
    }

    const itemsPayload = pendingImportRows.map(r => ({
      sku: r.sku,
      name: r.name,
      category_id: r.categoryName ? (existingCatMap.get(r.categoryName.toLowerCase()) || null) : null,
      base_unit: r.base_unit,
      min_stock: r.min_stock,
      location: r.location
    }));

    const savedItemsMap = new Map();
    for (let i = 0; i < itemsPayload.length; i += 100) {
      const chunk = itemsPayload.slice(i, i + 100);
      const { data: savedChunk, error: itemErr } = await db
        .from('items')
        .upsert(chunk, { onConflict: 'sku' })
        .select('id, sku');
      if (itemErr) throw itemErr;
      (savedChunk || []).forEach(it => savedItemsMap.set(it.sku, it.id));
    }

    const unitsMap = new Map();
    pendingImportRows.forEach(r => {
      const itemId = savedItemsMap.get(r.sku);
      if (itemId && r.big_unit && r.big_factor > 1 && r.big_unit !== r.base_unit) {
        unitsMap.set(`${itemId}|${r.big_unit}`, {
          item_id: itemId,
          unit_name: r.big_unit,
          conversion_factor: r.big_factor
        });
      }
    });

    const unitsPayload = Array.from(unitsMap.values());
    for (let i = 0; i < unitsPayload.length; i += 100) {
      const chunk = unitsPayload.slice(i, i + 100);
      const { error: uErr } = await db
        .from('item_units')
        .upsert(chunk, { onConflict: 'item_id,unit_name' });
      if (uErr) throw uErr;
    }

    closeImportModal();
    showToast(`Berhasil mengimport ${pendingImportRows.length} barang!`);
    await loadAllData();
  } catch (err) {
    showToast('Gagal import: ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Mulai Import ke Database';
  }
}

// ==========================================
// 8. REKAP OTOMATIS PER DIVISI & SUPPLIER
// ==========================================
let recapState = {
  rawItems: [],
  suppliers: [],
  divisions: [],
  selectedDetail: null
};

function onRecapModeChange() {
  const mode = document.getElementById('recap-period-mode').value;
  const monthInput = document.getElementById('recap-month');
  monthInput.classList.toggle('hidden', mode === 'ALL');
  loadRecapData();
}

async function loadRecapData() {
  const monthInput = document.getElementById('recap-month');
  if (!monthInput.value) {
    monthInput.value = new Date().toISOString().substring(0, 7);
  }

  const mode = document.getElementById('recap-period-mode').value;
  const monthVal = monthInput.value;

  document.getElementById('recap-supplier-body').innerHTML = '<tr><td colspan="3" class="p-4 text-center font-mono text-swiss-muted">Memuat data...</td></tr>';
  document.getElementById('recap-division-body').innerHTML = '<tr><td colspan="3" class="p-4 text-center font-mono text-swiss-muted">Memuat data...</td></tr>';
  closeRecapDetail();

  try {
    let query = db
      .from('transaction_items')
      .select('*, items(sku, name, base_unit, avg_cost), transactions!inner(id, reference_no, transaction_date, type, partner_id, partners(id, name, type))')
      .in('transaction_type', ['IN', 'OUT']);

    if (mode === 'MONTH' && monthVal) {
      const [y, m] = monthVal.split('-');
      const lastDay = new Date(Number(y), Number(m), 0).getDate();
      query = query
        .gte('transactions.transaction_date', `${monthVal}-01`)
        .lte('transactions.transaction_date', `${monthVal}-${String(lastDay).padStart(2, '0')}`);
    }

    const { data, error } = await query;
    if (error) throw error;

    recapState.rawItems = data || [];
    processAndRenderRecap();
  } catch (err) {
    showToast('Gagal memuat rekap: ' + err.message, 'error');
  }
}

function processAndRenderRecap() {
  const supMap = new Map();
  const divMap = new Map();
  const inTxSet = new Set();
  const outTxSet = new Set();
  let totalInVal = 0;
  let totalOutVal = 0;

  recapState.rawItems.forEach(row => {
    const tx = row.transactions;
    const item = row.items;
    if (!tx || !item) return;

    const partnerKey = tx.partner_id || 'NONE';
    const partnerName = tx.partners?.name || (row.transaction_type === 'IN' ? 'Tanpa Supplier / Umum' : 'Tanpa Divisi / Umum');

    const rawSub = Number(row.subtotal) || 0;
    const estVal = rawSub > 0 ? rawSub : (Math.abs(Number(row.base_qty) || 0) * (Number(item.avg_cost) || 0));

    if (row.transaction_type === 'IN') {
      inTxSet.add(tx.id);
      totalInVal += rawSub;

      if (!supMap.has(partnerKey)) {
        supMap.set(partnerKey, { key: partnerKey, name: partnerName, txIds: new Set(), totalValue: 0, itemCount: 0, itemsMap: new Map() });
      }
      const entry = supMap.get(partnerKey);
      entry.txIds.add(tx.id);
      entry.totalValue += rawSub;
      entry.itemCount += 1;

      if (!entry.itemsMap.has(row.item_id)) {
        entry.itemsMap.set(row.item_id, { sku: item.sku, name: item.name, base_unit: item.base_unit, freq: 0, totalBaseQty: 0, totalVal: 0 });
      }
      const itEntry = entry.itemsMap.get(row.item_id);
      itEntry.freq += 1;
      itEntry.totalBaseQty += Number(row.base_qty) || 0;
      itEntry.totalVal += rawSub;
    } else if (row.transaction_type === 'OUT') {
      outTxSet.add(tx.id);
      totalOutVal += estVal;

      if (!divMap.has(partnerKey)) {
        divMap.set(partnerKey, { key: partnerKey, name: partnerName, txIds: new Set(), totalValue: 0, itemCount: 0, itemsMap: new Map() });
      }
      const entry = divMap.get(partnerKey);
      entry.txIds.add(tx.id);
      entry.totalValue += estVal;
      entry.itemCount += 1;

      if (!entry.itemsMap.has(row.item_id)) {
        entry.itemsMap.set(row.item_id, { sku: item.sku, name: item.name, base_unit: item.base_unit, freq: 0, totalBaseQty: 0, totalVal: 0 });
      }
      const itEntry = entry.itemsMap.get(row.item_id);
      itEntry.freq += 1;
      itEntry.totalBaseQty += Number(row.base_qty) || 0;
      itEntry.totalVal += estVal;
    }
  });

  recapState.suppliers = Array.from(supMap.values()).sort((a, b) => b.totalValue - a.totalValue);
  recapState.divisions = Array.from(divMap.values()).sort((a, b) => b.totalValue - a.totalValue);

  document.getElementById('recap-kpi-in-val').textContent = formatRupiah(totalInVal);
  document.getElementById('recap-kpi-in-tx').textContent = `${inTxSet.size} nota masuk`;
  document.getElementById('recap-kpi-out-val').textContent = formatRupiah(totalOutVal);
  document.getElementById('recap-kpi-out-tx').textContent = `${outTxSet.size} nota keluar`;

  const topSup = recapState.suppliers[0];
  document.getElementById('recap-kpi-top-sup').textContent = topSup ? topSup.name : '-';
  document.getElementById('recap-kpi-top-sup-val').textContent = topSup ? formatRupiah(topSup.totalValue) : 'Rp 0';

  const topDiv = recapState.divisions[0];
  document.getElementById('recap-kpi-top-div').textContent = topDiv ? topDiv.name : '-';
  document.getElementById('recap-kpi-top-div-val').textContent = topDiv ? formatRupiah(topDiv.totalValue) : 'Rp 0';

  const supBody = document.getElementById('recap-supplier-body');
  if (recapState.suppliers.length === 0) {
    supBody.innerHTML = '<tr><td colspan="3" class="p-5 text-center font-mono text-swiss-muted">Belum ada transaksi masuk di periode ini.</td></tr>';
  } else {
    supBody.innerHTML = recapState.suppliers.map(s => `
      <tr onclick="openRecapDetail('IN', '${s.key}')" class="hover:bg-neutral-100 cursor-pointer">
        <td class="p-3 font-semibold">${escapeHtml(s.name)}</td>
        <td class="p-3 text-center font-mono">${s.txIds.size}</td>
        <td class="p-3 text-right font-mono font-bold">${formatRupiah(s.totalValue)}</td>
      </tr>
    `).join('');
  }

  const divBody = document.getElementById('recap-division-body');
  if (recapState.divisions.length === 0) {
    divBody.innerHTML = '<tr><td colspan="3" class="p-5 text-center font-mono text-swiss-muted">Belum ada transaksi keluar di periode ini.</td></tr>';
  } else {
    divBody.innerHTML = recapState.divisions.map(d => `
      <tr onclick="openRecapDetail('OUT', '${d.key}')" class="hover:bg-neutral-100 cursor-pointer">
        <td class="p-3 font-semibold">${escapeHtml(d.name)}</td>
        <td class="p-3 text-center font-mono">${d.txIds.size}</td>
        <td class="p-3 text-right font-mono font-bold text-swiss-red">${formatRupiah(d.totalValue)}</td>
      </tr>
    `).join('');
  }
}

function openRecapDetail(type, partnerKey) {
  const list = type === 'IN' ? recapState.suppliers : recapState.divisions;
  const entry = list.find(x => x.key === partnerKey);
  if (!entry) return;

  const items = Array.from(entry.itemsMap.values()).sort((a, b) => b.totalVal - a.totalVal);
  recapState.selectedDetail = { type, name: entry.name, items };

  document.getElementById('recap-detail-type').textContent = type === 'IN' ? 'RINCIAN BELANJA SUPPLIER' : 'RINCIAN PEMAKAIAN DIVISI / UNIT';
  document.getElementById('recap-detail-title').textContent = `${entry.name} (${entry.txIds.size} Nota)`;
  document.getElementById('recap-detail-body').innerHTML = items.map(it => `
    <tr>
      <td class="p-2.5 font-mono font-semibold">${escapeHtml(it.sku)}</td>
      <td class="p-2.5">${escapeHtml(it.name)}</td>
      <td class="p-2.5 text-center font-mono">${it.freq}x</td>
      <td class="p-2.5 text-right font-mono font-semibold">${it.totalBaseQty} ${escapeHtml(it.base_unit)}</td>
      <td class="p-2.5 text-right font-mono font-bold">${formatRupiah(it.totalVal)}</td>
    </tr>
  `).join('');

  const panel = document.getElementById('recap-detail-panel');
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeRecapDetail() {
  recapState.selectedDetail = null;
  document.getElementById('recap-detail-panel')?.classList.add('hidden');
}

function exportRecapCSV() {
  const mode = document.getElementById('recap-period-mode').value;
  const label = mode === 'MONTH' ? document.getElementById('recap-month').value : 'Semua_Periode';
  const header = ['Kategori Rekap', 'Nama Partner / Divisi', 'Jumlah Nota', 'Total Nilai / Estimasi (Rp)'];
  const rows = [
    ...recapState.suppliers.map(s => ['SUPPLIER (MASUK)', s.name, s.txIds.size, Math.round(s.totalValue)]),
    ...recapState.divisions.map(d => ['DIVISI (KELUAR)', d.name, d.txIds.size, Math.round(d.totalValue)])
  ];
  if (rows.length === 0) return showToast('Tidak ada data rekap untuk diekspor.', 'error');
  downloadCSV(`Rekap_Divisi_Supplier_${label}.csv`, [header, ...rows]);
}

function exportRecapDetailCSV() {
  const d = recapState.selectedDetail;
  if (!d) return;
  const header = ['Jenis', 'Partner / Divisi', 'SKU', 'Nama Barang', 'Frekuensi', 'Total Qty', 'Satuan Base', 'Total Nilai (Rp)'];
  const rows = d.items.map(it => [
    d.type === 'IN' ? 'MASUK' : 'KELUAR', d.name, it.sku, it.name, it.freq, it.totalBaseQty, it.base_unit, Math.round(it.totalVal)
  ]);
  downloadCSV(`Rincian_${d.name.replace(/[^a-zA-Z0-9]/g, '_')}.csv`, [header, ...rows]);
}

// ==========================================
// 9. ANALISA PERBANDINGAN HARGA SUPPLIER
// ==========================================
let priceAnalysisList = [];

async function loadPriceAnalysis() {
  const tbody = document.getElementById('price-analysis-body');
  tbody.innerHTML = '<tr><td colspan="6" class="p-6 text-center font-mono text-swiss-muted">Menganalisa riwayat harga beli...</td></tr>';
  closePriceDetail();

  try {
    const rangeVal = document.getElementById('filter-price-range')?.value || '30';
    let query = db
      .from('transaction_items')
      .select('*, items(id, sku, name, base_unit), transactions!inner(reference_no, transaction_date, type, partner_id, partners(id, name))')
      .eq('transaction_type', 'IN')
      .gt('subtotal', 0)
      .gt('base_qty', 0);

    if (rangeVal !== 'ALL') {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - Number(rangeVal));
      const cutoffStr = cutoff.toISOString().split('T')[0];
      query = query.gte('transactions.transaction_date', cutoffStr);
    }

    const { data, error } = await query;
    if (error) throw error;

    const rows = (data || []).sort((a, b) => {
      const da = a.transactions?.transaction_date || '';
      const dbDate = b.transactions?.transaction_date || '';
      if (dbDate !== da) return dbDate.localeCompare(da);
      return (b.created_at || '').localeCompare(a.created_at || '');
    });

    const itemMap = new Map();

    rows.forEach(r => {
      const item = r.items;
      const tx = r.transactions;
      if (!item || !tx) return;

      const baseUnitPrice = Number(r.unit_price) > 0
        ? Number(r.unit_price)
        : (Number(r.subtotal) / Math.abs(Number(r.base_qty)));

      const supKey = tx.partner_id || 'UMUM';
      const supName = tx.partners?.name || 'Supplier Umum / Tanpa Nama';

      if (!itemMap.has(item.id)) {
        itemMap.set(item.id, {
          itemId: item.id,
          sku: item.sku,
          name: item.name,
          base_unit: item.base_unit,
          suppliersMap: new Map(),
          history: []
        });
      }

      const entry = itemMap.get(item.id);
      entry.history.push({
        date: tx.transaction_date,
        refNo: tx.reference_no,
        supplierName: supName,
        inputLabel: `${r.input_qty} ${r.input_unit}`,
        basePrice: baseUnitPrice,
        subtotal: Number(r.subtotal)
      });

      if (!entry.suppliersMap.has(supKey)) {
        entry.suppliersMap.set(supKey, {
          key: supKey,
          name: supName,
          latestPrice: baseUnitPrice,
          latestDate: tx.transaction_date,
          minPrice: baseUnitPrice,
          maxPrice: baseUnitPrice,
          count: 1
        });
      } else {
        const s = entry.suppliersMap.get(supKey);
        s.minPrice = Math.min(s.minPrice, baseUnitPrice);
        s.maxPrice = Math.max(s.maxPrice, baseUnitPrice);
        s.count += 1;
      }
    });

    priceAnalysisList = Array.from(itemMap.values()).map(entry => {
      const suppliers = Array.from(entry.suppliersMap.values()).sort((a, b) => a.latestPrice - b.latestPrice);
      const cheapest = suppliers[0];
      const mostExpensive = suppliers[suppliers.length - 1];
      const gapRp = suppliers.length > 1 ? (mostExpensive.latestPrice - cheapest.latestPrice) : 0;
      const gapPct = (suppliers.length > 1 && cheapest.latestPrice > 0)
        ? ((gapRp / cheapest.latestPrice) * 100)
        : 0;

      return {
        ...entry,
        suppliers,
        cheapest,
        mostExpensive,
        gapRp,
        gapPct
      };
    }).sort((a, b) => b.gapPct - a.gapPct || b.suppliers.length - a.suppliers.length);

    updatePriceKPIs();
    renderPriceAnalysisTable();
  } catch (err) {
    showToast('Gagal memuat analisa harga: ' + err.message, 'error');
  }
}

function updatePriceKPIs() {
  const comparable = priceAnalysisList.filter(x => x.suppliers.length >= 2);
  document.getElementById('price-kpi-total').textContent = priceAnalysisList.length;
  document.getElementById('price-kpi-comparable').textContent = comparable.length;

  const topGap = comparable[0];
  if (topGap && topGap.gapPct > 0) {
    document.getElementById('price-kpi-max-gap').textContent = `+${topGap.gapPct.toFixed(1)}%`;
    document.getElementById('price-kpi-max-item').textContent = `${topGap.name} (selisih ${formatRupiah(topGap.gapRp)}/${topGap.base_unit})`;
  } else {
    document.getElementById('price-kpi-max-gap').textContent = '0%';
    document.getElementById('price-kpi-max-item').textContent = 'Belum ada perbandingan ≥ 2 toko';
  }
}

function renderPriceAnalysisTable() {
  const q = (document.getElementById('search-price-item').value || '').toLowerCase();
  const onlyMulti = document.getElementById('filter-only-multi-supplier').checked;

  const filtered = priceAnalysisList.filter(x => {
    const matchText = x.name.toLowerCase().includes(q) || x.sku.toLowerCase().includes(q);
    const matchMulti = !onlyMulti || x.suppliers.length >= 2;
    return matchText && matchMulti;
  });

  const tbody = document.getElementById('price-analysis-body');
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="p-6 text-center font-mono text-swiss-muted">Belum ada data harga pembelian yang sesuai filter.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(x => `
    <tr onclick="openPriceDetail('${x.itemId}')" class="hover:bg-neutral-50 cursor-pointer">
      <td class="p-3">
        <div class="font-semibold">${escapeHtml(x.name)}</div>
        <div class="font-mono text-[10px] text-swiss-muted">${escapeHtml(x.sku)} • per ${escapeHtml(x.base_unit)}</div>
      </td>
      <td class="p-3">
        <div class="font-mono font-bold">${formatRupiah(x.cheapest.latestPrice)}</div>
        <div class="text-[11px] text-swiss-muted">${escapeHtml(x.cheapest.name)} <span class="font-mono text-[10px]">(${x.cheapest.latestDate})</span></div>
      </td>
      <td class="p-3">
        ${x.suppliers.length > 1
          ? `<div class="font-mono font-semibold text-swiss-red">${formatRupiah(x.mostExpensive.latestPrice)}</div><div class="text-[11px] text-swiss-muted">${escapeHtml(x.mostExpensive.name)} <span class="font-mono text-[10px]">(${x.mostExpensive.latestDate})</span></div>`
          : '<span class="font-mono text-[11px] text-swiss-muted">- (1 toko)</span>'}
      </td>
      <td class="p-3 text-right font-mono">
        ${x.suppliers.length > 1 && x.gapRp > 0
          ? `<div class="font-bold text-swiss-red">+${x.gapPct.toFixed(1)}%</div><div class="text-[10px] text-swiss-muted">${formatRupiah(x.gapRp)}</div>`
          : '<span class="text-swiss-muted">-</span>'}
      </td>
      <td class="p-3 text-center font-mono font-semibold">${x.suppliers.length}</td>
      <td class="p-3 text-right">
        <button type="button" class="font-mono text-[11px] underline">Bandingkan</button>
      </td>
    </tr>
  `).join('');
}

function openPriceDetail(itemId) {
  const entry = priceAnalysisList.find(x => x.itemId === itemId);
  if (!entry) return;

  document.getElementById('price-detail-title').textContent = `[${entry.sku}] ${entry.name} — Per ${entry.base_unit}`;

  document.getElementById('price-detail-suppliers').innerHTML = entry.suppliers.map((s, idx) => `
    <tr class="${idx === 0 ? 'bg-neutral-50' : ''}">
      <td class="p-2.5 font-semibold">${escapeHtml(s.name)} <span class="font-mono text-[10px] text-swiss-muted">(${s.count}x beli)</span></td>
      <td class="p-2.5 text-right font-mono font-bold">${formatRupiah(s.latestPrice)}</td>
      <td class="p-2.5 text-right font-mono">${formatRupiah(s.minPrice)}</td>
      <td class="p-2.5 text-right font-mono">${formatRupiah(s.maxPrice)}</td>
      <td class="p-2.5 text-center font-mono">${s.latestDate}</td>
      <td class="p-2.5 text-center">
        ${idx === 0
          ? '<span class="px-2 py-0.5 bg-swiss-ink text-white font-mono text-[10px] uppercase">TERMURAH</span>'
          : `<span class="font-mono text-[10px] text-swiss-red">+${(((s.latestPrice - entry.cheapest.latestPrice) / entry.cheapest.latestPrice) * 100).toFixed(1)}%</span>`}
      </td>
    </tr>
  `).join('');

  document.getElementById('price-detail-history').innerHTML = entry.history.map(h => `
    <tr>
      <td class="p-2.5 font-mono">${h.date}</td>
      <td class="p-2.5 font-mono font-semibold">${escapeHtml(h.refNo)}</td>
      <td class="p-2.5">${escapeHtml(h.supplierName)}</td>
      <td class="p-2.5 font-mono">${escapeHtml(h.inputLabel)}</td>
      <td class="p-2.5 text-right font-mono font-bold">${formatRupiah(h.basePrice)}</td>
      <td class="p-2.5 text-right font-mono">${formatRupiah(h.subtotal)}</td>
    </tr>
  `).join('');

  const panel = document.getElementById('price-detail-panel');
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closePriceDetail() {
  document.getElementById('price-detail-panel')?.classList.add('hidden');
}

function exportPriceAnalysisCSV() {
  if (priceAnalysisList.length === 0) return showToast('Belum ada data harga untuk diekspor.', 'error');
  const header = ['SKU', 'Nama Barang', 'Satuan Base', 'Jumlah Supplier', 'Supplier Termurah', 'Harga Termurah', 'Supplier Termahal', 'Harga Termahal', 'Selisih (Rp)', 'Selisih (%)'];
  const rows = priceAnalysisList.map(x => [
    x.sku, x.name, x.base_unit, x.suppliers.length,
    x.cheapest.name, Math.round(x.cheapest.latestPrice),
    x.suppliers.length > 1 ? x.mostExpensive.name : '-',
    x.suppliers.length > 1 ? Math.round(x.mostExpensive.latestPrice) : 0,
    Math.round(x.gapRp),
    x.gapPct.toFixed(1) + '%'
  ]);
  downloadCSV(`Analisa_Harga_Supplier_${new Date().toISOString().split('T')[0]}.csv`, [header, ...rows]);
}

// ==========================================
// 10. MANAJEMEN HARGA KHUSUS PER SATUAN & ANALISA LABA
// ==========================================
let profitState = {
  byItem: [],
  byPartner: []
};

function populatePricingDropdowns() {
  const outPartners = state.partners.filter(p => p.type === 'CUSTOMER' || p.type === 'INTERNAL');

  const ppPartner = document.getElementById('pp-partner');
  const filterPpPartner = document.getElementById('filter-pp-partner');
  const ppItem = document.getElementById('pp-item');
  if (!ppPartner || !filterPpPartner || !ppItem) return;

  const prevFilter = filterPpPartner.value;

  ppPartner.innerHTML = '<option value="">-- Pilih Customer / Divisi --</option>' +
    outPartners.map(p => `<option value="${p.id}">${escapeHtml(p.name)} (${p.type})</option>`).join('');

  filterPpPartner.innerHTML = '<option value="">Semua Customer / Partner</option>' +
    outPartners.map(p => `<option value="${p.id}">${escapeHtml(p.name)} (${p.type})</option>`).join('');
  filterPpPartner.value = prevFilter;

  ppItem.innerHTML = '<option value="">-- Pilih Barang --</option>' +
    state.items.map(i => `<option value="${i.id}">[${escapeHtml(i.sku)}] ${escapeHtml(i.name)} (${escapeHtml(i.base_unit)})</option>`).join('');
}

function loadPricingAndProfit() {
  populatePricingDropdowns();
  renderPartnerPricesTable();
  loadProfitAnalysis();
}

function onPartnerPriceItemChange() {
  const itemId = document.getElementById('pp-item').value;
  const unitSelect = document.getElementById('pp-unit');
  const infoEl = document.getElementById('pp-info-base');
  const item = state.items.find(i => i.id === itemId);

  if (!item) {
    if (unitSelect) unitSelect.innerHTML = '<option value="">-- Pilih --</option>';
    infoEl.classList.add('hidden');
    return;
  }

  if (unitSelect) {
    let opts = `<option value="${escapeHtml(item.base_unit)}">${escapeHtml(item.base_unit)} (x1)</option>`;
    (item.item_units || []).forEach(u => {
      opts += `<option value="${escapeHtml(u.unit_name)}">${escapeHtml(u.unit_name)} (x${u.conversion_factor})</option>`;
    });
    unitSelect.innerHTML = opts;
  }

  const bigUnitInfo = (item.item_units || []).map(u => {
    const p = Number(u.sell_price) > 0 ? formatRupiah(u.sell_price) : formatRupiah((Number(item.default_sell_price) || 0) * u.conversion_factor);
    return `1 ${u.unit_name} (${u.conversion_factor} ${item.base_unit}): ${p}`;
  }).join(' | ');

  infoEl.textContent = `HPP: ${formatRupiah(item.avg_cost)}/${item.base_unit} | Standar: ${formatRupiah(item.default_sell_price)}/${item.base_unit}${bigUnitInfo ? ' | ' + bigUnitInfo : ''}`;
  infoEl.classList.remove('hidden');
}

document.getElementById('form-partner-price')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const partner_id = document.getElementById('pp-partner').value;
  const item_id = document.getElementById('pp-item').value;
  const unit_name = document.getElementById('pp-unit')?.value;
  const custom_price = Number(document.getElementById('pp-custom-price').value);
  const notes = document.getElementById('pp-notes').value.trim();

  if (!partner_id || !item_id || !unit_name || isNaN(custom_price) || custom_price < 0) {
    return showToast('Lengkapi Customer, Barang, Satuan, dan Harga Khusus.', 'error');
  }

  const { error } = await db
    .from('partner_prices')
    .upsert([{ partner_id, item_id, unit_name, custom_price, notes, updated_at: new Date().toISOString() }], { onConflict: 'partner_id,item_id,unit_name' });

  if (error) return showToast('Gagal menyimpan harga khusus: ' + error.message, 'error');

  e.target.reset();
  if (document.getElementById('pp-unit')) {
    document.getElementById('pp-unit').innerHTML = '<option value="">-- Pilih --</option>';
  }
  document.getElementById('pp-info-base').classList.add('hidden');
  showToast('Harga khusus partner berhasil disimpan.');
  await loadAllData();
  renderPartnerPricesTable();
});

function renderPartnerPricesTable() {
  const filterId = document.getElementById('filter-pp-partner')?.value || '';
  const tbody = document.getElementById('partner-prices-body');
  if (!tbody) return;

  const filtered = state.partnerPrices.filter(pp => !filterId || pp.partner_id === filterId);
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="p-5 text-center font-mono text-swiss-muted">Belum ada harga khusus yang diatur.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(pp => {
    const item = pp.items || {};
    const unitName = pp.unit_name || item.base_unit || 'PCS';
    const matchedUnit = (item.item_units || []).find(u => String(u.unit_name).toUpperCase() === String(unitName).toUpperCase());
    const factor = matchedUnit ? Number(matchedUnit.conversion_factor) : 1;

    const unitCost = (Number(item.avg_cost) || 0) * factor;
    const unitStd = (matchedUnit && Number(matchedUnit.sell_price) > 0)
      ? Number(matchedUnit.sell_price)
      : ((Number(item.default_sell_price) || 0) * factor);
    const custom = Number(pp.custom_price) || 0;
    const profit = custom - unitCost;
    const margin = custom > 0 && unitCost > 0 ? ((profit / custom) * 100).toFixed(1) : null;
    const isLoss = unitCost > 0 && custom < unitCost;

    return `
      <tr class="hover:bg-neutral-50">
        <td class="p-2.5">
          <div class="font-semibold">${escapeHtml(pp.partners?.name || '-')}</div>
          <div class="font-mono text-[10px] text-swiss-muted">${escapeHtml(pp.notes || pp.partners?.type || '')}</div>
        </td>
        <td class="p-2.5">
          <div class="font-semibold">${escapeHtml(item.name || '-')}</div>
          <div class="font-mono text-[10px] text-swiss-muted">${escapeHtml(item.sku || '')} • per <strong class="text-swiss-ink">${escapeHtml(unitName)}</strong>${factor > 1 ? ` (x${factor})` : ''}</div>
        </td>
        <td class="p-2.5 text-right font-mono text-swiss-muted">${formatRupiah(unitCost)}</td>
        <td class="p-2.5 text-right font-mono text-swiss-muted">${unitStd > 0 ? formatRupiah(unitStd) : '-'}</td>
        <td class="p-2.5 text-right font-mono font-bold ${isLoss ? 'text-swiss-red' : ''}">${formatRupiah(custom)}</td>
        <td class="p-2.5 text-right font-mono ${isLoss ? 'text-swiss-red font-bold' : ''}">
          ${margin !== null ? `${margin}%` : '-'}
        </td>
        <td class="p-2.5 text-right">
          <button onclick="deletePartnerPrice('${pp.id}')" class="font-mono text-[11px] text-swiss-red underline">Hapus</button>
        </td>
      </tr>
    `;
  }).join('');
}

async function deletePartnerPrice(id) {
  if (!confirm('Hapus harga khusus ini? Transaksi berikutnya akan kembali ke harga standar.')) return;
  const { error } = await db.from('partner_prices').delete().eq('id', id);
  if (error) return showToast(error.message, 'error');
  showToast('Harga khusus dihapus.');
  await loadAllData();
  renderPartnerPricesTable();
}

function onProfitModeChange() {
  const mode = document.getElementById('profit-period-mode').value;
  document.getElementById('profit-month').classList.toggle('hidden', mode === 'ALL');
  loadProfitAnalysis();
}

async function loadProfitAnalysis() {
  const monthInput = document.getElementById('profit-month');
  if (!monthInput) return;
  if (!monthInput.value) {
    monthInput.value = new Date().toISOString().substring(0, 7);
  }

  const mode = document.getElementById('profit-period-mode').value;
  const monthVal = monthInput.value;

  document.getElementById('profit-by-item-body').innerHTML = '<tr><td colspan="4" class="p-4 text-center font-mono text-swiss-muted">Menghitung laba...</td></tr>';
  document.getElementById('profit-by-partner-body').innerHTML = '<tr><td colspan="4" class="p-4 text-center font-mono text-swiss-muted">Menghitung laba...</td></tr>';

  try {
    let query = db
      .from('transaction_items')
      .select('*, items(sku, name, base_unit, avg_cost), transactions!inner(id, transaction_date, partner_id, partners(id, name))')
      .eq('transaction_type', 'OUT')
      .gt('subtotal', 0);

    if (mode === 'MONTH' && monthVal) {
      const [y, m] = monthVal.split('-');
      const lastDay = new Date(Number(y), Number(m), 0).getDate();
      query = query
        .gte('transactions.transaction_date', `${monthVal}-01`)
        .lte('transactions.transaction_date', `${monthVal}-${String(lastDay).padStart(2, '0')}`);
    }

    const { data, error } = await query;
    if (error) throw error;

    let totalRev = 0;
    let totalCogs = 0;
    const itemMap = new Map();
    const partMap = new Map();

    (data || []).forEach(r => {
      const item = r.items;
      const tx = r.transactions;
      if (!item || !tx) return;

      const qty = Math.abs(Number(r.base_qty) || 0);
      const rev = Number(r.subtotal) || 0;
      const unitCost = Number(r.cost_price) > 0 ? Number(r.cost_price) : (Number(item.avg_cost) || 0);
      const cogs = qty * unitCost;
      const gross = rev - cogs;

      totalRev += rev;
      totalCogs += cogs;

      if (!itemMap.has(r.item_id)) {
        itemMap.set(r.item_id, { sku: item.sku, name: item.name, base_unit: item.base_unit, qty: 0, rev: 0, cogs: 0, gross: 0 });
      }
      const it = itemMap.get(r.item_id);
      it.qty += qty;
      it.rev += rev;
      it.cogs += cogs;
      it.gross += gross;

      const pKey = tx.partner_id || 'UMUM';
      const pName = tx.partners?.name || 'Umum / Tanpa Partner';
      if (!partMap.has(pKey)) {
        partMap.set(pKey, { name: pName, rev: 0, cogs: 0, gross: 0 });
      }
      const pt = partMap.get(pKey);
      pt.rev += rev;
      pt.cogs += cogs;
      pt.gross += gross;
    });

    const totalGross = totalRev - totalCogs;
    const avgMargin = totalRev > 0 ? ((totalGross / totalRev) * 100) : 0;

    document.getElementById('profit-kpi-rev').textContent = formatRupiah(totalRev);
    document.getElementById('profit-kpi-cogs').textContent = formatRupiah(totalCogs);
    document.getElementById('profit-kpi-gross').textContent = formatRupiah(totalGross);
    document.getElementById('profit-kpi-margin').textContent = `${avgMargin.toFixed(1)}%`;

    profitState.byItem = Array.from(itemMap.values()).sort((a, b) => b.gross - a.gross);
    profitState.byPartner = Array.from(partMap.values()).sort((a, b) => b.gross - a.gross);

    const itemBody = document.getElementById('profit-by-item-body');
    if (profitState.byItem.length === 0) {
      itemBody.innerHTML = '<tr><td colspan="4" class="p-5 text-center font-mono text-swiss-muted">Belum ada transaksi keluar bernilai jual di periode ini.</td></tr>';
    } else {
      itemBody.innerHTML = profitState.byItem.map(it => {
        const m = it.rev > 0 ? ((it.gross / it.rev) * 100).toFixed(1) : '0.0';
        return `
          <tr>
            <td class="p-3"><div class="font-semibold">${escapeHtml(it.name)}</div><div class="font-mono text-[10px] text-swiss-muted">${escapeHtml(it.sku)}</div></td>
            <td class="p-3 text-right font-mono">${it.qty} ${escapeHtml(it.base_unit)}</td>
            <td class="p-3 text-right font-mono">${formatRupiah(it.rev)}</td>
            <td class="p-3 text-right font-mono">
              <div class="font-bold ${it.gross < 0 ? 'text-swiss-red' : ''}">${formatRupiah(it.gross)}</div>
              <div class="text-[10px] text-swiss-muted">${m}%</div>
            </td>
          </tr>
        `;
      }).join('');
    }

    const partBody = document.getElementById('profit-by-partner-body');
    if (profitState.byPartner.length === 0) {
      partBody.innerHTML = '<tr><td colspan="4" class="p-5 text-center font-mono text-swiss-muted">Belum ada data laba per customer di periode ini.</td></tr>';
    } else {
      partBody.innerHTML = profitState.byPartner.map(pt => {
        const m = pt.rev > 0 ? ((pt.gross / pt.rev) * 100).toFixed(1) : '0.0';
        return `
          <tr>
            <td class="p-3 font-semibold">${escapeHtml(pt.name)}</td>
            <td class="p-3 text-right font-mono">${formatRupiah(pt.rev)}</td>
            <td class="p-3 text-right font-mono text-swiss-muted">${formatRupiah(pt.cogs)}</td>
            <td class="p-3 text-right font-mono">
              <div class="font-bold ${pt.gross < 0 ? 'text-swiss-red' : ''}">${formatRupiah(pt.gross)}</div>
              <div class="text-[10px] text-swiss-muted">${m}%</div>
            </td>
          </tr>
        `;
      }).join('');
    }
  } catch (err) {
    showToast('Gagal menghitung analisa laba: ' + err.message, 'error');
  }
}

function exportProfitCSV() {
  if (profitState.byItem.length === 0) return showToast('Tidak ada data laba untuk diekspor.', 'error');
  const mode = document.getElementById('profit-period-mode').value;
  const label = mode === 'MONTH' ? document.getElementById('profit-month').value : 'Semua_Periode';
  const header = ['SKU', 'Nama Produk', 'Qty Keluar', 'Satuan Base', 'Total Omzet (Rp)', 'Total HPP (Rp)', 'Laba Kotor (Rp)', 'Margin (%)'];
  const rows = profitState.byItem.map(it => [
    it.sku, it.name, it.qty, it.base_unit,
    Math.round(it.rev), Math.round(it.cogs), Math.round(it.gross),
    (it.rev > 0 ? ((it.gross / it.rev) * 100).toFixed(1) : '0.0') + '%'
  ]);
  downloadCSV(`Analisa_Laba_Produk_${label}.csv`, [header, ...rows]);
}

// Mulai aplikasi
checkSession();
