require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');
const { db, ensureMainAdmin, hashToken } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Inicializar administrador principal desde variable de entorno
ensureMainAdmin(process.env.ADMIN_EMAIL);

// Configurar cabeceras de seguridad (Helmet)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:"],
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'"]
      }
    }
  })
);

app.use(express.json({ limit: '6mb' })); // Permite envío de foto en base64 al backend para análisis cuidadoso
app.use(cookieParser(process.env.SESSION_SECRET || 'clave-local-temporal-cambiar-en-prod'));

// Limitador de peticiones para evitar fuerza bruta
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones desde esta dirección IP, intenta de nuevo en unos minutos.' }
});
app.use('/api/', apiLimiter);

// Cliente OAuth2 de Google (todo el flujo ocurre en el backend)
function getGoogleClient() {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/auth/google/callback`
  );
}

// Middleware de autenticación: verifica en CADA petición que la sesión exista, no esté revocada y la cuenta esté activa
function requireAuth(req, res, next) {
  const rawToken = req.signedCookies.inv_session;
  if (!rawToken) {
    return res.status(401).json({ error: 'No has iniciado sesión.' });
  }

  const tokenHash = hashToken(rawToken);
  const session = db.getSessionWithUser(tokenHash);

  if (!session || session.revoked === 1) {
    res.clearCookie('inv_session');
    return res.status(401).json({
      error: 'Tu sesión fue cerrada o revocada por el administrador por seguridad.'
    });
  }

  if (new Date(session.expires_at) < new Date()) {
    res.clearCookie('inv_session');
    return res.status(401).json({ error: 'Tu sesión ha expirado. Vuelve a iniciar sesión con tu cuenta Gmail.' });
  }

  if (session.is_active !== 1) {
    res.clearCookie('inv_session');
    return res.status(403).json({
      error: 'Tu cuenta ha sido suspendida o bloqueada por el administrador.'
    });
  }

  // Si el sistema está en Bloqueo de Emergencia, ningún vendedor puede operar
  if (db.isEmergencyLockdown() && session.role !== 'admin') {
    return res.status(423).json({
      error: 'SISTEMA EN BLOQUEO DE EMERGENCIA. La administradora ha bloqueado temporalmente la aplicación por seguridad.'
    });
  }

  req.user = {
    id: session.user_id,
    email: session.email,
    name: session.name,
    role: session.role
  };
  req.tokenHash = tokenHash;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acceso exclusivo para administradores.' });
  }
  next();
}

// Helper para crear sesión segura con cookie HttpOnly
function createSessionForUser(res, req, user) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 días

  db.createSession({
    tokenHash,
    userId: user.id,
    userAgent: (req.headers['user-agent'] || 'Desconocido').slice(0, 250),
    ipAddress: req.ip || '0.0.0.0',
    expiresAt
  });

  res.cookie('inv_session', rawToken, {
    httpOnly: true, // Imposible de leer desde JavaScript en el navegador (protección total XSS)
    signed: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

// ============================================================================
// RUTAS DE AUTENTICACIÓN GOOGLE OAUTH 2.0 (100% EN BACKEND)
// ============================================================================

app.get('/api/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID.includes('tu_google_client_id')) {
    return res.redirect('/?error=oauth_not_configured');
  }

  const client = getGoogleClient();
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, { httpOnly: true, signed: true, maxAge: 10 * 60 * 1000 });

  const authorizeUrl = client.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
    state
  });

  res.redirect(authorizeUrl);
});

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const savedState = req.signedCookies.oauth_state;
    res.clearCookie('oauth_state');

    if (!code || !state || state !== savedState) {
      return res.redirect('/?error=invalid_oauth_state');
    }

    const client = getGoogleClient();
    const { tokens } = await client.getToken(code);
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email || !payload.email_verified) {
      return res.redirect('/?error=unverified_email');
    }

    const email = payload.email.trim().toLowerCase();
    ensureMainAdmin(process.env.ADMIN_EMAIL);

    // Verificar si el correo Gmail está en la lista blanca
    const user = db.findUserByEmail(email);

    if (!user) {
      return res.redirect(`/?error=unauthorized_email&email=${encodeURIComponent(email)}`);
    }

    if (user.is_active !== 1) {
      return res.redirect('/?error=account_blocked');
    }

    if (db.isEmergencyLockdown() && user.role !== 'admin') {
      return res.redirect('/?error=emergency_lockdown');
    }

    // Actualizar nombre de Google si estaba genérico
    if (payload.name && user.name !== payload.name) {
      db.updateUserName(user.id, payload.name);
      user.name = payload.name;
    }

    createSessionForUser(res, req, user);
    res.redirect('/');
  } catch (err) {
    console.error('Error en autenticación con Google:', err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// Ruta para pruebas locales únicamente si ALLOW_DEMO_LOGIN=true en .env
app.post('/api/auth/demo-login', (req, res) => {
  if (process.env.ALLOW_DEMO_LOGIN !== 'true') {
    return res.status(403).json({
      error: 'El modo demostración está desactivado. Usa el botón de Iniciar sesión con Google.'
    });
  }
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Ingresa un correo Gmail.' });

  const cleanEmail = email.trim().toLowerCase();
  let user = db.findUserByEmail(cleanEmail);

  // Si la base de datos de usuarios está vacía en modo demo, el primer correo entra como admin
  if (!user && db.getUsersCount() === 0) {
    user = db.createUser({
      email: cleanEmail,
      name: 'Admin Demo',
      role: 'admin',
      is_active: 1
    });
  }

  if (!user) {
    return res.status(403).json({
      error: `El correo ${cleanEmail} no tiene permiso para acceder al sistema. Pídele al administrador que lo autorice.`
    });
  }

  if (user.is_active !== 1) {
    return res.status(403).json({ error: 'Esta cuenta fue desactivada o bloqueada por robo/pérdida.' });
  }

  if (db.isEmergencyLockdown() && user.role !== 'admin') {
    return res.status(423).json({ error: 'Sistema bloqueado por emergencia por la administradora.' });
  }

  createSessionForUser(res, req, user);
  res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    user: req.user,
    emergencyLockdown: db.isEmergencyLockdown(),
    demoModeAllowed: process.env.ALLOW_DEMO_LOGIN === 'true'
  });
});

app.get('/api/auth/config-status', (req, res) => {
  res.json({
    demoModeAllowed: process.env.ALLOW_DEMO_LOGIN === 'true',
    googleConfigured: Boolean(
      process.env.GOOGLE_CLIENT_ID && !process.env.GOOGLE_CLIENT_ID.includes('tu_google_client_id')
    )
  });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  db.revokeSessionByToken(req.tokenHash);
  res.clearCookie('inv_session');
  res.json({ ok: true });
});

// ============================================================================
// RUTAS DE INVENTARIO Y ESCÁNER CON ANÁLISIS CUIDADOSO
// ============================================================================

app.get('/api/products', requireAuth, (req, res) => {
  const search = (req.query.q || '').trim();
  const products = db.listProducts(search);
  res.json({ products });
});

app.get('/api/products/barcode/:barcode', requireAuth, (req, res) => {
  const barcode = (req.params.barcode || '').trim();
  if (!barcode) {
    return res.status(400).json({ error: 'Código de barras vacío.' });
  }
  const product = db.findProductByBarcode(barcode);
  res.json({
    found: Boolean(product),
    barcode,
    product: product || null
  });
});

// Analizar imagen de código de barras en el backend (con Gemini Vision si está configurado en el servidor)
app.post('/api/scanner/analyze-image', requireAuth, async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'No se recibió ninguna imagen para analizar.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(501).json({
        error: 'El análisis asistido por IA en servidor es opcional y requiere GEMINI_API_KEY en el archivo .env del backend. Usa el escáner en vivo de la cámara o ingresa los números manualmente.'
      });
    }

    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: 'Analiza con el máximo cuidado esta imagen de un producto o etiqueta. Extrae únicamente los dígitos exactos del código de barras (EAN, UPC o código numérico impreso) y, si es visible, el nombre sugerido del producto. Responde estrictamente en JSON con el formato {"barcode": "SOLO_DIGITOS_O_VACIO", "suggestedName": "NOMBRE_SUGERIDO_O_VACIO", "confidence": "ALTA|MEDIA|BAJA"}.'
                },
                {
                  inline_data: {
                    mime_type: 'image/jpeg',
                    data: base64Data
                  }
                }
              ]
            }
          ],
          generationConfig: {
            responseMimeType: 'application/json'
          }
        })
      }
    );

    if (!response.ok) {
      return res.status(502).json({ error: 'No se pudo procesar la imagen en el servidor.' });
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(rawText);
    const barcode = String(parsed.barcode || '').trim();
    const existingProduct = barcode ? db.findProductByBarcode(barcode) : null;

    res.json({
      barcode,
      suggestedName: parsed.suggestedName || '',
      confidence: parsed.confidence || 'MEDIA',
      existingProduct: existingProduct || null
    });
  } catch (err) {
    console.error('Error al analizar imagen:', err.message);
    res.status(500).json({ error: 'Error al analizar la imagen en el servidor.' });
  }
});

// ============================================================================
// OPERACIONES DE INVENTARIO (VENTAS Y COMPRAS/AJUSTES CON CONFIRMACIÓN)
// ============================================================================

app.post('/api/operations/sale', requireAuth, (req, res) => {
  const { items, notes, confirmedByUser } = req.body;

  if (confirmedByUser !== true) {
    return res.status(400).json({
      error: 'Por seguridad, debes confirmar explícitamente que los productos, cantidades y precios de la venta son correctos.'
    });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Debes agregar al menos un producto a la venta.' });
  }

  const operationGroupId = `VENTA-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  try {
    const result = db.recordSale({
      items,
      notes,
      user: req.user,
      operationGroupId
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/operations/admin-inventory', requireAuth, requireAdmin, (req, res) => {
  const {
    operationType, // 'COMPRA', 'AJUSTE_SUMA', 'AJUSTE_RESTA'
    barcode,
    name,
    quantity,
    costPrice,
    salePrice,
    notes,
    confirmedByUser
  } = req.body;

  if (confirmedByUser !== true) {
    return res.status(400).json({
      error: 'Debes confirmar que el nombre del producto, código de barras y cantidades son correctos antes de guardar.'
    });
  }

  const allowedTypes = ['COMPRA', 'AJUSTE_SUMA', 'AJUSTE_RESTA'];
  if (!allowedTypes.includes(operationType)) {
    return res.status(400).json({ error: 'Tipo de operación inválido.' });
  }

  const cleanBarcode = String(barcode || '').trim();
  const cleanName = String(name || '').trim();
  const qty = Number(quantity);

  if (!cleanBarcode) {
    return res.status(400).json({ error: 'El código de barras es obligatorio.' });
  }
  if (!cleanName) {
    return res.status(400).json({ error: 'El nombre del producto es obligatorio.' });
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: 'La cantidad debe ser un número entero mayor a 0.' });
  }

  const parsedCost = costPrice !== undefined && costPrice !== '' ? Number(costPrice) : null;
  const parsedSale = salePrice !== undefined && salePrice !== '' ? Number(salePrice) : null;

  if ((parsedCost !== null && parsedCost < 0) || (parsedSale !== null && parsedSale < 0)) {
    return res.status(400).json({ error: 'Los precios no pueden ser negativos.' });
  }

  const operationGroupId = `${operationType}-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  try {
    const updatedProduct = db.recordAdminInventoryOp({
      operationType,
      barcode: cleanBarcode,
      name: cleanName,
      quantity: qty,
      costPrice: parsedCost,
      salePrice: parsedSale,
      notes,
      user: req.user,
      operationGroupId
    });
    res.json({ ok: true, operationGroupId, product: updatedProduct });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================================
// HISTORIAL DE MOVIMIENTOS POR FECHA, USUARIO Y TIPO (SOLO ADMINISTRADOR)
// ============================================================================

app.get('/api/admin/movements', requireAuth, requireAdmin, (req, res) => {
  const { startDate, endDate, userEmail, type } = req.query;
  const movements = db.listMovements({ startDate, endDate, userEmail, type });
  res.json({ movements });
});

// ============================================================================
// GESTIÓN DE CUENTAS GMAIL Y SEGURIDAD ANTIRROBO (SOLO ADMINISTRADOR)
// ============================================================================

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  res.json({
    users: db.listUsersWithActiveDevices(),
    emergencyLockdown: db.isEmergencyLockdown()
  });
});

app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const { email, name, role } = req.body;
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!cleanEmail || !cleanEmail.includes('@')) {
    return res.status(400).json({ error: 'Ingresa un correo Gmail válido.' });
  }

  try {
    const newUser = db.createUser({ email: cleanEmail, name, role, is_active: 1 });
    res.json({ ok: true, user: newUser });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/users/:id/security-action', requireAuth, requireAdmin, (req, res) => {
  const targetUserId = Number(req.params.id);
  const { action } = req.body; // 'block_account', 'activate_account', 'revoke_sessions', 'delete_user'

  const targetUser = db.findUserById(targetUserId);
  if (!targetUser) {
    return res.status(404).json({ error: 'Usuario no encontrado.' });
  }

  if (action === 'block_account') {
    db.blockUserAccount(targetUserId);
    return res.json({
      ok: true,
      message: `La cuenta ${targetUser.email} fue BLOQUEADA y todas sus sesiones en celulares fueron cerradas al instante.`
    });
  }

  if (action === 'activate_account') {
    db.activateUserAccount(targetUserId);
    return res.json({
      ok: true,
      message: `La cuenta ${targetUser.email} fue reactivada.`
    });
  }

  if (action === 'revoke_sessions') {
    db.revokeUserSessions(targetUserId);
    return res.json({
      ok: true,
      message: `Se cerraron todas las sesiones activas de ${targetUser.email} en todos los celulares.`
    });
  }

  if (action === 'delete_user') {
    if (targetUser.id === req.user.id) {
      return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta de administrador.' });
    }
    db.deleteUser(targetUserId);
    return res.json({
      ok: true,
      message: `El usuario ${targetUser.email} fue eliminado del sistema.`
    });
  }

  res.status(400).json({ error: 'Acción de seguridad desconocida.' });
});

app.post('/api/admin/emergency-lockdown', requireAuth, requireAdmin, (req, res) => {
  const { enable } = req.body;
  db.setEmergencyLockdown(Boolean(enable), req.tokenHash);

  res.json({
    ok: true,
    emergencyLockdown: Boolean(enable),
    message: enable
      ? 'BLOQUEO DE EMERGENCIA ACTIVADO: Se cerraron todas las sesiones en todos los celulares (incluido cualquier celular robado) y se pausaron las ventas.'
      : 'Bloqueo de emergencia desactivado. El sistema vuelve a operar normalmente.'
  });
});

// Servir archivos estáticos del frontend
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Servidor de Inventario Seguro ejecutándose en http://localhost:${PORT}`);
});
