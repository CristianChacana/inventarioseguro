const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'inventory-data.json');
const dbTempPath = path.join(__dirname, 'inventory-data.tmp.json');

// Estructura inicial de la base de datos 100% JavaScript (sin C++ ni node-gyp)
const defaultData = {
  counters: {
    users: 0,
    products: 0,
    movements: 0
  },
  users: [],
  sessions: [],
  products: [],
  movements: [],
  system_state: {
    emergency_lockdown: '0'
  }
};

function nowIso() {
  // Devuelve formato YYYY-MM-DD HH:MM:SS compatible con filtros por fecha
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function loadDatabase() {
  try {
    if (fs.existsSync(dbPath)) {
      const raw = fs.readFileSync(dbPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        counters: { ...defaultData.counters, ...(parsed.counters || {}) },
        users: Array.isArray(parsed.users) ? parsed.users : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        products: Array.isArray(parsed.products) ? parsed.products : [],
        movements: Array.isArray(parsed.movements) ? parsed.movements : [],
        system_state: { ...defaultData.system_state, ...(parsed.system_state || {}) }
      };
    }
  } catch (err) {
    console.error('Advertencia al leer inventory-data.json, iniciando estructura limpia:', err.message);
  }
  return JSON.parse(JSON.stringify(defaultData));
}

const state = loadDatabase();

// Guardado atómico en disco (escribe en temporal y renombra para que nunca se corrompa el JSON)
function saveDatabase() {
  const payload = JSON.stringify(state, null, 2);
  fs.writeFileSync(dbTempPath, payload, 'utf8');
  fs.renameSync(dbTempPath, dbPath);
}

// Si el archivo aún no existía, crearlo inmediatamente
if (!fs.existsSync(dbPath)) {
  saveDatabase();
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// Asegurar que el correo de ADMIN_EMAIL esté siempre registrado como administrador activo
function ensureMainAdmin(adminEmail) {
  if (!adminEmail || adminEmail.includes('tu_correo_administrador')) return;
  const cleanEmail = adminEmail.trim().toLowerCase();
  let existing = state.users.find((u) => u.email === cleanEmail);
  if (!existing) {
    state.counters.users += 1;
    state.users.push({
      id: state.counters.users,
      email: cleanEmail,
      name: 'Administrador Principal',
      role: 'admin',
      is_active: 1,
      session_version: 1,
      created_at: nowIso()
    });
    saveDatabase();
  } else if (existing.role !== 'admin' || existing.is_active !== 1) {
    existing.role = 'admin';
    existing.is_active = 1;
    saveDatabase();
  }
}

// ============================================================================
// OPERACIONES DEL MOTOR DE BASE DE DATOS EN JAVASCRIPT PURO
// ============================================================================

const db = {
  isEmergencyLockdown() {
    return state.system_state.emergency_lockdown === '1';
  },

  setEmergencyLockdown(enable, keepTokenHash = null) {
    state.system_state.emergency_lockdown = enable ? '1' : '0';
    if (enable) {
      for (const s of state.sessions) {
        if (s.token_hash !== keepTokenHash) {
          s.revoked = 1;
        }
      }
    }
    saveDatabase();
  },

  // --- Usuarios ---
  getUsersCount() {
    return state.users.length;
  },

  findUserByEmail(email) {
    const clean = String(email || '').trim().toLowerCase();
    return state.users.find((u) => u.email === clean) || null;
  },

  findUserById(id) {
    return state.users.find((u) => u.id === Number(id)) || null;
  },

  createUser({ email, name, role = 'seller', is_active = 1 }) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (this.findUserByEmail(cleanEmail)) {
      throw new Error('Ese correo ya está registrado en el sistema.');
    }
    state.counters.users += 1;
    const newUser = {
      id: state.counters.users,
      email: cleanEmail,
      name: String(name || '').trim() || cleanEmail.split('@')[0],
      role: role === 'admin' ? 'admin' : 'seller',
      is_active: is_active ? 1 : 0,
      session_version: 1,
      created_at: nowIso()
    };
    state.users.push(newUser);
    saveDatabase();
    return newUser;
  },

  updateUserName(userId, newName) {
    const user = this.findUserById(userId);
    if (user) {
      user.name = newName;
      saveDatabase();
    }
  },

  listUsersWithActiveDevices() {
    const now = new Date();
    return [...state.users]
      .sort((a, b) => {
        if (a.role !== b.role) return a.role.localeCompare(b.role);
        return a.email.localeCompare(b.email);
      })
      .map((u) => {
        const activeDevices = state.sessions.filter(
          (s) => s.user_id === u.id && s.revoked === 0 && new Date(s.expires_at) > now
        ).length;
        return { ...u, active_devices: activeDevices };
      });
  },

  blockUserAccount(userId) {
    const user = this.findUserById(userId);
    if (!user) return null;
    user.is_active = 0;
    user.session_version = (user.session_version || 1) + 1;
    for (const s of state.sessions) {
      if (s.user_id === user.id) {
        s.revoked = 1;
      }
    }
    saveDatabase();
    return user;
  },

  activateUserAccount(userId) {
    const user = this.findUserById(userId);
    if (!user) return null;
    user.is_active = 1;
    saveDatabase();
    return user;
  },

  revokeUserSessions(userId) {
    const uid = Number(userId);
    for (const s of state.sessions) {
      if (s.user_id === uid) {
        s.revoked = 1;
      }
    }
    saveDatabase();
  },

  deleteUser(userId) {
    const uid = Number(userId);
    state.sessions = state.sessions.filter((s) => s.user_id !== uid);
    state.users = state.users.filter((u) => u.id !== uid);
    saveDatabase();
  },

  // --- Sesiones ---
  createSession({ tokenHash, userId, userAgent, ipAddress, expiresAt }) {
    state.sessions.push({
      token_hash: tokenHash,
      user_id: Number(userId),
      user_agent: userAgent,
      ip_address: ipAddress,
      created_at: nowIso(),
      expires_at: expiresAt,
      revoked: 0
    });
    saveDatabase();
  },

  getSessionWithUser(tokenHash) {
    const session = state.sessions.find((s) => s.token_hash === tokenHash);
    if (!session) return null;
    const user = this.findUserById(session.user_id);
    if (!user) return null;
    return {
      token_hash: session.token_hash,
      expires_at: session.expires_at,
      revoked: session.revoked,
      user_id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      is_active: user.is_active
    };
  },

  revokeSessionByToken(tokenHash) {
    const session = state.sessions.find((s) => s.token_hash === tokenHash);
    if (session) {
      session.revoked = 1;
      saveDatabase();
    }
  },

  // --- Productos ---
  listProducts(searchQuery = '') {
    const q = String(searchQuery || '').trim().toLowerCase();
    let list = [...state.products];
    if (q) {
      list = list.filter(
        (p) =>
          p.barcode.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q)
      );
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  },

  findProductByBarcode(barcode) {
    const clean = String(barcode || '').trim();
    return state.products.find((p) => p.barcode === clean) || null;
  },

  // --- Operaciones Transaccionales (En Memoria + Volcado Atómico) ---
  recordSale({ items, notes, user, operationGroupId }) {
    // 1. Validar todo antes de modificar nada (atomicidad completa)
    const validatedItems = [];
    for (const item of items) {
      const barcode = String(item.barcode || '').trim();
      const quantity = Number(item.quantity);

      if (!barcode || !Number.isInteger(quantity) || quantity <= 0) {
        throw new Error(`Cantidad inválida para el código ${barcode || 'desconocido'}.`);
      }

      const product = this.findProductByBarcode(barcode);
      if (!product) {
        throw new Error(`El producto con código ${barcode} no existe en el inventario.`);
      }

      if (product.stock < quantity) {
        throw new Error(
          `Stock insuficiente para "${product.name}" (Código: ${barcode}). Disponible: ${product.stock}, solicitado: ${quantity}.`
        );
      }

      validatedItems.push({ product, quantity });
    }

    // 2. Aplicar descuentos de stock y registrar movimientos
    let grandTotal = 0;
    const processed = [];

    for (const { product, quantity } of validatedItems) {
      const unitPrice = Number(product.sale_price);
      const totalPrice = Number((unitPrice * quantity).toFixed(2));
      const stockBefore = product.stock;
      const stockAfter = stockBefore - quantity;

      product.stock = stockAfter;
      product.updated_at = nowIso();

      state.counters.movements += 1;
      state.movements.push({
        id: state.counters.movements,
        operation_group_id: operationGroupId,
        type: 'VENTA',
        product_id: product.id,
        barcode: product.barcode,
        product_name: product.name,
        quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
        stock_before: stockBefore,
        stock_after: stockAfter,
        user_id: user.id,
        user_email: user.email,
        user_name: user.name,
        notes: notes ? String(notes).trim() : null,
        created_at: nowIso()
      });

      grandTotal = Number((grandTotal + totalPrice).toFixed(2));
      processed.push({
        barcode: product.barcode,
        name: product.name,
        quantity,
        unitPrice,
        totalPrice,
        stockAfter
      });
    }

    saveDatabase();
    return { operationGroupId, grandTotal, processed };
  },

  recordAdminInventoryOp({
    operationType,
    barcode,
    name,
    quantity,
    costPrice,
    salePrice,
    notes,
    user,
    operationGroupId
  }) {
    let product = this.findProductByBarcode(barcode);

    if (!product) {
      if (operationType === 'AJUSTE_RESTA') {
        throw new Error('No se puede restar stock a un producto que aún no está registrado.');
      }
      if (salePrice === null || isNaN(salePrice)) {
        throw new Error('Para un producto nuevo es obligatorio indicar el precio de venta.');
      }
      state.counters.products += 1;
      product = {
        id: state.counters.products,
        barcode,
        name,
        cost_price: costPrice !== null && !isNaN(costPrice) ? costPrice : 0,
        sale_price: salePrice,
        stock: 0,
        updated_at: nowIso()
      };
      state.products.push(product);
    }

    const stockBefore = product.stock;
    let stockAfter = stockBefore;

    if (operationType === 'COMPRA' || operationType === 'AJUSTE_SUMA') {
      stockAfter = stockBefore + quantity;
    } else if (operationType === 'AJUSTE_RESTA') {
      if (stockBefore < quantity) {
        throw new Error(`No puedes restar ${quantity} unidades porque el stock actual es de ${stockBefore}.`);
      }
      stockAfter = stockBefore - quantity;
    }

    const finalCostPrice = costPrice !== null && !isNaN(costPrice) ? costPrice : product.cost_price;
    const finalSalePrice = salePrice !== null && !isNaN(salePrice) ? salePrice : product.sale_price;

    product.name = name;
    product.cost_price = finalCostPrice;
    product.sale_price = finalSalePrice;
    product.stock = stockAfter;
    product.updated_at = nowIso();

    const unitPriceForRecord = operationType === 'COMPRA' ? finalCostPrice : finalSalePrice;
    const totalPriceForRecord = Number((unitPriceForRecord * quantity).toFixed(2));

    state.counters.movements += 1;
    state.movements.push({
      id: state.counters.movements,
      operation_group_id: operationGroupId,
      type: operationType,
      product_id: product.id,
      barcode,
      product_name: name,
      quantity,
      unit_price: unitPriceForRecord,
      total_price: totalPriceForRecord,
      stock_before: stockBefore,
      stock_after: stockAfter,
      user_id: user.id,
      user_email: user.email,
      user_name: user.name,
      notes: notes ? String(notes).trim() : null,
      created_at: nowIso()
    });

    saveDatabase();
    return { ...product };
  },

  // --- Historial de Movimientos con Filtros por Fecha, Usuario y Tipo ---
  listMovements({ startDate, endDate, userEmail, type }) {
    let list = [...state.movements];

    if (startDate) {
      const start = String(startDate).slice(0, 10);
      list = list.filter((m) => String(m.created_at).slice(0, 10) >= start);
    }
    if (endDate) {
      const end = String(endDate).slice(0, 10);
      list = list.filter((m) => String(m.created_at).slice(0, 10) <= end);
    }
    if (userEmail) {
      const cleanEmail = String(userEmail).trim().toLowerCase();
      list = list.filter((m) => m.user_email.toLowerCase() === cleanEmail);
    }
    if (type) {
      list = list.filter((m) => m.type === type);
    }

    return list
      .sort((a, b) => {
        if (b.created_at !== a.created_at) return b.created_at.localeCompare(a.created_at);
        return b.id - a.id;
      })
      .slice(0, 500);
  }
};

module.exports = {
  db,
  ensureMainAdmin,
  hashToken
};
