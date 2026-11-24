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
    renderDashboardChart();
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

function parseReceiptUrls(raw) {
  if (!raw) return [];
  const str = String(raw).trim();
  if (!str) return [];
  if (str.startsWith('[')) {
    try {
      const arr = JSON.parse(str);
      if (Array.isArray(arr)) return arr.filter(Boolean);
    } catch (_) {}
  }
  return str.split(/[\n|]+/).map(s => s.trim()).filter(Boolean);
}

async function uploadReceiptToDrive(file, dateStr, refNo, indexSuffix = '') {
  const url = (state.settings.gdrive_script_url || '').trim();
  const secretKey = (state.settings.gdrive_secret_key || '').trim();
  if (!url || !secretKey) {
    throw new Error('URL Apps Script atau Secret Key belum diisi di menu 06 / Pengaturan.');
  }

  const base64 = await compressImageToBase64(file);
  const cleanRef = refNo.replace(/[^a-zA-Z0-9-_]/g, '');
  const fileName = `${dateStr}_${cleanRef}${indexSuffix}.jpg`;

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
  const receiptFiles = Array.from(document.getElementById('tx-receipt-file').files || []);

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

  try {
    let receiptUrl = null;
    if (receiptFiles.length > 0) {
      const uploadedUrls = [];
      for (let i = 0; i < receiptFiles.length; i++) {
        btn.textContent = receiptFiles.length > 1
          ? `Mengupload foto ${i + 1}/${receiptFiles.length}...`
          : 'Mengupload foto nota...';
        const suffix = receiptFiles.length > 1 ? `_${i + 1}` : '';
        const url = await uploadReceiptToDrive(receiptFiles[i], txDate, refNo, suffix);
        uploadedUrls.push(url);
      }
      receiptUrl = uploadedUrls.join(' | ');
    }

    btn.textContent = 'Menyimpan transaksi...';

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

  tbody.innerHTML = filtered.map(t => {
    const urls = parseReceiptUrls(t.receipt_url);
    const receiptHtml = urls.length === 0
      ? '<span class="text-swiss-muted">-</span>'
      : urls.length === 1
        ? `<a href="${escapeHtml(urls[0])}" target="_blank" class="font-mono text-[11px] underline text-swiss-red">Lihat Nota ↗</a>`
        : `<div class="flex flex-wrap gap-x-2 gap-y-1">${urls.map((u, idx) => `<a href="${escapeHtml(u)}" target="_blank" class="font-mono text-[11px] underline text-swiss-red">Nota ${idx + 1} ↗</a>`).join('')}</div>`;

    return `
      <tr class="hover:bg-neutral-50">
        <td class="p-3 font-mono">${t.transaction_date}</td>
        <td class="p-3 font-mono font-semibold">${escapeHtml(t.reference_no)}</td>
        <td class="p-3">${renderTypeBadge(t.type)}</td>
        <td class="p-3">${escapeHtml(t.partners?.name || '-')}</td>
        <td class="p-3">${receiptHtml}</td>
        <td class="p-3 text-right space-x-2">
          <button onclick="openTxDetail('${t.id}')" class="font-mono text-[11px] underline">Detail / Cetak</button>
          <button onclick="deleteTransaction('${t.id}', '${escapeHtml(t.reference_no)}')" class="font-mono text-[11px] text-swiss-red underline">Hapus</button>
        </td>
      </tr>
    `;
  }).join('');
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
  const receiptUrls = parseReceiptUrls(tx.receipt_url);

  document.getElementById('detail-tx-content').innerHTML = `
    <div class="grid grid-cols-2 gap-2 border-b border-swiss-line pb-3">
      <div><span class="text-swiss-muted font-mono">JENIS:</span> ${renderTypeBadge(tx.type)}</div>
      <div><span class="text-swiss-muted font-mono">PARTNER:</span> <strong>${escapeHtml(tx.partners?.name || '-')}</strong></div>
      <div class="col-span-2"><span class="text-swiss-muted font-mono">CATATAN:</span> ${escapeHtml(tx.notes || '-')}</div>
      ${receiptUrls.length > 0 ? `
        <div class="col-span-2 no-print flex flex-wrap gap-2 pt-1">
          ${receiptUrls.map((u, idx) => `
            <a href="${escapeHtml(u)}" target="_blank" class="border border-swiss-red text-swiss-red px-2.5 py-1 text-[11px] font-mono hover:bg-swiss-red hover:text-white transition-colors">
              ${receiptUrls.length > 1 ? `Buka Foto Nota ${idx + 1} ↗` : 'Buka Foto Nota di Google Drive ↗'}
            </a>
          `).join('')}
        </div>
      ` : ''}
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
  const withReceipts = state.transactions.filter(t => parseReceiptUrls(t.receipt_url).length > 0);
  if (withReceipts.length === 0) {
    gallery.innerHTML = '<p class="text-xs font-mono text-swiss-muted col-span-full">Belum ada foto nota yang diunggah.</p>';
    return;
  }

  gallery.innerHTML = withReceipts.map(t => {
    const urls = parseReceiptUrls(t.receipt_url);
    const buttonsHtml = urls.length === 1
      ? `<a href="${escapeHtml(urls[0])}" target="_blank" class="block text-center bg-swiss-ink text-white py-2 text-xs font-mono uppercase hover:bg-swiss-red transition-colors">Buka Foto Nota ↗</a>`
      : `<div class="grid grid-cols-2 gap-1.5">${urls.map((u, idx) => `<a href="${escapeHtml(u)}" target="_blank" class="block text-center bg-swiss-ink text-white py-1.5 text-[11px] font-mono uppercase hover:bg-swiss-red transition-colors">Foto ${idx + 1} ↗</a>`).join('')}</div>`;

    return `
      <div class="border border-swiss-ink p-4 bg-neutral-50 flex flex-col justify-between gap-3">
        <div>
          <div class="flex items-center justify-between mb-1">
            <span class="font-mono text-xs font-bold">${escapeHtml(t.reference_no)}</span>
            ${renderTypeBadge(t.type)}
          </div>
          <p class="font-mono text-[11px] text-swiss-muted">${t.transaction_date}${urls.length > 1 ? ` • ${urls.length} foto` : ''}</p>
          <p class="text-xs font-semibold mt-1">${escapeHtml(t.partners?.name || 'Tanpa Partner')}</p>
        </div>
        ${buttonsHtml}
      </div>
    `;
  }).join('');
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
      HPP_MODAL: 42000,
      HARGA_JUAL: 50000,
      SATUAN_BESAR: 'BOX',
      ISI_SATUAN_BESAR: 5,
      HARGA_JUAL_SATUAN_BESAR: 240000
    },
    {
      SKU: 'KLT-001',
      NAMA_BARANG: 'Tisu Kamar Mandi Roll',
      KATEGORI: 'Kebersihan',
      SATUAN_TERKECIL: 'PCS',
      STOK_MIN: 20,
      LOKASI: 'Gudang B',
      HPP_MODAL: 4300,
      HARGA_JUAL: 5500,
      SATUAN_BESAR: 'PACK',
      ISI_SATUAN_BESAR: 10,
      HARGA_JUAL_SATUAN_BESAR: ''
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

function parseOptionalNumber(val) {
  if (val === '' || val === null || val === undefined) return null;
  const cleaned = String(val).replace(/[^\d.-]/g, '');
  if (cleaned === '') return null;
  const num = Number(cleaned);
  return isNaN(num) ? null : num;
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
          avg_cost: parseOptionalNumber(r.HPP_MODAL ?? r.HPP ?? r.MODAL),
          default_sell_price: parseOptionalNumber(r.HARGA_JUAL ?? r.HARGA_JUAL_STANDAR),
          big_unit: String(r.SATUAN_BESAR || '').trim().toUpperCase(),
          big_factor: Number(r.ISI_SATUAN_BESAR || r.ISI_PER_SATUAN || 0) || 0,
          big_sell_price: parseOptionalNumber(r.HARGA_JUAL_SATUAN_BESAR ?? r.HARGA_GROSIR ?? r.HARGA_SATUAN_BESAR)
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
      document.getElementById('import-preview-body').innerHTML = pendingImportRows.slice(0, 10).map(r => {
        const priceNote = (r.avg_cost !== null || r.default_sell_price !== null)
          ? `<div class="text-[10px] text-swiss-muted">HPP: ${r.avg_cost !== null ? formatRupiah(r.avg_cost) : '-'} | Jual: ${r.default_sell_price !== null ? formatRupiah(r.default_sell_price) : '-'}</div>`
          : '';
        const bigPriceNote = (r.big_sell_price !== null && r.big_sell_price > 0)
          ? `<div class="text-[10px] text-swiss-ink font-semibold">Jual: ${formatRupiah(r.big_sell_price)}</div>`
          : '';

        return `
          <tr>
            <td class="p-2 font-mono font-semibold">${escapeHtml(r.sku)}</td>
            <td class="p-2">${escapeHtml(r.name)}</td>
            <td class="p-2">${escapeHtml(r.categoryName || '-')}</td>
            <td class="p-2 font-mono">${escapeHtml(r.base_unit)}${priceNote}</td>
            <td class="p-2 font-mono text-swiss-muted">
              ${r.big_unit && r.big_factor > 1 ? `1 ${escapeHtml(r.big_unit)} = ${r.big_factor} ${escapeHtml(r.base_unit)}${bigPriceNote}` : '-'}
            </td>
          </tr>
        `;
      }).join('');

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
    const existingItemsMap = new Map(state.items.map(i => [i.sku.toUpperCase(), i]));
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

    const itemsPayload = pendingImportRows.map(r => {
      const existing = existingItemsMap.get(r.sku);
      return {
        sku: r.sku,
        name: r.name,
        category_id: r.categoryName ? (existingCatMap.get(r.categoryName.toLowerCase()) || null) : (existing?.category_id || null),
        base_unit: r.base_unit,
        min_stock: r.min_stock,
        location: r.location,
        avg_cost: r.avg_cost !== null ? r.avg_cost : (Number(existing?.avg_cost) || 0),
        default_sell_price: r.default_sell_price !== null ? r.default_sell_price : (Number(existing?.default_sell_price) || 0)
      };
    });

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
        const existingItem = existingItemsMap.get(r.sku);
        const existingUnit = (existingItem?.item_units || []).find(u => u.unit_name.toUpperCase() === r.big_unit);
        unitsMap.set(`${itemId}|${r.big_unit}`, {
          item_id: itemId,
          unit_name: r.big_unit,
          conversion_factor: r.big_factor,
          sell_price: r.big_sell_price !== null ? r.big_sell_price : (Number(existingUnit?.sell_price) || 0)
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
    showToast(`Berhasil mengimport ${pendingImportRows.length} barang beserta data harganya!`);
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

let selectedPriceItem = null;

function openPriceDetail(itemId) {
  const entry = priceAnalysisList.find(x => x.itemId === itemId);
  if (!entry) return;
  selectedPriceItem = entry;

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
  selectedPriceItem = null;
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

function exportItemPurchaseHistoryCSV() {
  if (!selectedPriceItem || selectedPriceItem.history.length === 0) {
    return showToast('Pilih barang terlebih dahulu.', 'error');
  }
  const x = selectedPriceItem;
  const header = ['SKU', 'Nama Barang', 'Tanggal', 'No Bukti', 'Supplier', 'Qty & Satuan Nota', 'Satuan Base', 'Harga / Base (Rp)', 'Total Nota Baris (Rp)'];
  const rows = x.history.map(h => [
    x.sku, x.name, h.date, h.refNo, h.supplierName, h.inputLabel, x.base_unit, Math.round(h.basePrice), Math.round(h.subtotal)
  ]);
  const safeSku = x.sku.replace(/[^a-zA-Z0-9-_]/g, '_');
  downloadCSV(`Riwayat_Pembelian_${safeSku}_${new Date().toISOString().split('T')[0]}.csv`, [header, ...rows]);
}

function exportAllPurchasesByItemCSV() {
  if (priceAnalysisList.length === 0) {
    return showToast('Belum ada data pembelian pada rentang waktu ini.', 'error');
  }
  const rangeVal = document.getElementById('filter-price-range')?.value || '30';
  const sortedItems = [...priceAnalysisList].sort((a, b) => a.name.localeCompare(b.name));
  const header = ['SKU', 'Nama Barang', 'Tanggal', 'No Bukti', 'Supplier', 'Qty & Satuan Nota', 'Satuan Base', 'Harga / Base (Rp)', 'Total Nota Baris (Rp)'];
  const rows = [];

  sortedItems.forEach(x => {
    x.history.forEach(h => {
      rows.push([
        x.sku, x.name, h.date, h.refNo, h.supplierName, h.inputLabel, x.base_unit, Math.round(h.basePrice), Math.round(h.subtotal)
      ]);
    });
  });

  downloadCSV(`Daftar_Pembelian_Per_Item_${rangeVal === 'ALL' ? 'Semua' : rangeVal + 'Hari'}_${new Date().toISOString().split('T')[0]}.csv`, [header, ...rows]);
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
// ==========================================
// 11. BLIND STOCK OPNAME & DRAFT REKONSILIASI
// ==========================================
const SO_STORAGE_KEY = 'atk_so_draft_v1';

let soDraft = {
  mode: 'BLIND', // 'BLIND' | 'RECONCILE'
  date: '',
  notes: '',
  counts: {} // { [itemId]: { qty: string|number, note: string } }
};

function loadSODraftFromStorage() {
  try {
    const raw = localStorage.getItem(SO_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      soDraft = {
        mode: parsed.mode === 'RECONCILE' ? 'RECONCILE' : 'BLIND',
        date: parsed.date || new Date().toISOString().split('T')[0],
        notes: parsed.notes || '',
        counts: parsed.counts || {}
      };
    } else {
      soDraft.date = new Date().toISOString().split('T')[0];
    }
  } catch (_) {
    soDraft.date = new Date().toISOString().split('T')[0];
  }
}

function persistSODraft() {
  localStorage.setItem(SO_STORAGE_KEY, JSON.stringify(soDraft));
}

function saveSODraftMeta() {
  soDraft.date = document.getElementById('so-date')?.value || new Date().toISOString().split('T')[0];
  soDraft.notes = document.getElementById('so-notes')?.value || '';
  persistSODraft();
}

function loadStockOpname() {
  loadSODraftFromStorage();

  const catSelect = document.getElementById('so-filter-cat');
  if (catSelect) {
    const prev = catSelect.value;
    catSelect.innerHTML = '<option value="">Semua Kategori</option>' +
      state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    catSelect.value = prev;
  }

  const dateEl = document.getElementById('so-date');
  const notesEl = document.getElementById('so-notes');
  if (dateEl) dateEl.value = soDraft.date || new Date().toISOString().split('T')[0];
  if (notesEl) notesEl.value = soDraft.notes || '';

  updateSOModeUI();
  renderSOTable();
}

function setSOMode(mode) {
  soDraft.mode = mode;
  persistSODraft();
  updateSOModeUI();
  renderSOTable();
}

function updateSOModeUI() {
  const isRec = soDraft.mode === 'RECONCILE';
  const badge = document.getElementById('so-mode-badge');
  const btnBlind = document.getElementById('btn-so-blind');
  const btnRec = document.getElementById('btn-so-reconcile');
  const summary = document.getElementById('so-reconcile-summary');
  const onlyDiffWrap = document.getElementById('so-only-diff-wrap');

  if (badge) {
    badge.textContent = isRec ? 'DRAFT REKONSILIASI (PREVIEW)' : 'MODE BLIND COUNT';
    badge.className = isRec
      ? 'px-2 py-0.5 bg-swiss-red text-white font-mono text-[10px] uppercase'
      : 'px-2 py-0.5 bg-swiss-ink text-white font-mono text-[10px] uppercase';
  }

  if (btnBlind && btnRec) {
    btnBlind.className = isRec
      ? 'border border-swiss-ink px-3 py-2 text-xs font-mono font-bold bg-white hover:bg-neutral-100'
      : 'border border-swiss-ink px-3 py-2 text-xs font-mono font-bold bg-swiss-ink text-white';
    btnRec.className = isRec
      ? 'border border-swiss-red px-3 py-2 text-xs font-mono font-bold bg-swiss-red text-white'
      : 'border border-swiss-ink px-3 py-2 text-xs font-mono font-bold bg-white hover:bg-neutral-100';
  }

  summary?.classList.toggle('hidden', !isRec);
  onlyDiffWrap?.classList.toggle('hidden', !isRec);
}

function getSOFilteredItems() {
  const q = (document.getElementById('so-search')?.value || '').toLowerCase();
  const catId = document.getElementById('so-filter-cat')?.value || '';
  const onlyCounted = document.getElementById('so-only-counted')?.checked || false;
  const onlyDiff = (soDraft.mode === 'RECONCILE') && (document.getElementById('so-only-diff')?.checked || false);

  return state.items.filter(item => {
    const matchText = item.name.toLowerCase().includes(q)
      || item.sku.toLowerCase().includes(q)
      || (item.location || '').toLowerCase().includes(q);
    const matchCat = !catId || item.category_id === catId;
    if (!matchText || !matchCat) return false;

    const entry = soDraft.counts[item.id];
    const hasCount = entry && entry.qty !== '' && entry.qty !== null && entry.qty !== undefined;
    if (onlyCounted && !hasCount) return false;

    if (onlyDiff) {
      if (!hasCount) return false;
      const diff = Number(entry.qty) - Number(item.current_stock || 0);
      if (diff === 0) return false;
    }
    return true;
  });
}

function updateSOKPIs() {
  let counted = 0, matched = 0, diffCount = 0, netVal = 0;

  state.items.forEach(item => {
    const entry = soDraft.counts[item.id];
    if (entry && entry.qty !== '' && entry.qty !== null && entry.qty !== undefined) {
      counted++;
      const diff = Number(entry.qty) - Number(item.current_stock || 0);
      if (diff === 0) {
        matched++;
      } else {
        diffCount++;
        netVal += diff * (Number(item.avg_cost) || 0);
      }
    }
  });

  const statusEl = document.getElementById('so-draft-status');
  if (statusEl) {
    statusEl.textContent = counted > 0
      ? `Draft lokal tersimpan (${counted} barang dihitung) — belum mengubah stok sistem.`
      : 'Draft lokal kosong — mulai ketik hasil fisik atau upload Excel SO.';
  }

  const elCounted = document.getElementById('so-kpi-counted');
  if (elCounted) elCounted.textContent = counted;
  const elMatch = document.getElementById('so-kpi-match');
  if (elMatch) elMatch.textContent = matched;
  const elDiff = document.getElementById('so-kpi-diff');
  if (elDiff) elDiff.textContent = diffCount;
  const elVal = document.getElementById('so-kpi-val');
  if (elVal) {
    elVal.textContent = (netVal > 0 ? '+' : netVal < 0 ? '-' : '') + formatRupiah(Math.abs(netVal));
    elVal.className = `text-lg md:text-xl font-extrabold font-mono mt-1 truncate ${netVal < 0 ? 'text-swiss-red' : ''}`;
  }
}

function renderSOTable() {
  const isRec = soDraft.mode === 'RECONCILE';
  const thead = document.getElementById('so-table-head');
  const tbody = document.getElementById('so-table-body');
  if (!thead || !tbody) return;

  updateSOKPIs();

  if (isRec) {
    thead.innerHTML = `
      <tr>
        <th class="p-3">Barang & Lokasi</th>
        <th class="p-3 text-right">Stok Sistem</th>
        <th class="p-3 w-36">Stok Fisik (Base)</th>
        <th class="p-3 text-right">Selisih</th>
        <th class="p-3 text-right">Nilai Selisih</th>
        <th class="p-3">Catatan</th>
      </tr>
    `;
  } else {
    thead.innerHTML = `
      <tr>
        <th class="p-3">Barang</th>
        <th class="p-3">Lokasi</th>
        <th class="p-3">Satuan Base</th>
        <th class="p-3 w-40">Hitungan Fisik</th>
        <th class="p-3">Catatan Lapangan</th>
      </tr>
    `;
  }

  const items = getSOFilteredItems();
  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${isRec ? 6 : 5}" class="p-6 text-center font-mono text-swiss-muted">Tidak ada barang yang sesuai filter.</td></tr>`;
    return;
  }

  tbody.innerHTML = items.map(item => {
    const entry = soDraft.counts[item.id] || { qty: '', note: '' };
    const hasCount = entry.qty !== '' && entry.qty !== null && entry.qty !== undefined;
    const sysStock = Number(item.current_stock) || 0;
    const diff = hasCount ? (Number(entry.qty) - sysStock) : null;
    const diffVal = diff !== null ? diff * (Number(item.avg_cost) || 0) : 0;

    if (!isRec) {
      return `
        <tr class="hover:bg-neutral-50 ${hasCount ? 'bg-neutral-50/70' : ''}">
          <td class="p-3">
            <div class="font-semibold">${escapeHtml(item.name)}</div>
            <div class="font-mono text-[10px] text-swiss-muted">${escapeHtml(item.sku)}</div>
          </td>
          <td class="p-3 font-mono text-[11px] text-swiss-muted">${escapeHtml(item.location || '-')}</td>
          <td class="p-3 font-mono font-semibold">${escapeHtml(item.base_unit)}</td>
          <td class="p-2.5">
            <input type="number" step="any" min="0" value="${hasCount ? entry.qty : ''}"
              placeholder="Kosong..."
              oninput="onSOInputChange('${item.id}', 'qty', this.value)"
              class="swiss-input py-1.5 text-xs font-mono font-bold" />
          </td>
          <td class="p-2.5">
            <input type="text" value="${escapeHtml(entry.note || '')}"
              placeholder="Opsional (rusak/selip)"
              oninput="onSOInputChange('${item.id}', 'note', this.value)"
              class="swiss-input py-1.5 text-xs" />
          </td>
        </tr>
      `;
    }

    const diffClass = diff === null ? 'text-swiss-muted' : diff === 0 ? 'text-swiss-muted' : 'text-swiss-red font-bold';
    const diffLabel = diff === null ? '-' : diff > 0 ? `+${diff}` : `${diff}`;

    return `
      <tr class="hover:bg-neutral-50 ${diff && diff !== 0 ? 'bg-red-50/40' : ''}">
        <td class="p-3">
          <div class="font-semibold">${escapeHtml(item.name)}</div>
          <div class="font-mono text-[10px] text-swiss-muted">${escapeHtml(item.sku)} • ${escapeHtml(item.location || 'Tanpa Lokasi')}</div>
        </td>
        <td class="p-3 text-right font-mono">${sysStock} ${escapeHtml(item.base_unit)}</td>
        <td class="p-2.5">
          <input type="number" step="any" min="0" value="${hasCount ? entry.qty : ''}"
            placeholder="Belum dihitung"
            onchange="onSOInputChange('${item.id}', 'qty', this.value, true)"
            class="swiss-input py-1.5 text-xs font-mono font-bold" />
        </td>
        <td class="p-3 text-right font-mono ${diffClass}">${diffLabel} ${diff !== null ? escapeHtml(item.base_unit) : ''}</td>
        <td class="p-3 text-right font-mono ${diffClass}">
          ${diff !== null && diff !== 0 ? `${diffVal > 0 ? '+' : '-'}${formatRupiah(Math.abs(diffVal))}` : '-'}
        </td>
        <td class="p-2.5">
          <input type="text" value="${escapeHtml(entry.note || '')}"
            placeholder="Catatan recount..."
            oninput="onSOInputChange('${item.id}', 'note', this.value)"
            class="swiss-input py-1.5 text-xs" />
        </td>
      </tr>
    `;
  }).join('');
}

function onSOInputChange(itemId, field, value, reRender = false) {
  if (!soDraft.counts[itemId]) {
    soDraft.counts[itemId] = { qty: '', note: '' };
  }
  soDraft.counts[itemId][field] = value;

  if (soDraft.counts[itemId].qty === '' && !soDraft.counts[itemId].note) {
    delete soDraft.counts[itemId];
  }

  persistSODraft();
  updateSOKPIs();
  if (reRender) renderSOTable();
}

function clearSODraft() {
  if (!confirm('Hapus seluruh isi Draft Stock Opname lokal? Data stok di sistem tidak akan terpengaruh.')) return;
  localStorage.removeItem(SO_STORAGE_KEY);
  soDraft = {
    mode: 'BLIND',
    date: new Date().toISOString().split('T')[0],
    notes: '',
    counts: {}
  };
  document.getElementById('so-excel-upload').value = '';
  loadStockOpname();
  showToast('Draft Stock Opname berhasil dihapus.');
}

function downloadSOBlankSheet() {
  const items = getSOFilteredItems();
  if (items.length === 0) return showToast('Tidak ada barang untuk dicetak ke lembar SO.', 'error');

  const rows = items.map(i => ({
    SKU: i.sku,
    NAMA_BARANG: i.name,
    KATEGORI: i.categories?.name || '',
    LOKASI: i.location || '',
    SATUAN_BASE: i.base_unit,
    STOK_FISIK: '',
    CATATAN: ''
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Lembar_SO_Kosong');
  XLSX.writeFile(wb, `Lembar_Blind_SO_${new Date().toISOString().split('T')[0]}.xlsx`);
}

function handleSOExcelUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });

      const skuToItem = new Map(state.items.map(i => [i.sku.toUpperCase(), i]));
      let loadedCount = 0;

      rawRows.forEach(raw => {
        const r = normalizeRowKeys(raw);
        const sku = String(r.SKU || '').trim().toUpperCase();
        const item = skuToItem.get(sku);
        if (!item) return;

        const phys = parseOptionalNumber(r.STOK_FISIK ?? r.FISIK ?? r.QTY_FISIK);
        if (phys === null) return;

        soDraft.counts[item.id] = {
          qty: phys,
          note: String(r.CATATAN || r.KETERANGAN || '').trim()
        };
        loadedCount++;
      });

      if (loadedCount === 0) {
        return showToast('Tidak ada angka STOK_FISIK yang cocok dengan SKU master.', 'error');
      }

      persistSODraft();
      setSOMode('RECONCILE');
      showToast(`${loadedCount} hasil hitung fisik berhasil dimuat ke Draft Rekonsiliasi.`);
    } catch (err) {
      showToast('Gagal membaca file SO: ' + err.message, 'error');
    } finally {
      event.target.value = '';
    }
  };
  reader.readAsArrayBuffer(file);
}

function exportSOReconcileCSV() {
  const rows = [];
  state.items.forEach(item => {
    const entry = soDraft.counts[item.id];
    if (!entry || entry.qty === '' || entry.qty === null || entry.qty === undefined) return;
    const sys = Number(item.current_stock) || 0;
    const phys = Number(entry.qty);
    const diff = phys - sys;
    const val = diff * (Number(item.avg_cost) || 0);
    rows.push([
      item.sku, item.name, item.location || '', item.base_unit,
      sys, phys, diff, Math.round(val), entry.note || ''
    ]);
  });

  if (rows.length === 0) return showToast('Belum ada barang yang dihitung di draft.', 'error');
  const header = ['SKU', 'Nama Barang', 'Lokasi', 'Satuan Base', 'Stok Sistem', 'Stok Fisik', 'Selisih', 'Nilai Selisih (Rp)', 'Catatan'];
  downloadCSV(`Draft_Rekonsiliasi_SO_${soDraft.date || new Date().toISOString().split('T')[0]}.csv`, [header, ...rows]);
}

async function finalizeStockOpname() {
  const adjustments = [];
  state.items.forEach(item => {
    const entry = soDraft.counts[item.id];
    if (!entry || entry.qty === '' || entry.qty === null || entry.qty === undefined) return;
    const sys = Number(item.current_stock) || 0;
    const phys = Number(entry.qty);
    const diff = phys - sys;
    if (diff !== 0) {
      adjustments.push({
        item,
        diff,
        cost: Number(item.avg_cost) || 0
      });
    }
  });

  if (adjustments.length === 0) {
    return showToast('Tidak ada selisih stok untuk disahkan (semua barang yang dihitung sudah cocok).');
  }

  const ok = confirm(
    `Sahkan hasil Stock Opname ini?\n\n` +
    `• ${adjustments.length} barang yang berselisih akan disesuaikan otomatis di stok gudang.\n` +
    `• Barang yang tidak dihitung / sudah cocok tidak akan diubah.\n` +
    `• Tercatat sebagai 1 bukti transaksi ADJUSTMENT (bisa dihapus kembali dari menu 02 jika perlu).`
  );
  if (!ok) return;

  const btn = document.getElementById('btn-so-finalize');
  btn.disabled = true;
  btn.textContent = 'Menyimpan SO...';

  try {
    const txDate = document.getElementById('so-date').value || new Date().toISOString().split('T')[0];
    const notes = (document.getElementById('so-notes').value || '').trim() || 'Penyesuaian Hasil Stock Opname';
    const refNo = generateRefNo('ADJUSTMENT').replace('ADJ-', 'SO-');

    const { data: txData, error: txErr } = await db
      .from('transactions')
      .insert([{
        reference_no: refNo,
        transaction_date: txDate,
        type: 'ADJUSTMENT',
        partner_id: null,
        notes,
        created_by: state.user.id
      }])
      .select()
      .single();

    if (txErr) throw txErr;

    const detailRows = adjustments.map(a => ({
      transaction_id: txData.id,
      transaction_type: 'ADJUSTMENT',
      item_id: a.item.id,
      input_qty: a.diff,
      input_unit: a.item.base_unit,
      conversion_factor: 1,
      base_qty: a.diff,
      unit_price: a.cost,
      cost_price: a.cost,
      subtotal: Math.round(Math.abs(a.diff) * a.cost)
    }));

    const { error: detErr } = await db.from('transaction_items').insert(detailRows);
    if (detErr) throw detErr;

    localStorage.removeItem(SO_STORAGE_KEY);
    soDraft = { mode: 'BLIND', date: new Date().toISOString().split('T')[0], notes: '', counts: {} };

    showToast(`Stock Opname ${refNo} disahkan! (${adjustments.length} barang disesuaikan)`);
    await loadAllData();
    loadStockOpname();
  } catch (err) {
    showToast('Gagal mengesahkan SO: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sahkan & Sesuaikan Stok →';
  }
}
// ==========================================
// 12. GRAFIK DASHBOARD, DARK MODE & EFEK KURSOR
// ==========================================
let dashChartInstance = null;
let dashChartMode = '14D';

function setChartMode(mode) {
  dashChartMode = mode;
  const b14 = document.getElementById('btn-chart-14d');
  const b6m = document.getElementById('btn-chart-6m');
  if (b14 && b6m) {
    b14.className = mode === '14D'
      ? 'border border-swiss-ink bg-swiss-ink text-white px-2.5 py-1 text-[11px] font-mono font-semibold'
      : 'border border-swiss-ink bg-white px-2.5 py-1 text-[11px] font-mono font-semibold';
    b6m.className = mode === '6M'
      ? 'border border-swiss-ink bg-swiss-ink text-white px-2.5 py-1 text-[11px] font-mono font-semibold'
      : 'border border-swiss-ink bg-white px-2.5 py-1 text-[11px] font-mono font-semibold';
  }
  renderDashboardChart();
}

function renderDashboardChart() {
  const canvas = document.getElementById('dash-trend-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  const isDark = document.documentElement.classList.contains('dark');
  const labels = [];
  const keys = [];
  const now = new Date();

  if (dashChartMode === '6M') {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      keys.push(ym);
      labels.push(`${monthNames[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`);
    }
    const sub = document.getElementById('dash-chart-subtitle');
    if (sub) sub.textContent = 'Jumlah transaksi 6 bulan terakhir';
  } else {
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const iso = d.toISOString().split('T')[0];
      keys.push(iso);
      labels.push(`${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const sub = document.getElementById('dash-chart-subtitle');
    if (sub) sub.textContent = 'Jumlah transaksi 14 hari terakhir';
  }

  const inCounts = keys.map(() => 0);
  const outCounts = keys.map(() => 0);

  (state.transactions || []).forEach(tx => {
    const dt = tx.transaction_date || '';
    const key = dashChartMode === '6M' ? dt.substring(0, 7) : dt.substring(0, 10);
    const idx = keys.indexOf(key);
    if (idx === -1) return;
    if (tx.type === 'IN') inCounts[idx]++;
    if (tx.type === 'OUT') outCounts[idx]++;
  });

  if (dashChartInstance) {
    dashChartInstance.destroy();
  }

  const textColor = isDark ? '#9B9B93' : '#6B6B66';
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(20, 20, 19, 0.06)';
  const greenColor = isDark ? '#10B981' : '#059669';
  const orangeColor = isDark ? '#F97316' : '#EA580C';

  dashChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Barang Masuk (IN)',
          data: inCounts,
          backgroundColor: greenColor,
          borderRadius: 5,
          maxBarThickness: 22
        },
        {
          label: 'Barang Keluar (OUT)',
          data: outCounts,
          backgroundColor: orangeColor,
          borderRadius: 5,
          maxBarThickness: 22
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: {
            color: textColor,
            boxWidth: 10,
            boxHeight: 10,
            usePointStyle: true,
            pointStyle: 'circle',
            font: { family: "'JetBrains Mono', monospace", size: 11 }
          }
        },
        tooltip: {
          backgroundColor: isDark ? '#262622' : '#141413',
          titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
          bodyFont: { family: "'Plus Jakarta Sans', sans-serif", size: 12 },
          padding: 10,
          cornerRadius: 8
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: textColor, font: { family: "'JetBrains Mono', monospace", size: 10 } }
        },
        y: {
          beginAtZero: true,
          grid: { color: gridColor },
          ticks: {
            stepSize: 1,
            precision: 0,
            color: textColor,
            font: { family: "'JetBrains Mono', monospace", size: 10 }
          }
        }
      }
    }
  });
}

// Dark Mode
function applyTheme(theme) {
  const isDark = theme === 'dark';
  document.documentElement.classList.toggle('dark', isDark);
  const label = document.getElementById('theme-toggle-label');
  if (label) label.textContent = isDark ? '☀ Light Mode' : '☾ Dark Mode';
}

function toggleDarkMode() {
  const next = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
  localStorage.setItem('atk_theme', next);
  applyTheme(next);
  renderDashboardChart();
}

function initTheme() {
  const saved = localStorage.getItem('atk_theme') || 'light';
  applyTheme(saved);
}

// Efek Kursor Bergerak (Ambient Aura + Spotlight Kartu)
function initCursorEffects() {
  if (window.matchMedia('(pointer: coarse)').matches) return;

  const aura = document.createElement('div');
  aura.id = 'cursor-aura';
  document.body.appendChild(aura);

  let targetX = -500, targetY = -500;
  let currentX = -500, currentY = -500;

  document.addEventListener('mousemove', (e) => {
    targetX = e.clientX;
    targetY = e.clientY;

    const card = e.target.closest('.grid > .bg-white.p-4, #dash-chart-card, #login-screen > div');
    if (card) {
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - rect.left}px`);
      card.style.setProperty('--my', `${e.clientY - rect.top}px`);
    }
  }, { passive: true });

  document.addEventListener('mouseleave', () => {
    aura.style.opacity = '0';
  });
  document.addEventListener('mouseenter', () => {
    aura.style.opacity = '1';
  });

  function animateAura() {
    currentX += (targetX - currentX) * 0.14;
    currentY += (targetY - currentY) * 0.14;
    aura.style.transform = `translate3d(${currentX - 170}px, ${currentY - 170}px, 0)`;
    requestAnimationFrame(animateAura);
  }
  requestAnimationFrame(animateAura);
}

initTheme();
initCursorEffects();
// ==========================================
// 13. IKON OTOMATIS & COMMAND PALETTE (CTRL+K)
// ==========================================
function injectSidebarIcons() {
  const iconMap = {
    dashboard: 'layout-grid',
    transactions: 'arrow-left-right',
    items: 'package',
    stockopname: 'clipboard-check',
    reports: 'history',
    recap: 'bar-chart-3',
    prices: 'tags',
    pricing: 'trending-up',
    master: 'users',
    settings: 'sliders'
  };

  document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
    if (btn.querySelector('[data-lucide]')) return;
    const iconName = iconMap[btn.dataset.tab];
    if (!iconName) return;

    btn.classList.remove('justify-between');
    btn.classList.add('gap-2.5');

    const iconEl = document.createElement('i');
    iconEl.setAttribute('data-lucide', iconName);
    iconEl.className = 'lucide-nav';
    btn.prepend(iconEl);
  });

  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

let cmdSelectedIndex = 0;
let cmdCurrentActions = [];

function ensureCommandPaletteDOM() {
  if (document.getElementById('cmd-palette')) return;
  const el = document.createElement('div');
  el.id = 'cmd-palette';
  el.innerHTML = `
    <div class="cmd-box" onclick="event.stopPropagation()">
      <div class="cmd-input-wrap">
        <span class="font-mono text-xs font-bold text-swiss-red">&gt;_</span>
        <input id="cmd-search-input" type="text" placeholder="Ketik nama menu, aksi, atau cari stok barang..." oninput="renderCommandResults()" />
        <span class="cmd-kbd">ESC</span>
      </div>
      <div id="cmd-results"></div>
    </div>
  `;
  el.addEventListener('click', closeCommandPalette);
  document.body.appendChild(el);

  document.getElementById('cmd-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeCommandPalette();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cmdCurrentActions.length > 0) {
        cmdSelectedIndex = (cmdSelectedIndex + 1) % cmdCurrentActions.length;
        highlightCommandItem();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cmdCurrentActions.length > 0) {
        cmdSelectedIndex = (cmdSelectedIndex - 1 + cmdCurrentActions.length) % cmdCurrentActions.length;
        highlightCommandItem();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = cmdCurrentActions[cmdSelectedIndex];
      if (chosen) chosen.run();
    }
  });
}

function openCommandPalette() {
  if (document.getElementById('app-screen')?.classList.contains('hidden')) return;
  ensureCommandPaletteDOM();
  const palette = document.getElementById('cmd-palette');
  const input = document.getElementById('cmd-search-input');
  cmdSelectedIndex = 0;
  input.value = '';
  palette.classList.add('open');
  renderCommandResults();
  setTimeout(() => input.focus(), 20);
}

function closeCommandPalette() {
  document.getElementById('cmd-palette')?.classList.remove('open');
}

function buildCommandList(query) {
  const q = (query || '').trim().toLowerCase();

  const navItems = [
    { group: 'Navigasi Cepat', label: '01 / Dashboard', meta: 'Ringkasan & Grafik', run: () => { switchTab('dashboard'); closeCommandPalette(); } },
    { group: 'Navigasi Cepat', label: '02 / Transaksi & Nota', meta: 'Masuk, Keluar, Opname', run: () => { switchTab('transactions'); closeCommandPalette(); } },
    { group: 'Navigasi Cepat', label: '03 / Master Barang', meta: 'Kelola SKU & Satuan', run: () => { switchTab('items'); closeCommandPalette(); } },
    { group: 'Navigasi Cepat', label: '04 / Stock Opname', meta: 'Blind Count & Draft', run: () => { switchTab('stockopname'); loadStockOpname(); closeCommandPalette(); } },
    { group: 'Navigasi Cepat', label: '05 / Kartu Stok & Arsip', meta: 'Mutasi & Foto Nota', run: () => { switchTab('reports'); loadStockCard(); renderReceiptGallery(); closeCommandPalette(); } },
    { group: 'Navigasi Cepat', label: '06 / Rekap Divisi & Supplier', meta: 'Belanja & Pemakaian', run: () => { switchTab('recap'); loadRecapData(); closeCommandPalette(); } },
    { group: 'Navigasi Cepat', label: '07 / Analisa Harga', meta: 'Bandingkan Supplier', run: () => { switchTab('prices'); loadPriceAnalysis(); closeCommandPalette(); } },
    { group: 'Navigasi Cepat', label: '08 / Harga & Laba', meta: 'Kontrak & Margin', run: () => { switchTab('pricing'); loadPricingAndProfit(); closeCommandPalette(); } },
    { group: 'Navigasi Cepat', label: '09 / Kategori & Partner', meta: 'Master Relasi', run: () => { switchTab('master'); closeCommandPalette(); } },
    { group: 'Navigasi Cepat', label: '10 / Pengaturan', meta: 'White-Label & Drive', run: () => { switchTab('settings'); closeCommandPalette(); } }
  ];

  const quickActions = [
    { group: 'Aksi Cepat', label: '+ Tambah Barang Baru', meta: 'Modal Master', run: () => { switchTab('items'); openItemModal(); closeCommandPalette(); } },
    { group: 'Aksi Cepat', label: '↑ Import Massal Master Barang', meta: 'Excel / CSV', run: () => { switchTab('items'); openImportModal(); closeCommandPalette(); } },
    { group: 'Aksi Cepat', label: '◐ Ganti Light / Dark Mode', meta: 'Tema UI', run: () => { toggleDarkMode(); closeCommandPalette(); } }
  ];

  const stockMatches = q
    ? (state.items || [])
        .filter(i => i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q))
        .slice(0, 6)
        .map(i => ({
          group: 'Cek Stok Instan',
          label: `[${i.sku}] ${i.name}`,
          meta: `Stok: ${formatStockPlain(i)}`,
          run: () => {
            switchTab('reports');
            const sel = document.getElementById('report-item-select');
            if (sel) { sel.value = i.id; loadStockCard(); }
            closeCommandPalette();
          }
        }))
    : [];

  const all = [...navItems, ...quickActions, ...stockMatches];
  if (!q) return all;

  return all.filter(item =>
    item.group === 'Cek Stok Instan' ||
    item.label.toLowerCase().includes(q) ||
    item.meta.toLowerCase().includes(q)
  );
}

function renderCommandResults() {
  const q = document.getElementById('cmd-search-input')?.value || '';
  cmdCurrentActions = buildCommandList(q);
  cmdSelectedIndex = 0;

  const container = document.getElementById('cmd-results');
  if (!container) return;

  if (cmdCurrentActions.length === 0) {
    container.innerHTML = '<div class="p-6 text-center font-mono text-xs text-swiss-muted">Tidak ada hasil yang cocok.</div>';
    return;
  }

  let html = '';
  let lastGroup = '';
  cmdCurrentActions.forEach((act, idx) => {
    if (act.group !== lastGroup) {
      lastGroup = act.group;
      html += `<div class="cmd-group-label">${escapeHtml(act.group)}</div>`;
    }
    html += `
      <div class="cmd-item ${idx === cmdSelectedIndex ? 'selected' : ''}" data-cmd-idx="${idx}" onclick="cmdCurrentActions[${idx}].run()">
        <span>${escapeHtml(act.label)}</span>
        <span class="cmd-kbd">${escapeHtml(act.meta)}</span>
      </div>
    `;
  });
  container.innerHTML = html;
}

function highlightCommandItem() {
  const items = document.querySelectorAll('#cmd-results .cmd-item');
  items.forEach((el, idx) => {
    const active = idx === cmdSelectedIndex;
    el.classList.toggle('selected', active);
    if (active) el.scrollIntoView({ block: 'nearest' });
  });
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const palette = document.getElementById('cmd-palette');
    if (palette && palette.classList.contains('open')) {
      closeCommandPalette();
    } else {
      openCommandPalette();
    }
  }
});

injectSidebarIcons();
// ==========================================
// 14. MANAJEMEN AKUN, REGISTRASI & RBAC
// ==========================================
const ALL_TABS_META = [
  { id: 'dashboard', label: '01 Dashboard' },
  { id: 'transactions', label: '02 Transaksi' },
  { id: 'items', label: '03 Master Barang' },
  { id: 'stockopname', label: '04 Stock Opname' },
  { id: 'reports', label: '05 Kartu Stok' },
  { id: 'recap', label: '06 Rekap Divisi' },
  { id: 'prices', label: '07 Analisa Harga' },
  { id: 'pricing', label: '08 Harga & Laba' },
  { id: 'master', label: '09 Kategori & Partner' },
  { id: 'settings', label: '10 Pengaturan' }
];

function openRegisterModal() {
  document.getElementById('modal-register')?.classList.remove('hidden');
}

function closeRegisterModal() {
  document.getElementById('modal-register')?.classList.add('hidden');
  document.getElementById('register-form')?.reset();
}

async function handleRegister(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-register-submit');
  const fullName = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;

  btn.disabled = true;
  btn.textContent = 'Mendaftarkan...';

  try {
    const { error } = await db.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } }
    });
    if (error) throw error;

    await db.auth.signOut();
    closeRegisterModal();
    showToast('Pendaftaran berhasil! Hubungi Admin untuk aktivasi & pengaturan akses.');
  } catch (err) {
    showToast('Gagal mendaftar: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Kirim Permintaan Akun';
  }
}

function userCanAccessTab(tabId) {
  const p = state.profile;
  if (!p) return false;
  if (p.is_super_admin) return true;
  if (!p.can_view_prices && (tabId === 'prices' || tabId === 'pricing')) return false;
  return Array.isArray(p.allowed_tabs) && p.allowed_tabs.includes(tabId);
}

function applyUserPermissions() {
  const p = state.profile;
  if (!p) return;

  const canViewPrices = p.is_super_admin || p.can_view_prices;
  const canDeleteTx = p.is_super_admin || p.can_delete_tx;

  document.body.classList.toggle('hide-prices', !canViewPrices);
  document.body.classList.toggle('no-delete-tx', !canDeleteTx);

  // Sembunyikan menu sidebar yang tidak diizinkan
  document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
    const allowed = userCanAccessTab(btn.dataset.tab);
    btn.classList.toggle('hidden', !allowed);
  });

  // Tampilkan panel Manajemen Akun hanya untuk Super Admin
  const adminSec = document.getElementById('admin-users-section');
  if (adminSec) {
    adminSec.classList.toggle('hidden', !p.is_super_admin);
    if (p.is_super_admin) loadUserManagement();
  }

  // Jika tidak boleh lihat harga, bersihkan nilai harga di memori browser
  if (!canViewPrices) {
    (state.items || []).forEach(i => {
      i.avg_cost = 0;
      i.selling_price = 0;
      i.box_selling_price = 0;
    });
    const kpiVal = document.getElementById('kpi-stock-value');
    if (kpiVal) kpiVal.textContent = 'Terkunci';
  }

  // Pindahkan ke tab pertama yang diizinkan jika dashboard tidak diizinkan
  if (!userCanAccessTab('dashboard')) {
    const firstAllowed = ALL_TABS_META.find(t => userCanAccessTab(t.id));
    if (firstAllowed) switchTab(firstAllowed.id);
  }
}

async function loadUserManagement() {
  const container = document.getElementById('admin-users-list');
  if (!container || !state.profile?.is_super_admin) return;

  const { data: users, error } = await db
    .from('user_profiles')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) {
    container.innerHTML = `<p class="text-xs font-mono text-swiss-red">Gagal memuat: ${escapeHtml(error.message)}</p>`;
    return;
  }

  if (!users || users.length === 0) {
    container.innerHTML = '<p class="text-xs font-mono text-swiss-muted">Belum ada akun terdaftar.</p>';
    return;
  }

  container.innerHTML = users.map(u => {
    const isMe = u.id === state.user.id;
    const tabs = Array.isArray(u.allowed_tabs) ? u.allowed_tabs : [];

    return `
      <div class="border border-swiss-line rounded-lg p-4 space-y-3 ${!u.is_active ? 'bg-red-50/40' : 'bg-neutral-50/50'}" data-user-card="${u.id}">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-bold text-sm">${escapeHtml(u.full_name || u.email)}</span>
              ${u.is_super_admin
                ? '<span class="px-2 py-0.5 bg-swiss-ink text-white font-mono text-[10px] uppercase">SUPER ADMIN</span>'
                : u.is_active
                  ? '<span class="px-2 py-0.5 bg-swiss-ink text-white font-mono text-[10px] uppercase">AKTIF</span>'
                  : '<span class="px-2 py-0.5 bg-swiss-red text-white font-mono text-[10px] uppercase">PENDING / NONAKTIF</span>'}
            </div>
            <p class="font-mono text-[11px] text-swiss-muted">${escapeHtml(u.email)}</p>
          </div>
          ${isMe ? '<span class="font-mono text-[10px] text-swiss-muted">Akun Anda (Akses Penuh)</span>' : `
            <div class="flex items-center gap-2">
              <button type="button" onclick="saveUserPermissions('${u.id}')" class="bg-swiss-ink text-white px-3 py-1.5 text-xs font-mono font-semibold hover:bg-swiss-red">
                Simpan Izin
              </button>
            </div>
          `}
        </div>

        ${isMe ? '' : `
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-swiss-line text-xs font-mono">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" class="u-active w-4 h-4 accent-black" ${u.is_active ? 'checked' : ''} />
              <span class="font-semibold">Aktifkan Akun</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" class="u-prices w-4 h-4 accent-black" ${u.can_view_prices ? 'checked' : ''} />
              <span>Boleh Lihat Harga / HPP</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" class="u-deltx w-4 h-4 accent-red-600" ${u.can_delete_tx ? 'checked' : ''} />
              <span>Boleh Hapus Transaksi</span>
            </label>
          </div>

          <div class="pt-2 border-t border-swiss-line">
            <p class="font-mono text-[10px] uppercase text-swiss-muted mb-2">Akses Menu Diizinkan:</p>
            <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[11px] font-mono">
              ${ALL_TABS_META.map(t => `
                <label class="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" class="u-tab w-3.5 h-3.5 accent-black" value="${t.id}" ${tabs.includes(t.id) ? 'checked' : ''} />
                  <span>${t.label}</span>
                </label>
              `).join('')}
            </div>
          </div>
        `}
      </div>
    `;
  }).join('');
}

async function saveUserPermissions(userId) {
  const card = document.querySelector(`[data-user-card="${userId}"]`);
  if (!card) return;

  const isActive = card.querySelector('.u-active')?.checked || false;
  const canViewPrices = card.querySelector('.u-prices')?.checked || false;
  const canDeleteTx = card.querySelector('.u-deltx')?.checked || false;
  const allowedTabs = Array.from(card.querySelectorAll('.u-tab:checked')).map(el => el.value);

  const { error } = await db
    .from('user_profiles')
    .update({
      is_active: isActive,
      can_view_prices: canViewPrices,
      can_delete_tx: canDeleteTx,
      allowed_tabs: allowedTabs
    })
    .eq('id', userId);

  if (error) return showToast('Gagal menyimpan izin: ' + error.message, 'error');
  showToast('Hak akses akun berhasil diperbarui!');
  loadUserManagement();
}

// Guard showApp: Cek status aktif & muat profil izin dari Supabase
const _origShowAppRBAC = showApp;
showApp = async function (...args) {
  const { data: authData } = await db.auth.getUser();
  const activeUser = state.user || args[0] || authData?.user;
  if (!activeUser) return;
  state.user = activeUser;

  const { data: profile, error } = await db
    .from('user_profiles')
    .select('*')
    .eq('id', activeUser.id)
    .maybeSingle();

  if (error) {
    await db.auth.signOut();
    showToast('Error profil DB: ' + error.message, 'error');
    document.getElementById('app-screen')?.classList.add('hidden');
    document.getElementById('login-screen')?.classList.remove('hidden');
    return;
  }

  if (!profile || !profile.is_active) {
    await db.auth.signOut();
    showToast('Akun Anda belum aktif / menunggu persetujuan Admin.', 'error');
    document.getElementById('app-screen')?.classList.add('hidden');
    document.getElementById('login-screen')?.classList.remove('hidden');
    return;
  }

  state.profile = profile;
  await _origShowAppRBAC(...args);
  applyUserPermissions();
};

// Guard switchTab: Blokir pindah tab lewat Console/Inspect Element
const _origSwitchTabRBAC = switchTab;
switchTab = function (tabId) {
  if (state.profile && !userCanAccessTab(tabId)) {
    showToast('Anda tidak memiliki izin mengakses menu tersebut.', 'error');
    return;
  }
  _origSwitchTabRBAC(tabId);
};

// Guard Command Palette (Ctrl+K): Sembunyikan menu yang tidak diizinkan
if (typeof buildCommandList === 'function') {
  const _origBuildCmdRBAC = buildCommandList;
  buildCommandList = function (query) {
    const list = _origBuildCmdRBAC(query);
    if (!state.profile || state.profile.is_super_admin) return list;
    return list.filter(item => {
      if (item.group === 'Navigasi Cepat') {
        const match = ALL_TABS_META.find(t => item.label.startsWith(t.label.substring(0, 2)));
        return match ? userCanAccessTab(match.id) : true;
      }
      if (item.label.includes('Tambah Barang') || item.label.includes('Import Massal')) {
        return userCanAccessTab('items');
      }
      return true;
    });
  };
}
// ==========================================
// 15. SEARCHABLE DROPDOWN UNTUK PILIH BARANG
// ==========================================
(function initSearchableItemSelects() {
  let activeSelect = null;
  let activeInput = null;
  let filteredOpts = [];
  let highlightIdx = 0;

  function getFloatingMenu() {
    let menu = document.getElementById('ss-floating-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'ss-floating-menu';
      document.body.appendChild(menu);
    }
    return menu;
  }

  function isItemSelect(sel) {
    if (!sel || sel.tagName !== 'SELECT') return false;
    if (sel.dataset.searchableInit === '1') return false;
    const firstText = sel.options[0]?.textContent || '';
    return /pilih barang/i.test(firstText) || sel.id === 'report-item-select' || sel.options.length > 20;
  }

  function syncInputFromSelect(sel, input) {
    const chosen = sel.options[sel.selectedIndex];
    if (chosen && chosen.value) {
      input.value = chosen.textContent.trim();
    } else {
      input.value = '';
    }
  }

  function positionMenu(input) {
    const menu = getFloatingMenu();
    const rect = input.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const menuWidth = Math.max(rect.width, 320);

    menu.style.width = `${Math.min(menuWidth, window.innerWidth - 24)}px`;
    menu.style.left = `${Math.min(rect.left, window.innerWidth - menuWidth - 12)}px`;

    if (spaceBelow < 220 && rect.top > 240) {
      menu.style.top = 'auto';
      menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    } else {
      menu.style.bottom = 'auto';
      menu.style.top = `${rect.bottom + 4}px`;
    }
  }

  function renderMenu(query) {
    if (!activeSelect || !activeInput) return;
    const menu = getFloatingMenu();
    const terms = (query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);

    filteredOpts = Array.from(activeSelect.options).filter(opt => {
      if (!opt.value) return false;
      if (terms.length === 0) return true;
      const text = opt.textContent.toLowerCase();
      return terms.every(t => text.includes(t));
    });

    highlightIdx = 0;

    if (filteredOpts.length === 0) {
      menu.innerHTML = '<div class="ss-empty">Barang tidak ditemukan.</div>';
    } else {
      const limit = filteredOpts.slice(0, 80);
      menu.innerHTML = limit.map((opt, idx) => `
        <div class="ss-option ${idx === 0 ? 'active' : ''}" data-ss-idx="${idx}">
          ${escapeHtml(opt.textContent.trim())}
        </div>
      `).join('') + (filteredOpts.length > 80
        ? `<div class="ss-empty">Menampilkan 80 dari ${filteredOpts.length} barang — ketik lebih spesifik...</div>`
        : '');

      menu.querySelectorAll('.ss-option').forEach(el => {
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const idx = Number(el.dataset.ssIdx);
          chooseOption(limit[idx]);
        });
      });
    }

    positionMenu(activeInput);
    menu.style.display = 'block';
  }

  function chooseOption(opt) {
    if (!activeSelect || !activeInput || !opt) return;
    activeSelect.value = opt.value;
    activeInput.value = opt.textContent.trim();
    activeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    closeMenu();
  }

  function closeMenu() {
    const menu = getFloatingMenu();
    menu.style.display = 'none';
    if (activeSelect && activeInput) {
      syncInputFromSelect(activeSelect, activeInput);
    }
    activeSelect = null;
    activeInput = null;
  }

  function highlightOption() {
    const menu = getFloatingMenu();
    const items = menu.querySelectorAll('.ss-option');
    items.forEach((el, idx) => {
      const on = idx === highlightIdx;
      el.classList.toggle('active', on);
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function enhanceSelect(sel) {
    sel.dataset.searchableInit = '1';

    const wrap = document.createElement('div');
    wrap.className = 'ss-wrap';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = (sel.className || 'swiss-input text-xs').replace(/\bcart-item\b/g, '').trim() + ' ss-input';
    input.placeholder = 'Ketik nama / SKU barang...';
    input.autocomplete = 'off';

    const arrow = document.createElement('span');
    arrow.className = 'ss-arrow';
    arrow.textContent = '▼';

    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(input);
    wrap.appendChild(arrow);
    wrap.appendChild(sel);
    sel.style.display = 'none';

    syncInputFromSelect(sel, input);

    // Sinkronkan tampilan jika nilai select berubah dari kode (misal Ctrl+K atau reset form)
    sel.addEventListener('change', () => {
      if (activeSelect !== sel) syncInputFromSelect(sel, input);
    });

    const form = sel.closest('form');
    if (form) {
      form.addEventListener('reset', () => {
        setTimeout(() => syncInputFromSelect(sel, input), 10);
      });
    }

    input.addEventListener('focus', () => {
      activeSelect = sel;
      activeInput = input;
      input.select();
      renderMenu('');
    });

    input.addEventListener('input', () => {
      activeSelect = sel;
      activeInput = input;
      renderMenu(input.value);
    });

    input.addEventListener('keydown', (e) => {
      const menu = getFloatingMenu();
      const maxLen = Math.min(filteredOpts.length, 80);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (maxLen > 0) {
          highlightIdx = (highlightIdx + 1) % maxLen;
          highlightOption();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (maxLen > 0) {
          highlightIdx = (highlightIdx - 1 + maxLen) % maxLen;
          highlightOption();
        }
      } else if (e.key === 'Enter' && menu.style.display === 'block') {
        e.preventDefault();
        if (filteredOpts[highlightIdx]) {
          chooseOption(filteredOpts[highlightIdx]);
        }
      } else if (e.key === 'Escape') {
        closeMenu();
        input.blur();
      }
    });

    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (activeInput === input) closeMenu();
      }, 120);
    });
  }

  function scanAndEnhance() {
    document.querySelectorAll('select').forEach(sel => {
      if (isItemSelect(sel)) enhanceSelect(sel);
    });
  }

  // Pantau otomatis saat baris baru ditambahkan (+ Tambah Baris Barang) atau data selesai dimuat
  const observer = new MutationObserver(() => scanAndEnhance());
  observer.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('resize', () => {
    if (activeInput) positionMenu(activeInput);
  });
  window.addEventListener('scroll', (e) => {
    if (activeInput && e.target?.id !== 'ss-floating-menu') {
      positionMenu(activeInput);
    }
  }, true);

  setTimeout(scanAndEnhance, 300);
})();
// ==========================================
// 16. PELACAKAN PIUTANG & CICILAN CUSTOMER
// ==========================================
let arCache = [];
let arCurrentTxId = null;

function arCanAccess() {
  return Boolean(state.profile && (state.profile.is_super_admin || state.profile.can_view_prices));
}

function arFmtRp(val) {
  return 'Rp ' + Math.round(Number(val || 0)).toLocaleString('id-ID');
}

function arCalcTotal(tx) {
  if (tx.total_amount != null && Number(tx.total_amount) > 0) return Number(tx.total_amount);
  const items = tx.transaction_items || [];
  return items.reduce((sum, it) => {
    const qty = Number(it.quantity ?? it.qty ?? 0);
    const price = Number(it.unit_price ?? it.price ?? 0);
    const sub = it.subtotal ?? it.total_price ?? (qty * price);
    return sum + (Number(sub) || 0);
  }, 0);
}

function arCalcPaid(tx, total) {
  const pays = tx.transaction_payments || [];
  const sumPays = pays.reduce((s, p) => s + Number(p.amount || 0), 0);
  if (tx.payment_status === 'PAID') return Math.max(sumPays, Number(tx.paid_amount || 0), total);
  return sumPays > 0 ? sumPays : Number(tx.paid_amount || 0);
}

function arGetRef(tx) {
  return tx.reference_no || tx.invoice_no || tx.tx_number || tx.code || ('OUT-' + String(tx.id).slice(0, 6).toUpperCase());
}

function arGetCustomer(tx) {
  if (tx.partners?.name) return tx.partners.name;
  if (tx.partner_name) return tx.partner_name;
  const p = (state.partners || []).find(x => x.id === tx.partner_id);
  return p ? p.name : 'Customer Umum';
}

// 1) Sisipkan pilihan Status Pembayaran & Jatuh Tempo saat memilih STOK KELUAR
function toggleARFormBox() {
  const box = document.getElementById('tx-ar-box');
  const typeSelect = document.getElementById('tx-type');
  if (!box || !typeSelect) return;
  const isOut = typeSelect.value === 'OUT';
  box.classList.toggle('hidden', !isOut || !arCanAccess());
}

function injectARFormControls() {
  const tabTx = document.getElementById('tab-transactions');
  if (!tabTx) return;

  if (document.getElementById('tx-ar-box')) {
    toggleARFormBox();
    return;
  }

  const typeSelect = document.getElementById('tx-type')
    || Array.from(tabTx.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.value === 'OUT'));
  if (!typeSelect) return;

  const box = document.createElement('div');
  box.id = 'tx-ar-box';
  box.className = 'hidden grid grid-cols-1 sm:grid-cols-2 gap-3 p-3.5 border border-swiss-ink bg-neutral-50 rounded-lg my-3';
  box.innerHTML = `
    <div>
      <label class="block font-mono text-[10px] uppercase mb-1 text-swiss-muted">Status Pembayaran Customer</label>
      <select id="tx-ar-status" class="swiss-input text-xs font-semibold">
        <option value="UNPAID">PIUTANG (Belum Lunas / Tempo)</option>
        <option value="PAID">LUNAS (Tunai / Transfer Langsung)</option>
      </select>
    </div>
    <div>
      <label class="block font-mono text-[10px] uppercase mb-1 text-swiss-muted">Jatuh Tempo (Opsional)</label>
      <input type="date" id="tx-ar-due-date" class="swiss-input text-xs" />
    </div>
  `;

  // Sisipkan tepat di bawah baris pertama (Jenis Transaksi / Tanggal / No Bukti)
  const firstGrid = typeSelect.closest('.grid');
  if (firstGrid && firstGrid.parentNode) {
    firstGrid.parentNode.insertBefore(box, firstGrid.nextSibling);
  } else {
    const cartRows = document.getElementById('cart-rows');
    if (cartRows && cartRows.parentNode) {
      cartRows.parentNode.insertBefore(box, cartRows);
    }
  }

  typeSelect.addEventListener('change', toggleARFormBox);
  toggleARFormBox();
}

// 2) Otomatis sisipkan status piutang saat menyimpan transaksi STOK KELUAR
(function hookARInsert() {
  if (typeof db === 'undefined' || !db || db.__arHooked) return;
  db.__arHooked = true;
  const _origFrom = db.from.bind(db);
  db.from = function (table) {
    const builder = _origFrom(table);
    if (table === 'transactions') {
      const _origInsert = builder.insert.bind(builder);
      builder.insert = function (values, options) {
        const statusEl = document.getElementById('tx-ar-status');
        const dueEl = document.getElementById('tx-ar-due-date');
        const cartTotal = Array.from(document.querySelectorAll('.cart-subtotal'))
          .reduce((s, el) => s + (Number(el.value) || 0), 0);

        const applyRow = (r) => {
          if (r && r.type === 'OUT') {
            const st = statusEl ? statusEl.value : 'UNPAID';
            const total = Number(r.total_amount || cartTotal || 0);
            return {
              ...r,
              payment_status: st,
              paid_amount: st === 'PAID' ? total : 0,
              due_date: (st === 'UNPAID' && dueEl && dueEl.value) ? dueEl.value : null
            };
          }
          return r;
        };
        const patched = Array.isArray(values) ? values.map(applyRow) : applyRow(values);
        const res = _origInsert(patched, options);
        setTimeout(() => { if (arCanAccess()) loadARData(); }, 900);
        return res;
      };
    }
    return builder;
  };
})();

// 3) Muat data Piutang & Cicilan dari Supabase
async function loadARData() {
  if (!arCanAccess()) return;
  const { data, error } = await db
    .from('transactions')
    .select('*, partners(*), transaction_items(*), transaction_payments(*)')
    .eq('type', 'OUT')
    .order('transaction_date', { ascending: false });

  if (error) {
    console.warn('AR Load Error:', error.message);
    return;
  }

  arCache = (data || []).map(tx => {
    const total = arCalcTotal(tx);
    const paid = arCalcPaid(tx, total);
    const remaining = Math.max(0, total - paid);
    let status = tx.payment_status || 'PAID';
    if (remaining <= 0 && total > 0) status = 'PAID';
    else if (paid > 0 && remaining > 0) status = 'PARTIAL';
    else if (remaining > 0) status = 'UNPAID';

    return {
      ...tx,
      _ref: arGetRef(tx),
      _customer: arGetCustomer(tx),
      _total: total,
      _paid: paid,
      _remaining: remaining,
      _status: status
    };
  });

  renderARKpiCard();
  renderARPanel();
}

// 4) Kartu KPI Piutang di Dashboard
function renderARKpiCard() {
  if (!arCanAccess()) return;
  const dash = document.getElementById('tab-dashboard');
  if (!dash) return;

  const kpiGrid = dash.querySelector('.grid');
  if (!kpiGrid) return;

  let card = document.getElementById('kpi-ar-card');
  if (!card) {
    card = document.createElement('div');
    card.id = 'kpi-ar-card';
    card.className = 'bg-white border border-swiss-ink p-4 cursor-pointer';
    card.title = 'Klik untuk membuka Rekap Piutang Instansi';
    card.onclick = () => {
      switchTab('recap');
      setTimeout(() => document.getElementById('ar-panel-section')?.scrollIntoView({ behavior: 'smooth' }), 100);
    };
    kpiGrid.appendChild(card);
  }

  const openList = arCache.filter(x => x._remaining > 0);
  const totalPiutang = openList.reduce((s, x) => s + x._remaining, 0);

  card.innerHTML = `
    <p class="font-mono text-[10px] uppercase tracking-wider text-swiss-red font-semibold">Piutang Belum Lunas</p>
    <p class="text-2xl font-extrabold font-mono mt-1 text-swiss-red">${arFmtRp(totalPiutang)}</p>
    <p class="font-mono text-[10px] text-swiss-muted mt-1">${openList.length} nota aktif • Klik kelola →</p>
  `;
}

// 5) Panel Rekap Piutang & Cicilan di Tab 06 / Rekap Divisi & Toko
function ensureARPanelDOM() {
  const recapTab = document.getElementById('tab-recap');
  if (!recapTab || document.getElementById('ar-panel-section')) return;

  const sec = document.createElement('div');
  sec.id = 'ar-panel-section';
  sec.className = 'bg-white border border-swiss-ink p-5 space-y-4 mb-6';
  sec.innerHTML = `
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-swiss-line pb-3">
      <div>
        <p class="font-mono text-[10px] uppercase text-swiss-red font-semibold">Kontrol Tagihan & Termin</p>
        <h3 class="font-bold text-sm uppercase tracking-wider">Pelacakan Piutang Customer / Instansi</h3>
      </div>
      <div class="flex flex-wrap gap-2">
        <select id="ar-filter-status" onchange="renderARPanel()" class="swiss-input text-xs py-1.5 w-auto">
          <option value="OPEN">Belum Lunas (Piutang & Sebagian)</option>
          <option value="ALL">Semua Nota Keluar</option>
          <option value="PAID">Sudah Lunas</option>
        </select>
        <select id="ar-filter-customer" onchange="renderARPanel()" class="swiss-input text-xs py-1.5 w-auto">
          <option value="">Semua Instansi / Customer</option>
        </select>
        <button type="button" onclick="exportARCSV()" class="border border-swiss-ink bg-white px-3 py-1.5 text-xs font-mono font-semibold hover:bg-neutral-100">
          ↓ Export Piutang CSV
        </button>
      </div>
    </div>

    <div id="ar-customer-chips" class="flex flex-wrap gap-2"></div>

    <div class="overflow-x-auto">
      <table class="w-full text-left border-collapse text-xs">
        <thead>
          <tr class="border-b border-swiss-ink bg-neutral-50 font-mono text-[10px] uppercase">
            <th class="p-2.5">Tanggal & Nota</th>
            <th class="p-2.5">Instansi / Customer</th>
            <th class="p-2.5 text-right">Total Nota</th>
            <th class="p-2.5 text-right">Terbayar</th>
            <th class="p-2.5 text-right">Sisa Piutang</th>
            <th class="p-2.5 text-center">Status</th>
            <th class="p-2.5 text-right">Aksi</th>
          </tr>
        </thead>
        <tbody id="ar-table-body" class="divide-y divide-swiss-line"></tbody>
      </table>
    </div>
  `;

  // Sisipkan tepat setelah judul halaman di tab-recap
  const firstChild = recapTab.firstElementChild;
  if (firstChild && firstChild.nextSibling) {
    recapTab.insertBefore(sec, firstChild.nextSibling);
  } else {
    recapTab.prepend(sec);
  }
}

function renderARPanel() {
  if (!arCanAccess()) return;
  ensureARPanelDOM();

  const statusFilter = document.getElementById('ar-filter-status')?.value || 'OPEN';
  const custSelect = document.getElementById('ar-filter-customer');
  const currentCust = custSelect?.value || '';

  // Isi opsi dropdown instansi
  if (custSelect) {
    const names = Array.from(new Set(arCache.map(x => x._customer))).sort();
    custSelect.innerHTML = '<option value="">Semua Instansi / Customer</option>' +
      names.map(n => `<option value="${escapeHtml(n)}" ${n === currentCust ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
  }

  // Rekap chip instansi yang masih punya piutang
  const chipsEl = document.getElementById('ar-customer-chips');
  if (chipsEl) {
    const byCust = {};
    arCache.filter(x => x._remaining > 0).forEach(x => {
      byCust[x._customer] = (byCust[x._customer] || 0) + x._remaining;
    });
    const entries = Object.entries(byCust).sort((a, b) => b[1] - a[1]);
    chipsEl.innerHTML = entries.length === 0
      ? '<span class="font-mono text-[11px] text-swiss-muted">Semua nota keluar di sistem baru sudah lunas.</span>'
      : entries.map(([name, amt]) => `
          <button type="button" onclick="selectARCustomer('${escapeHtml(name).replace(/'/g, "\\'")}')"
            class="border border-swiss-line px-2.5 py-1 rounded text-[11px] font-mono hover:border-swiss-red ${currentCust === name ? 'bg-swiss-ink text-white' : 'bg-neutral-50'}">
            ${escapeHtml(name)}: <strong>${arFmtRp(amt)}</strong>
          </button>
        `).join('');
  }

  const rows = arCache.filter(x => {
    if (statusFilter === 'OPEN' && x._remaining <= 0) return false;
    if (statusFilter === 'PAID' && x._remaining > 0) return false;
    if (currentCust && x._customer !== currentCust) return false;
    return true;
  });

  const tbody = document.getElementById('ar-table-body');
  if (!tbody) return;

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="p-5 text-center font-mono text-xs text-swiss-muted">Tidak ada nota pada filter ini.</td></tr>';
    return;
  }

  const today = new Date().toISOString().split('T')[0];

  tbody.innerHTML = rows.map(tx => {
    const isOverdue = tx._remaining > 0 && tx.due_date && tx.due_date < today;
    const badge = tx._status === 'PAID'
      ? '<span class="px-2 py-0.5 bg-swiss-ink text-white font-mono text-[10px] uppercase">LUNAS</span>'
      : tx._status === 'PARTIAL'
        ? '<span class="px-2 py-0.5 bg-amber-500 text-white font-mono text-[10px] uppercase">SEBAGIAN</span>'
        : '<span class="px-2 py-0.5 bg-swiss-red text-white font-mono text-[10px] uppercase">PIUTANG</span>';

    const dueInfo = tx.due_date
      ? `<div class="font-mono text-[10px] ${isOverdue ? 'text-swiss-red font-bold' : 'text-swiss-muted'}">Tempo: ${tx.due_date}${isOverdue ? ' (LEWAT)' : ''}</div>`
      : '';

    return `
      <tr class="hover:bg-neutral-50">
        <td class="p-2.5 font-mono">
          <div class="font-semibold">${escapeHtml(tx._ref)}</div>
          <div class="text-[10px] text-swiss-muted">${escapeHtml((tx.transaction_date || '').substring(0, 10))}</div>
        </td>
        <td class="p-2.5">
          <div class="font-semibold">${escapeHtml(tx._customer)}</div>
          ${dueInfo}
        </td>
        <td class="p-2.5 text-right font-mono">${arFmtRp(tx._total)}</td>
        <td class="p-2.5 text-right font-mono text-emerald-600">${arFmtRp(tx._paid)}</td>
        <td class="p-2.5 text-right font-mono font-bold ${tx._remaining > 0 ? 'text-swiss-red' : ''}">${arFmtRp(tx._remaining)}</td>
        <td class="p-2.5 text-center">${badge}</td>
        <td class="p-2.5 text-right">
          <button type="button" onclick="openARModal('${tx.id}')" class="border border-swiss-ink bg-white px-2.5 py-1 text-[11px] font-mono font-semibold hover:bg-neutral-100">
            ${tx._remaining > 0 ? '+ Bayar / Cicil' : 'Riwayat'}
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function selectARCustomer(name) {
  const sel = document.getElementById('ar-filter-customer');
  if (!sel) return;
  sel.value = sel.value === name ? '' : name;
  renderARPanel();
}

// 6) Modal Riwayat & Input Cicilan
function ensureARModalDOM() {
  if (document.getElementById('modal-ar-payment')) return;
  const el = document.createElement('div');
  el.id = 'modal-ar-payment';
  el.className = 'hidden fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4';
  el.innerHTML = `
    <div class="bg-white border-2 border-swiss-ink w-full max-w-lg max-h-[90vh] overflow-y-auto p-5 space-y-4">
      <div class="flex items-center justify-between border-b border-swiss-line pb-3">
        <div>
          <p class="font-mono text-[10px] uppercase text-swiss-muted">Pembayaran & Cicilan Nota</p>
          <h3 id="ar-modal-title" class="font-extrabold text-base uppercase">-</h3>
        </div>
        <button type="button" onclick="closeARModal()" class="font-mono text-sm font-bold px-2 py-1 hover:text-swiss-red">✕</button>
      </div>

      <div id="ar-modal-summary" class="grid grid-cols-3 gap-2 text-center font-mono text-xs"></div>

      <div>
        <p class="font-mono text-[10px] uppercase text-swiss-muted mb-2">Riwayat Pembayaran / Termin</p>
        <div id="ar-modal-history" class="space-y-1.5 max-h-44 overflow-y-auto"></div>
      </div>

      <form id="ar-payment-form" onsubmit="saveARPayment(event)" class="space-y-3 pt-3 border-t border-swiss-line">
        <p class="font-mono text-[10px] uppercase font-bold text-swiss-red">+ Catat Pembayaran Baru</p>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block font-mono text-[10px] uppercase mb-1">Tanggal Bayar</label>
            <input type="date" id="ar-pay-date" required class="swiss-input text-xs" />
          </div>
          <div>
            <label class="block font-mono text-[10px] uppercase mb-1">Nominal Bayar (Rp)</label>
            <input type="number" id="ar-pay-amount" required min="1" step="any" class="swiss-input text-xs font-mono font-bold" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block font-mono text-[10px] uppercase mb-1">Metode</label>
            <select id="ar-pay-method" class="swiss-input text-xs">
              <option value="Transfer Bank">Transfer Bank</option>
              <option value="SP2D / Kas Daerah">SP2D / Kas Daerah</option>
              <option value="Tunai">Tunai</option>
              <option value="QRIS / Lainnya">QRIS / Lainnya</option>
            </select>
          </div>
          <div>
            <label class="block font-mono text-[10px] uppercase mb-1">Catatan (Opsional)</label>
            <input type="text" id="ar-pay-notes" class="swiss-input text-xs" placeholder="Misal: Termin 1 / Lunas" />
          </div>
        </div>
        <button type="submit" id="btn-ar-save" class="w-full bg-swiss-ink text-white py-2.5 text-xs font-mono font-bold uppercase hover:bg-swiss-red">
          Simpan Pembayaran
        </button>
      </form>
    </div>
  `;
  document.body.appendChild(el);
}

function openARModal(txId) {
  ensureARModalDOM();
  arCurrentTxId = txId;
  const tx = arCache.find(x => x.id === txId);
  if (!tx) return;

  document.getElementById('ar-modal-title').textContent = `${tx._ref} — ${tx._customer}`;
  document.getElementById('ar-modal-summary').innerHTML = `
    <div class="p-2.5 border border-swiss-line rounded bg-neutral-50">
      <div class="text-[10px] text-swiss-muted">TOTAL</div>
      <div class="font-bold mt-0.5">${arFmtRp(tx._total)}</div>
    </div>
    <div class="p-2.5 border border-swiss-line rounded bg-neutral-50">
      <div class="text-[10px] text-swiss-muted">TERBAYAR</div>
      <div class="font-bold mt-0.5 text-emerald-600">${arFmtRp(tx._paid)}</div>
    </div>
    <div class="p-2.5 border border-swiss-line rounded bg-neutral-50">
      <div class="text-[10px] text-swiss-muted">SISA</div>
      <div class="font-bold mt-0.5 text-swiss-red">${arFmtRp(tx._remaining)}</div>
    </div>
  `;

  const canDel = state.profile?.is_super_admin || state.profile?.can_delete_tx;
  const pays = [...(tx.transaction_payments || [])].sort((a, b) => (a.payment_date || '').localeCompare(b.payment_date || ''));
  const histEl = document.getElementById('ar-modal-history');

  if (pays.length === 0) {
    histEl.innerHTML = `<p class="text-xs font-mono text-swiss-muted p-2 border border-dashed border-swiss-line rounded">${tx._status === 'PAID' ? 'Dibayar lunas saat transaksi dibuat.' : 'Belum ada cicilan tercatat.'}</p>`;
  } else {
    histEl.innerHTML = pays.map((p, i) => `
      <div class="flex items-center justify-between gap-2 p-2 border border-swiss-line rounded text-xs">
        <div>
          <span class="font-mono font-bold">#${i + 1} ${escapeHtml(p.payment_date || '')}</span>
          <span class="text-swiss-muted"> • ${escapeHtml(p.method || 'Transfer')}</span>
          ${p.notes ? `<div class="text-[11px] text-swiss-muted">${escapeHtml(p.notes)}</div>` : ''}
        </div>
        <div class="flex items-center gap-2">
          <span class="font-mono font-bold text-emerald-600">${arFmtRp(p.amount)}</span>
          ${canDel ? `<button type="button" onclick="deleteARPayment('${p.id}')" class="text-swiss-red font-mono text-xs px-1.5 hover:underline" title="Hapus pembayaran">✕</button>` : ''}
        </div>
      </div>
    `).join('');
  }

  const form = document.getElementById('ar-payment-form');
  if (tx._remaining <= 0) {
    form.classList.add('hidden');
  } else {
    form.classList.remove('hidden');
    document.getElementById('ar-pay-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('ar-pay-amount').value = Math.round(tx._remaining);
    document.getElementById('ar-pay-notes').value = '';
  }

  document.getElementById('modal-ar-payment').classList.remove('hidden');
}

function closeARModal() {
  document.getElementById('modal-ar-payment')?.classList.add('hidden');
  arCurrentTxId = null;
}

async function syncTransactionARStatus(txId) {
  const tx = arCache.find(x => x.id === txId);
  const total = tx ? tx._total : 0;

  const { data: pays } = await db
    .from('transaction_payments')
    .select('amount')
    .eq('transaction_id', txId);

  const paidSum = (pays || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  let newStatus = 'UNPAID';
  if (total > 0 && paidSum >= total) newStatus = 'PAID';
  else if (paidSum > 0) newStatus = 'PARTIAL';

  await db
    .from('transactions')
    .update({ paid_amount: paidSum, payment_status: newStatus })
    .eq('id', txId);
}

async function saveARPayment(e) {
  e.preventDefault();
  if (!arCurrentTxId) return;
  const tx = arCache.find(x => x.id === arCurrentTxId);
  const amount = Number(document.getElementById('ar-pay-amount').value || 0);
  const payDate = document.getElementById('ar-pay-date').value;
  const method = document.getElementById('ar-pay-method').value;
  const notes = document.getElementById('ar-pay-notes').value.trim();

  if (amount <= 0) return showToast('Nominal pembayaran harus lebih dari 0.', 'error');
  if (tx && amount > tx._remaining + 1) {
    if (!confirm(`Nominal (${arFmtRp(amount)}) melebihi sisa piutang (${arFmtRp(tx._remaining)}). Tetap simpan?`)) return;
  }

  const btn = document.getElementById('btn-ar-save');
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';

  try {
    const { error } = await db.from('transaction_payments').insert({
      transaction_id: arCurrentTxId,
      payment_date: payDate,
      amount,
      method,
      notes,
      created_by: state.user?.id || null
    });
    if (error) throw error;

    await syncTransactionARStatus(arCurrentTxId);
    await loadARData();
    openARModal(arCurrentTxId);
    showToast('Pembayaran berhasil dicatat!');
  } catch (err) {
    showToast('Gagal menyimpan pembayaran: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan Pembayaran';
  }
}

async function deleteARPayment(paymentId) {
  if (!confirm('Hapus catatan pembayaran ini? Saldo piutang akan dikembalikan.')) return;
  const { error } = await db.from('transaction_payments').delete().eq('id', paymentId);
  if (error) return showToast('Gagal menghapus: ' + error.message, 'error');

  await syncTransactionARStatus(arCurrentTxId);
  await loadARData();
  openARModal(arCurrentTxId);
  showToast('Catatan pembayaran dihapus.');
}

function exportARCSV() {
  const openRows = arCache.filter(x => x._remaining > 0);
  if (openRows.length === 0) return showToast('Tidak ada piutang aktif untuk diexport.');

  const header = ['No Nota', 'Tanggal', 'Instansi / Customer', 'Jatuh Tempo', 'Total Nota', 'Terbayar', 'Sisa Piutang', 'Status'];
  const lines = [header.join(',')].concat(openRows.map(r => [
    `"${r._ref}"`,
    `"${(r.transaction_date || '').substring(0, 10)}"`,
    `"${r._customer.replace(/"/g, '""')}"`,
    `"${r.due_date || ''}"`,
    r._total,
    r._paid,
    r._remaining,
    `"${r._status}"`
  ].join(',')));

  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Rekap_Piutang_ATK_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// 7) Integrasi otomatis saat login & pindah tab
const _origShowAppAR = showApp;
showApp = async function (...args) {
  await _origShowAppAR(...args);
  injectARFormControls();
  if (arCanAccess()) await loadARData();
};

const _origSwitchTabAR = switchTab;
switchTab = function (tabId) {
  _origSwitchTabAR(tabId);
  if (tabId === 'transactions') injectARFormControls();
  if (tabId === 'recap' && arCanAccess()) loadARData();
};
// ==========================================
// 17. VEROPSA SUPPLY — MULTI-TENANT, BRANDING & FEATURE FLAGS (2 LAPIS)
// ==========================================
const SUPPLY_TAB_FLAGS = {
  stockopname: 'supply_stock_opname',
  reports:     'supply_kartu_stok',
  recap:       'supply_rekap_divisi',
  prices:      'supply_analisa_harga',
  pricing:     'supply_harga_laba'
};

function supplyHasFeature(flagKey) {
  if (!state.company) return true;
  const f = state.company.features || {};
  if (flagKey === 'supply_katalog_publik') {
    return Boolean(f.supply_katalog_publik ?? f.supply_public_catalog);
  }
  // Flag tambahan (kartu stok & rekap divisi) default aktif bila belum diset eksplisit
  if (flagKey === 'supply_kartu_stok' || flagKey === 'supply_rekap_divisi') {
    return (flagKey in f) ? Boolean(f[flagKey]) : true;
  }
  return Boolean(f[flagKey]);
}

function supplyTabAllowed(tabId) {
  const reqFlag = SUPPLY_TAB_FLAGS[tabId];
  return reqFlag ? supplyHasFeature(reqFlag) : true;
}

function applySupplyBranding(company) {
  if (!company) return;
  const b = company.branding || {};
  const f = company.features || {};
  const integ = company.integrations || {};
  const isWhiteLabel = Boolean(f.custom_whitelabel);
  const primary = b.primary_color || '#EA580C';
  const name = b.company_name || company.slug || 'Veropsa Supply';
  const subtitle = b.app_subtitle || 'Manajemen Stok & Operasional';

  // Sinkronkan ke state.settings agar applyWhiteLabel() & upload Drive ikut data companies
  state.settings = {
    ...(state.settings || {}),
    company_name: name,
    subtitle: subtitle,
    address: b.address || state.settings?.address || '',
    gdrive_script_url: integ.supply_drive_webhook || state.settings?.gdrive_script_url || '',
    gdrive_secret_key: integ.supply_drive_secret || state.settings?.gdrive_secret_key || ''
  };

  // Warna aksen dinamis dari companies.branding.primary_color
  document.documentElement.style.setProperty('--brand-primary', primary);
  let dynStyle = document.getElementById('veropsa-brand-style');
  if (!dynStyle) {
    dynStyle = document.createElement('style');
    dynStyle.id = 'veropsa-brand-style';
    document.head.appendChild(dynStyle);
  }
  dynStyle.textContent = `
    .text-swiss-red { color: ${primary} !important; }
    .bg-swiss-red { background-color: ${primary} !important; }
    .border-swiss-red { border-color: ${primary} !important; }
    .hover\\:bg-swiss-red:hover { background-color: ${primary} !important; }
    .hover\\:text-swiss-red:hover { color: ${primary} !important; }
  `;

  document.title = isWhiteLabel ? `${name} — ${subtitle}` : `${name} • Veropsa Supply`;
  document.querySelectorAll('.brand-name').forEach(el => el.textContent = name);
  document.querySelectorAll('.brand-subtitle').forEach(el => el.textContent = subtitle);
  const loginTitle = document.getElementById('login-company-name');
  if (loginTitle) loginTitle.textContent = name;

  // Ubah label "WHITE-LABEL ERP" sesuai saklar custom_whitelabel
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const txt = node.nodeValue.trim();
    if (/^(WHITE-LABEL ERP|VEROPSA SUPPLY|INVENTORY ERP)$/i.test(txt)) {
      node.nodeValue = node.nodeValue.replace(txt, isWhiteLabel ? 'INVENTORY ERP' : 'VEROPSA SUPPLY');
    }
  }
}

function showSupplyBlockedOverlay(title, message) {
  let ov = document.getElementById('veropsa-blocked-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'veropsa-blocked-overlay';
    ov.className = 'fixed inset-0 z-[9999] bg-[#F7F7F4] flex items-center justify-center p-6';
    document.body.appendChild(ov);
  }
  ov.innerHTML = `
    <div class="bg-white border-2 border-neutral-900 max-w-md w-full p-6 text-center space-y-3">
      <p class="font-mono text-[10px] uppercase tracking-widest text-red-600 font-bold">Akses Dibatasi</p>
      <h2 class="text-xl font-extrabold uppercase">${escapeHtml(title)}</h2>
      <p class="font-mono text-xs text-neutral-600">${escapeHtml(message)}</p>
      <button type="button" onclick="db.auth.signOut().then(() => location.reload())"
        class="mt-2 bg-neutral-900 text-white px-4 py-2 font-mono text-xs uppercase font-bold">
        Keluar Akun
      </button>
    </div>
  `;
}

// Lapis 1: Sembunyikan menu & widget berdasarkan saklar companies.features
function applySupplyFeatureFlagsUI() {
  if (!state.company) return;

  document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
    const tabId = btn.dataset.tab;
    const allowed = supplyTabAllowed(tabId) && (state.profile ? userCanAccessTab(tabId) : true);
    btn.classList.toggle('hidden', !allowed);
  });

  // Jika tab yang sedang terbuka ternyata dimatikan, paksa pindah ke Dashboard
  Object.keys(SUPPLY_TAB_FLAGS).forEach(tabId => {
    if (!supplyTabAllowed(tabId)) {
      const sec = document.getElementById(`tab-${tabId}`);
      if (sec && !sec.classList.contains('hidden')) {
        switchTab('dashboard');
      }
    }
  });

  // Modul Piutang (supply_piutang)
  const piutangOn = supplyHasFeature('supply_piutang');
  ['kpi-ar-card', 'ar-panel-section', 'tx-ar-box'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !piutangOn) el.classList.add('hidden');
  });
}

// Preload branding di layar login hanya jika ada ?c=slug atau custom domain (bukan default vercel.app)
async function preloadSupplyBranding() {
  try {
    const params = new URLSearchParams(window.location.search);
    const slugParam = params.get('c') || params.get('company') || null;
    const host = (window.location.hostname || '').toLowerCase();
    const isCustomDomain = host && !host.endsWith('.vercel.app') && host !== 'localhost' && host !== '127.0.0.1';

    if (!slugParam && !isCustomDomain) return;

    const { data } = await db.rpc('veropsa_resolve_company', {
      p_slug: slugParam,
      p_domain: isCustomDomain ? host : null
    });
    const comp = Array.isArray(data) ? data[0] : data;
    if (comp?.id && comp.features?.supply_enabled) {
      state.preloadedCompany = comp;
      applySupplyBranding(comp);
    }
  } catch (e) {
    console.warn('[Veropsa Supply] Preload branding dilewati:', e.message);
  }
}

// Muat data perusahaan aktif milik user dari user_roles + companies
async function loadActiveSupplyTenant() {
  const { data: authData } = await db.auth.getUser();
  const activeUser = state.user || authData?.user;
  if (!activeUser) return false;
  state.user = activeUser;

  const { data: roles, error } = await db
    .from('user_roles')
    .select('company_id, role, companies(*)')
    .eq('user_id', activeUser.id);

  if (error) {
    console.error('[Veropsa Supply] Error baca user_roles:', error.message);
    showToast('Gagal memuat data perusahaan: ' + error.message, 'error');
    return false;
  }

  if (!roles || roles.length === 0) {
    showSupplyBlockedOverlay('Akun Belum Terdaftar di Perusahaan', 'Hubungi administrator untuk menautkan akun Anda ke perusahaan aktif.');
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  const explicitSlug = (params.get('c') || params.get('company') || '').toLowerCase();
  const host = (window.location.hostname || '').toLowerCase();

  // Prioritas: 1) ?c=slug eksplisit, 2) custom domain supply, 3) tenant aktif yang punya supply_enabled
  const chosen = (explicitSlug ? roles.find(r => r.companies && String(r.companies.slug || '').toLowerCase() === explicitSlug) : null)
    || roles.find(r => r.companies && (
      String(r.companies.domains?.supply || '').toLowerCase() === host ||
      String(r.companies.domain || '').toLowerCase() === host
    ))
    || roles.find(r => r.companies && r.companies.status === 'ACTIVE' && r.companies.features?.supply_enabled)
    || roles[0];

  const company = chosen?.companies;
  if (!company) {
    showSupplyBlockedOverlay('Perusahaan Tidak Ditemukan', 'Data perusahaan untuk akun ini tidak tersedia.');
    return false;
  }

  state.company = company;
  state.companyRole = chosen.role;
  console.log('[Veropsa Supply] Tenant aktif:', company.slug, '| Features:', company.features);

  if (company.status !== 'ACTIVE' || !company.features?.supply_enabled) {
    applySupplyBranding(company);
    showSupplyBlockedOverlay(
      'Layanan Veropsa Supply Nonaktif',
      `Modul Veropsa Supply untuk "${company.branding?.company_name || company.slug}" sedang dinonaktifkan.`
    );
    return false;
  }

  applySupplyBranding(company);
  return true;
}

// Hook 1: Pastikan applyWhiteLabel() selalu memprioritaskan companies.branding
const _origApplyWhiteLabelSupply = applyWhiteLabel;
applyWhiteLabel = function () {
  if (state.company) applySupplyBranding(state.company);
  _origApplyWhiteLabelSupply();
  if (state.company) applySupplyBranding(state.company);
};

// Hook 2 (Lapis 2): Blokir akses tab dari userCanAccessTab() — otomatis memblokir sidebar & switchTab()
const _origUserCanAccessTabSupply = userCanAccessTab;
userCanAccessTab = function (tabId) {
  if (!supplyTabAllowed(tabId)) return false;
  return _origUserCanAccessTabSupply(tabId);
};

// Hook 3 (Lapis 2): Pesan jelas bila user mencoba panggil switchTab() manual lewat Console
const _origSwitchTabSupply = switchTab;
switchTab = function (tabId) {
  if (!supplyTabAllowed(tabId)) {
    showToast('Fitur ini tidak aktif pada paket perusahaan Anda.', 'error');
    return;
  }
  _origSwitchTabSupply(tabId);
  applySupplyFeatureFlagsUI();
};

// Hook 4 (Lapis 2): Sembunyikan fitur OFF dari Command Palette (Ctrl+K) termasuk untuk Admin
const _origBuildCmdSupply = buildCommandList;
buildCommandList = function (query) {
  const list = _origBuildCmdSupply(query);
  return list.filter(item => {
    if (item.group === 'Navigasi Cepat') {
      const match = ALL_TABS_META.find(t => item.label.startsWith(t.label.substring(0, 2)));
      return match ? supplyTabAllowed(match.id) : true;
    }
    return true;
  });
};

// Hook 5 (Lapis 2): Kunci modul Piutang dengan saklar supply_piutang
const _origArCanAccessSupply = arCanAccess;
arCanAccess = function () {
  if (!supplyHasFeature('supply_piutang')) return false;
  return _origArCanAccessSupply();
};

// Hook 6: Jalankan loadActiveSupplyTenant() tepat sebelum showApp() berjalan
const _origShowAppSupply = showApp;
showApp = async function (...args) {
  const ok = await loadActiveSupplyTenant();
  if (!ok) return;
  await _origShowAppSupply(...args);
  applySupplyBranding(state.company);
  applySupplyFeatureFlagsUI();
};

preloadSupplyBranding();
// ==========================================
// 18. AUTO-GENERATE KODE SKU BERDASARKAN KATEGORI
// ==========================================
function generateNextSku(categoryId) {
  const cat = (state.categories || []).find(c => String(c.id) === String(categoryId));
  let prefix = 'BRG';
  if (cat) {
    const rawPrefix = (cat.code_prefix || '').trim() || (cat.name || '').replace(/[^a-zA-Z0-9]/g, '').substring(0, 3);
    if (rawPrefix) prefix = rawPrefix.toUpperCase();
  }

  const regex = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`, 'i');
  const usedSkus = new Set((state.items || []).map(i => String(i.sku || '').trim().toUpperCase()));

  let maxNum = 0;
  usedSkus.forEach(sku => {
    const m = sku.match(regex);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
    }
  });

  let nextNum = maxNum + 1;
  let candidate = `${prefix}-${String(nextNum).padStart(3, '0')}`;
  while (usedSkus.has(candidate)) {
    nextNum++;
    candidate = `${prefix}-${String(nextNum).padStart(3, '0')}`;
  }
  return candidate;
}

(function initAutoSkuGenerator() {
  const skuInput = document.getElementById('item-sku');
  const catSelect = document.getElementById('item-category');
  const idInput = document.getElementById('item-id');
  if (!skuInput || !catSelect) return;

  // Tandai jika user mengetik SKU manual agar tidak tertimpa saat ganti kategori
  skuInput.addEventListener('input', () => {
    skuInput.dataset.manualEdit = skuInput.value.trim() ? '1' : '0';
  });

  // Update SKU otomatis setiap kali ganti kategori (khusus barang baru)
  catSelect.addEventListener('change', () => {
    if (idInput?.value) return;
    if (skuInput.dataset.manualEdit === '1') return;
    skuInput.value = generateNextSku(catSelect.value);
  });

  // Isi SKU otomatis saat modal Tambah Barang Baru dibuka
  if (typeof openItemModal === 'function') {
    const _origOpenItemModal = openItemModal;
    openItemModal = function (itemId = null) {
      _origOpenItemModal(itemId);
      if (!itemId) {
        skuInput.dataset.manualEdit = '0';
        skuInput.value = generateNextSku(catSelect.value);
      } else {
        skuInput.dataset.manualEdit = '1';
      }
    };
  }
})();
// Mulai aplikasi
checkSession();
