let currentUser = null;
let activeTab = 'tab-pos';
let posCart = [];
let html5QrCode = null;
let isScanning = false;

// Doble verificación de lectura de código de barras para máxima precisión en cámara
let lastDetectedCode = null;
let consecutiveDetections = 0;

window.addEventListener('DOMContentLoaded', async () => {
  checkUrlErrors();
  await checkSession();

  const manualInput = document.getElementById('manual-barcode-input');
  if (manualInput) {
    manualInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        processBarcodeInput();
      }
    });
  }

  const demoInput = document.getElementById('demo-email-input');
  if (demoInput) {
    demoInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        demoLogin();
      }
    });
  }
});

function showAlert(message, type = 'error') {
  const alertEl = document.getElementById('global-alert');
  alertEl.textContent = message;
  alertEl.className = `alert ${type === 'success' ? 'alert-success' : 'alert-error'}`;
  alertEl.style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  setTimeout(() => {
    alertEl.style.display = 'none';
  }, 6500);
}

function checkUrlErrors() {
  const params = new URLSearchParams(window.location.search);
  const err = params.get('error');
  const email = params.get('email');
  if (!err) return;

  const messages = {
    unauthorized_email: `La cuenta Gmail ${email || ''} no está autorizada. Pídele al administrador que la agregue en la pestaña de Cuentas.`,
    account_blocked: 'Esta cuenta Gmail fue bloqueada o desactivada por el administrador por seguridad.',
    emergency_lockdown: 'La aplicación se encuentra en Bloqueo de Emergencia activado por la administradora.',
    oauth_not_configured: 'Falta configurar GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el archivo .env del servidor.',
    invalid_oauth_state: 'La sesión de inicio con Google caducó, intenta de nuevo.',
    oauth_failed: 'No se pudo completar el inicio de sesión con Google.'
  };

  showAlert(messages[err] || 'Error de autenticación.', 'error');
  window.history.replaceState({}, document.title, '/');
}

async function checkSession() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) {
      await showLoginScreen();
      return;
    }
    const data = await res.json();
    currentUser = data.user;
    updateLockdownBanner(data.emergencyLockdown);
    renderAuthenticatedApp();
  } catch (err) {
    await showLoginScreen();
  }
}

async function showLoginScreen() {
  document.getElementById('app-header').style.display = 'none';
  document.getElementById('main-view').style.display = 'none';
  document.getElementById('login-view').style.display = 'block';

  try {
    const res = await fetch('/api/auth/config-status');
    const cfg = await res.json();
    if (cfg.demoModeAllowed) {
      document.getElementById('demo-login-box').style.display = 'block';
    }
  } catch (_) {}
}

async function demoLogin() {
  const email = document.getElementById('demo-email-input').value.trim();
  if (!email) {
    return showAlert('Escribe tu correo Gmail para entrar.', 'error');
  }
  const res = await fetch('/api/auth/demo-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  const data = await res.json();
  if (!res.ok) {
    return showAlert(data.error || 'No se pudo iniciar sesión.', 'error');
  }
  await checkSession();
}

async function logout() {
  await stopCameraScanner();
  await fetch('/api/auth/logout', { method: 'POST' });
  currentUser = null;
  posCart = [];
  await showLoginScreen();
}

function updateLockdownBanner(isLocked) {
  document.getElementById('lockdown-banner').style.display = isLocked ? 'block' : 'none';
}

function renderAuthenticatedApp() {
  document.getElementById('login-view').style.display = 'none';
  document.getElementById('app-header').style.display = 'flex';
  document.getElementById('main-view').style.display = 'block';

  document.getElementById('user-email-label').textContent = currentUser.email;
  const badge = document.getElementById('user-role-badge');
  if (currentUser.role === 'admin') {
    badge.textContent = 'Administrador';
    badge.className = 'badge badge-admin';
  } else {
    badge.textContent = 'Vendedor';
    badge.className = 'badge badge-seller';
  }

  document.querySelectorAll('.admin-only').forEach((el) => {
    el.style.display = currentUser.role === 'admin' ? '' : 'none';
  });

  switchTab('tab-pos');
  loadCatalog();
}

function switchTab(tabId) {
  activeTab = tabId;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  document.querySelectorAll('.tab-section').forEach((sec) => {
    sec.style.display = sec.id === tabId ? 'block' : 'none';
  });

  // Mostrar el lector de código de barras en Venta y en Compras/Ajustes
  const scannerCard = document.getElementById('shared-scanner-card');
  if (tabId === 'tab-pos' || tabId === 'tab-admin-inv') {
    scannerCard.style.display = 'block';
  } else {
    scannerCard.style.display = 'none';
    stopCameraScanner();
  }

  if (tabId === 'tab-catalog') loadCatalog();
  if (tabId === 'tab-history') loadMovements();
  if (tabId === 'tab-security') loadUsers();
}

// ============================================================================
// ESCÁNER DE CÓDIGO DE BARRAS CON DOBLE LECTURA CUIDADOSA Y SONIDO BEEP
// ============================================================================

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  } catch (_) {}
}

function setScannerStatus(text, show = true) {
  const el = document.getElementById('scanner-status');
  el.textContent = text;
  el.style.display = show ? 'block' : 'none';
}

async function startCameraScanner() {
  if (isScanning) return;
  const scannerBox = document.getElementById('scanner-box');
  scannerBox.style.display = 'block';
  document.getElementById('btn-start-camera').style.display = 'none';
  document.getElementById('btn-stop-camera').style.display = 'inline-flex';

  lastDetectedCode = null;
  consecutiveDetections = 0;
  setScannerStatus('Apunta al código de barras... Analizando con doble verificación para máxima exactitud.');

  html5QrCode = new Html5Qrcode('scanner-box');
  isScanning = true;

  try {
    await html5QrCode.start(
      { facingMode: 'environment' },
      {
        fps: 12,
        qrbox: { width: 260, height: 140 }
      },
      async (decodedText) => {
        const cleanCode = decodedText.trim();
        if (!cleanCode) return;

        // Requerir 2 lecturas idénticas seguidas para descartar lecturas borrosas
        if (cleanCode === lastDetectedCode) {
          consecutiveDetections += 1;
        } else {
          lastDetectedCode = cleanCode;
          consecutiveDetections = 1;
          setScannerStatus(`Verificando nitidez del código ${cleanCode} (1/2)... Mantén firme el celular.`);
          return;
        }

        if (consecutiveDetections >= 2) {
          playBeep();
          await stopCameraScanner();
          document.getElementById('manual-barcode-input').value = cleanCode;
          setScannerStatus(`✅ Código leído y verificado con éxito: ${cleanCode}`, true);
          await handleVerifiedBarcode(cleanCode);
        }
      },
      () => {}
    );
  } catch (err) {
    isScanning = false;
    scannerBox.style.display = 'none';
    document.getElementById('btn-start-camera').style.display = 'inline-flex';
    document.getElementById('btn-stop-camera').style.display = 'none';
    setScannerStatus('', false);
    showAlert('No se pudo acceder a la cámara del celular. Asegúrate de dar permiso a la cámara o escribe los números manualmente.', 'error');
  }
}

async function stopCameraScanner() {
  if (!isScanning || !html5QrCode) return;
  try {
    await html5QrCode.stop();
    await html5QrCode.clear();
  } catch (_) {}
  isScanning = false;
  document.getElementById('scanner-box').style.display = 'none';
  document.getElementById('btn-start-camera').style.display = 'inline-flex';
  document.getElementById('btn-stop-camera').style.display = 'none';
}

// Analizar foto tomada con el celular con máximo cuidado (Local + Backend)
async function handlePhotoInput(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  setScannerStatus('🔍 Analizando la imagen con máximo cuidado...');

  try {
    const tempScanner = new Html5Qrcode('scanner-box');
    const decodedText = await tempScanner.scanFile(file, false);
    const cleanCode = decodedText.trim();
    playBeep();
    document.getElementById('manual-barcode-input').value = cleanCode;
    setScannerStatus(`✅ Código extraído de la foto: ${cleanCode}`);
    await handleVerifiedBarcode(cleanCode);
    event.target.value = '';
    return;
  } catch (_) {
    // Si el decodificador local no logra leer una etiqueta difícil, consulta al backend
    try {
      const base64 = await fileToBase64(file);
      const res = await fetch('/api/scanner/analyze-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64 })
      });
      const data = await res.json();
      if (res.ok && data.barcode) {
        playBeep();
        document.getElementById('manual-barcode-input').value = data.barcode;
        setScannerStatus(`✅ Código detectado (${data.confidence}): ${data.barcode}`);
        await handleVerifiedBarcode(data.barcode, data.suggestedName);
      } else {
        setScannerStatus('', false);
        showAlert(
          data.error || 'No se pudo distinguir el código en la foto. Acerca más la cámara o escribe los números manualmente.',
          'error'
        );
      }
    } catch (err) {
      setScannerStatus('', false);
      showAlert('No se encontró un código nítido en la foto. Ingresa los números manualmente.', 'error');
    }
  }
  event.target.value = '';
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function processBarcodeInput() {
  const code = document.getElementById('manual-barcode-input').value.trim();
  if (!code) {
    return showAlert('Escribe o escanea los números del código de barras primero.', 'error');
  }
  await handleVerifiedBarcode(code);
}

// ============================================================================
// FLUJO AL DETECTAR O ESCRIBIR UN CÓDIGO DE BARRAS (CON PREGUNTA Y CONFIRMACIÓN)
// ============================================================================

async function handleVerifiedBarcode(barcode, suggestedName = '') {
  const res = await fetch(`/api/products/barcode/${encodeURIComponent(barcode)}`);
  if (res.status === 401 || res.status === 403 || res.status === 423) {
    const errData = await res.json();
    showAlert(errData.error || 'Sesión finalizada por seguridad.', 'error');
    await checkSession();
    return;
  }

  const data = await res.json();

  // Si estamos en la pestaña de Compras / Ajustes del Administrador
  if (activeTab === 'tab-admin-inv' && currentUser.role === 'admin') {
    document.getElementById('adm-barcode').value = barcode;
    if (data.found && data.product) {
      document.getElementById('adm-name').value = data.product.name;
      document.getElementById('adm-cost').value = data.product.cost_price;
      document.getElementById('adm-sale').value = data.product.sale_price;
      showAlert(
        `Producto encontrado: "${data.product.name}" (Stock actual: ${data.product.stock}). Verifica el nombre y cantidad y presiona Guardar.`,
        'success'
      );
    } else {
      document.getElementById('adm-name').value = suggestedName || '';
      document.getElementById('adm-name').focus();
      showAlert(
        `Código ${barcode} nuevo. Por favor escribe el nombre del producto y sus precios para registrarlo.`,
        'success'
      );
    }
    return;
  }

  // Si estamos en Punto de Venta
  if (!data.found || !data.product) {
    if (currentUser.role === 'admin') {
      openConfirmModal(
        'Producto no registrado aún',
        `<p>El código <strong>${escapeHtml(barcode)}</strong> no existe en el inventario.</p>
         <p style="margin-top:8px;">¿Deseas pasar a la pestaña de <strong>Compras / Ajustar Stock</strong> para escribir el nombre del producto y darlo de alta?</p>`,
        () => {
          switchTab('tab-admin-inv');
          document.getElementById('adm-barcode').value = barcode;
          document.getElementById('adm-name').value = suggestedName || '';
          document.getElementById('adm-name').focus();
        }
      );
    } else {
      showAlert(
        `El código ${barcode} no está registrado en el inventario. Solicita al administrador que lo ingrese en Compras.`,
        'error'
      );
    }
    return;
  }

  const p = data.product;
  // Preguntar confirmación antes de agregar al carrito de venta
  openConfirmModal(
    '¿Es correcto este producto para la venta?',
    `<p><strong>Código leído:</strong> ${escapeHtml(p.barcode)}</p>
     <p><strong>Nombre del producto:</strong> ${escapeHtml(p.name)}</p>
     <p><strong>Precio unitario:</strong> $${Number(p.sale_price).toFixed(2)}</p>
     <p><strong>Stock disponible:</strong> ${p.stock} unidades</p>
     <div class="form-group" style="margin-top:10px;">
       <label>Cantidad a vender:</label>
       <input type="number" id="modal-sale-qty" min="1" max="${p.stock}" value="1" />
     </div>`,
    () => {
      const qtyInput = document.getElementById('modal-sale-qty');
      const qty = Number(qtyInput ? qtyInput.value : 1);
      if (!Number.isInteger(qty) || qty <= 0) {
        return showAlert('Ingresa una cantidad válida mayor a 0.', 'error');
      }
      addProductToPosCart(p, qty);
      document.getElementById('manual-barcode-input').value = '';
    }
  );
}

async function lookupProductForAdmin(barcode) {
  const clean = (barcode || '').trim();
  if (!clean) return;
  const res = await fetch(`/api/products/barcode/${encodeURIComponent(clean)}`);
  if (!res.ok) return;
  const data = await res.json();
  if (data.found && data.product) {
    document.getElementById('adm-name').value = data.product.name;
    document.getElementById('adm-cost').value = data.product.cost_price;
    document.getElementById('adm-sale').value = data.product.sale_price;
  }
}

// ============================================================================
// CARRITO DE PUNTO DE VENTA Y CONFIRMACIÓN DE VENTA
// ============================================================================

function addProductToPosCart(product, qtyToAdd) {
  const existing = posCart.find((item) => item.barcode === product.barcode);
  const newQty = (existing ? existing.quantity : 0) + qtyToAdd;

  if (newQty > product.stock) {
    return showAlert(
      `No hay suficiente stock de "${product.name}". Disponible: ${product.stock}.`,
      'error'
    );
  }

  if (existing) {
    existing.quantity = newQty;
  } else {
    posCart.push({
      barcode: product.barcode,
      name: product.name,
      unitPrice: Number(product.sale_price),
      quantity: qtyToAdd,
      maxStock: product.stock
    });
  }

  renderPosCart();
}

function updateCartQty(barcode, newQty) {
  const qty = Number(newQty);
  const item = posCart.find((i) => i.barcode === barcode);
  if (!item) return;

  if (qty <= 0) {
    posCart = posCart.filter((i) => i.barcode !== barcode);
  } else if (qty > item.maxStock) {
    showAlert(`Stock máximo disponible para "${item.name}": ${item.maxStock}`, 'error');
    item.quantity = item.maxStock;
  } else {
    item.quantity = qty;
  }
  renderPosCart();
}

function removeFromCart(barcode) {
  posCart = posCart.filter((i) => i.barcode !== barcode);
  renderPosCart();
}

function clearCart() {
  posCart = [];
  renderPosCart();
}

function renderPosCart() {
  const tbody = document.getElementById('pos-cart-body');
  const totalEl = document.getElementById('pos-grand-total');

  if (posCart.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--muted);">Aún no hay productos en la venta. Escanea o escribe un código arriba.</td></tr>`;
    totalEl.textContent = '$0.00';
    return;
  }

  let grandTotal = 0;
  tbody.innerHTML = posCart
    .map((item) => {
      const subtotal = item.unitPrice * item.quantity;
      grandTotal += subtotal;
      return `
        <tr>
          <td>${escapeHtml(item.barcode)}</td>
          <td><strong>${escapeHtml(item.name)}</strong></td>
          <td>$${item.unitPrice.toFixed(2)}</td>
          <td>
            <input type="number" min="1" max="${item.maxStock}" value="${item.quantity}"
              style="width:70px; padding:6px;"
              onchange="updateCartQty('${escapeHtml(item.barcode)}', this.value)" />
          </td>
          <td><strong>$${subtotal.toFixed(2)}</strong></td>
          <td>
            <button class="btn btn-danger btn-sm" onclick="removeFromCart('${escapeHtml(item.barcode)}')">✕</button>
          </td>
        </tr>
      `;
    })
    .join('');

  totalEl.textContent = `$${grandTotal.toFixed(2)}`;
}

function requestSaleConfirmation() {
  if (posCart.length === 0) {
    return showAlert('Agrega al menos un producto antes de confirmar la venta.', 'error');
  }

  let grandTotal = 0;
  const lines = posCart
    .map((item) => {
      const sub = item.unitPrice * item.quantity;
      grandTotal += sub;
      return `<li><strong>${item.quantity}x ${escapeHtml(item.name)}</strong> (${escapeHtml(item.barcode)}) — $${sub.toFixed(2)}</li>`;
    })
    .join('');

  openConfirmModal(
    '¿Confirmas que esta VENTA es correcta?',
    `<p>Por favor verifica cuidadosamente cada producto y el total antes de descontar del inventario:</p>
     <ul style="margin:10px 0 10px 18px;">${lines}</ul>
     <p style="font-size:1.15rem; margin-top:8px;"><strong>TOTAL A COBRAR: $${grandTotal.toFixed(2)}</strong></p>
     <p style="color:var(--muted); font-size:0.82rem; margin-top:6px;">Vendedor: ${escapeHtml(currentUser.email)}</p>`,
    async () => {
      const notes = document.getElementById('pos-notes').value.trim();
      const res = await fetch('/api/operations/sale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: posCart.map((i) => ({ barcode: i.barcode, quantity: i.quantity })),
          notes,
          confirmedByUser: true
        })
      });
      const data = await res.json();
      if (!res.ok) {
        return showAlert(data.error || 'Error al registrar la venta.', 'error');
      }
      posCart = [];
      document.getElementById('pos-notes').value = '';
      renderPosCart();
      loadCatalog();
      showAlert(`✅ Venta registrada correctamente. Total cobrado: $${Number(data.grandTotal).toFixed(2)}`, 'success');
    }
  );
}

// ============================================================================
// COMPRAS Y AJUSTES DEL ADMINISTRADOR (CON CONFIRMACIÓN OBLIGATORIA)
// ============================================================================

function requestAdminInventoryConfirmation() {
  const operationType = document.getElementById('adm-op-type').value;
  const barcode = document.getElementById('adm-barcode').value.trim();
  const name = document.getElementById('adm-name').value.trim();
  const quantity = Number(document.getElementById('adm-qty').value);
  const costPrice = document.getElementById('adm-cost').value;
  const salePrice = document.getElementById('adm-sale').value;
  const notes = document.getElementById('adm-notes').value.trim();

  if (!barcode) return showAlert('Ingresa o escanea el código de barras.', 'error');
  if (!name) return showAlert('Por favor escribe o confirma el nombre del producto.', 'error');
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return showAlert('La cantidad debe ser un número entero mayor a 0.', 'error');
  }

  const opLabels = {
    COMPRA: 'COMPRA DE MERCADERÍA (Suma al inventario)',
    AJUSTE_SUMA: 'AJUSTE POSITIVO (Suma al inventario)',
    AJUSTE_RESTA: 'AJUSTE NEGATIVO / MERMA (Resta del inventario)'
  };

  openConfirmModal(
    '¿Confirmas que esta operación de inventario es correcta?',
    `<p><strong>Operación:</strong> ${opLabels[operationType]}</p>
     <p><strong>Código de Barras:</strong> ${escapeHtml(barcode)}</p>
     <p><strong>Nombre del Producto:</strong> ${escapeHtml(name)}</p>
     <p><strong>Cantidad de Unidades:</strong> ${quantity}</p>
     ${costPrice !== '' ? `<p><strong>Costo Unitario:</strong> $${Number(costPrice).toFixed(2)}</p>` : ''}
     ${salePrice !== '' ? `<p><strong>Precio de Venta:</strong> $${Number(salePrice).toFixed(2)}</p>` : ''}
     ${notes ? `<p><strong>Nota:</strong> ${escapeHtml(notes)}</p>` : ''}`,
    async () => {
      const res = await fetch('/api/operations/admin-inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationType,
          barcode,
          name,
          quantity,
          costPrice,
          salePrice,
          notes,
          confirmedByUser: true
        })
      });
      const data = await res.json();
      if (!res.ok) {
        return showAlert(data.error || 'No se pudo guardar el movimiento.', 'error');
      }
      document.getElementById('adm-qty').value = '1';
      document.getElementById('adm-notes').value = '';
      loadCatalog();
      showAlert(
        `✅ Movimiento guardado. "${data.product.name}" ahora tiene ${data.product.stock} unidades en stock.`,
        'success'
      );
    }
  );
}

// ============================================================================
// CATÁLOGO, HISTORIAL POR FECHA Y GESTIÓN DE SEGURIDAD / CELULARES ROBADOS
// ============================================================================

async function loadCatalog() {
  const q = document.getElementById('catalog-search')?.value || '';
  const res = await fetch(`/api/products?q=${encodeURIComponent(q)}`);
  if (!res.ok) return;
  const data = await res.json();
  const tbody = document.getElementById('catalog-body');

  if (!data.products || data.products.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--muted);">No hay productos registrados.</td></tr>`;
    return;
  }

  tbody.innerHTML = data.products
    .map(
      (p) => `
      <tr>
        <td>${escapeHtml(p.barcode)}</td>
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td>$${Number(p.sale_price).toFixed(2)}</td>
        <td><strong>${p.stock}</strong> uds.</td>
      </tr>
    `
    )
    .join('');
}

async function loadMovements() {
  if (currentUser.role !== 'admin') return;
  const startDate = document.getElementById('hist-start').value;
  const endDate = document.getElementById('hist-end').value;
  const type = document.getElementById('hist-type').value;
  const userEmail = document.getElementById('hist-email').value.trim();

  const params = new URLSearchParams();
  if (startDate) params.set('startDate', startDate);
  if (endDate) params.set('endDate', endDate);
  if (type) params.set('type', type);
  if (userEmail) params.set('userEmail', userEmail);

  const res = await fetch(`/api/admin/movements?${params.toString()}`);
  if (!res.ok) return;
  const data = await res.json();
  const tbody = document.getElementById('history-body');

  if (!data.movements || data.movements.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--muted);">No se encontraron movimientos en ese filtro.</td></tr>`;
    return;
  }

  tbody.innerHTML = data.movements
    .map(
      (m) => `
      <tr>
        <td>${escapeHtml(m.created_at)}</td>
        <td><strong>${escapeHtml(m.user_name)}</strong><br/><span style="color:var(--muted);font-size:0.78rem;">${escapeHtml(m.user_email)}</span></td>
        <td><span class="badge ${m.type === 'VENTA' ? 'badge-seller' : 'badge-admin'}">${escapeHtml(m.type)}</span></td>
        <td><strong>${escapeHtml(m.product_name)}</strong><br/><span style="color:var(--muted);font-size:0.78rem;">${escapeHtml(m.barcode)}</span></td>
        <td>${m.quantity}</td>
        <td>$${Number(m.total_price).toFixed(2)}</td>
        <td>${m.stock_before} → <strong>${m.stock_after}</strong></td>
      </tr>
    `
    )
    .join('');
}

async function loadUsers() {
  if (currentUser.role !== 'admin') return;
  const res = await fetch('/api/admin/users');
  if (!res.ok) return;
  const data = await res.json();
  updateLockdownBanner(data.emergencyLockdown);

  const tbody = document.getElementById('users-body');
  tbody.innerHTML = data.users
    .map((u) => {
      const activeBadge = u.is_active
        ? `<span class="badge" style="background:var(--success);">Activa</span>`
        : `<span class="badge badge-danger">BLOQUEADA</span>`;

      return `
        <tr>
          <td>
            <strong>${escapeHtml(u.name)}</strong><br/>
            <span style="color:var(--muted); font-size:0.8rem;">${escapeHtml(u.email)}</span>
          </td>
          <td>${u.role === 'admin' ? 'Administrador' : 'Vendedor'}</td>
          <td>${activeBadge}</td>
          <td><strong>${u.active_devices}</strong> sesión(es) activa(s)</td>
          <td>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              ${
                u.is_active
                  ? `<button class="btn btn-danger btn-sm" onclick="securityUserAction(${u.id}, 'block_account', '${escapeHtml(u.email)}')">🛑 Bloquear Cuenta y Celular</button>`
                  : `<button class="btn btn-success btn-sm" onclick="securityUserAction(${u.id}, 'activate_account', '${escapeHtml(u.email)}')">✅ Reactivar Cuenta</button>`
              }
              <button class="btn btn-warning btn-sm" onclick="securityUserAction(${u.id}, 'revoke_sessions', '${escapeHtml(u.email)}')">📱 Cerrar Sesiones</button>
              ${
                u.id !== currentUser.id
                  ? `<button class="btn btn-outline btn-sm" onclick="securityUserAction(${u.id}, 'delete_user', '${escapeHtml(u.email)}')">🗑️ Quitar</button>`
                  : ''
              }
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

async function addAuthorizedUser() {
  const email = document.getElementById('new-user-email').value.trim();
  const name = document.getElementById('new-user-name').value.trim();
  const role = document.getElementById('new-user-role').value;

  if (!email) return showAlert('Ingresa el correo Gmail.', 'error');

  const res = await fetch('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name, role })
  });
  const data = await res.json();
  if (!res.ok) {
    return showAlert(data.error || 'Error al agregar usuario.', 'error');
  }

  document.getElementById('new-user-email').value = '';
  document.getElementById('new-user-name').value = '';
  loadUsers();
  showAlert(`✅ Cuenta Gmail ${data.user.email} autorizada con éxito.`, 'success');
}

function securityUserAction(userId, action, email) {
  const descriptions = {
    block_account: `¿Confirmas BLOQUEAR la cuenta ${email} y expulsar inmediatamente cualquier celular donde tenga sesión abierta?`,
    activate_account: `¿Confirmas reactivar el acceso para ${email}?`,
    revoke_sessions: `¿Confirmas cerrar todas las sesiones abiertas de ${email} en celulares o computadoras?`,
    delete_user: `¿Confirmas eliminar la cuenta ${email} de la lista de autorizados?`
  };

  openConfirmModal('Confirmar Acción de Seguridad', `<p>${descriptions[action]}</p>`, async () => {
    const res = await fetch(`/api/admin/users/${userId}/security-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    const data = await res.json();
    if (!res.ok) {
      return showAlert(data.error || 'Error al aplicar la acción de seguridad.', 'error');
    }
    loadUsers();
    showAlert(data.message, 'success');
  });
}

function toggleEmergencyLockdown(enable) {
  const msg = enable
    ? `<p><strong>¿ACTIVAR BLOQUEO TOTAL DE EMERGENCIA?</strong></p>
       <p style="margin-top:8px;">Esto cerrará al instante las sesiones abiertas en <strong>todos los celulares</strong> (incluido tu celular robado) y bloqueará las ventas hasta que lo desactives.</p>`
    : `<p>¿Deseas desactivar el Bloqueo de Emergencia para que los vendedores autorizados puedan volver a operar?</p>`;

  openConfirmModal('Bloqueo de Emergencia', msg, async () => {
    const res = await fetch('/api/admin/emergency-lockdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable })
    });
    const data = await res.json();
    if (!res.ok) {
      return showAlert(data.error || 'No se pudo cambiar el estado de emergencia.', 'error');
    }
    updateLockdownBanner(data.emergencyLockdown);
    loadUsers();
    showAlert(data.message, 'success');
  });
}

// ============================================================================
// MODAL REUTILIZABLE DE CONFIRMACIÓN
// ============================================================================

function openConfirmModal(title, htmlBody, onConfirm) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = htmlBody;
  const modal = document.getElementById('confirm-modal');
  modal.style.display = 'flex';

  const confirmBtn = document.getElementById('modal-confirm-btn');
  const newBtn = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);

  newBtn.addEventListener('click', async () => {
    closeConfirmModal();
    await onConfirm();
  });
}

function closeConfirmModal() {
  document.getElementById('confirm-modal').style.display = 'none';
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
