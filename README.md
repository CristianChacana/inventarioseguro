# Sistema de Inventario y Punto de Venta Seguro con Lector de Códigos de Barras Móvil

Este proyecto contiene una aplicación completa **Full-Stack (Node.js + Express + SQLite Transaccional)** diseñada para funcionar en celulares desde cualquier lugar con internet, sin exponer ninguna clave o secreto en el frontend.

## Características Principales Implementadas

1. **Seguridad Total en Backend (Cero Claves en el Frontend)**:
   - La autenticación con **Google OAuth 2.0** (`GOOGLE_CLIENT_SECRET`), la clave de sesión (`SESSION_SECRET`) y la llave opcional de análisis de imagen (`GEMINI_API_KEY`) viven **exclusivamente en el servidor** (`.env`).
   - Las sesiones se guardan en una cookie `HttpOnly` firmada y cifrada en la base de datos (`sessions`), inaccesible desde JavaScript en el navegador.
   - En **cada petición**, el backend verifica en tiempo real si la cuenta sigue activa y si la sesión de ese celular no fue revocada.

2. **Lector de Código de Barras en Celular con Doble Verificación + Entrada Manual**:
   - **Cámara en vivo**: Lee códigos EAN-13, EAN-8, UPC y Code-128 exigiendo **doble lectura consecutiva coincidente** para evitar errores por desenfoque o movimiento.
   - **Análisis cuidadoso de foto**: Permite tomar una foto nítida de la etiqueta para analizarla localmente o en el backend.
   - **Entrada numérica manual**: Disponible en **todas las cuentas** (administrador y vendedores) para escribir o pegar los dígitos del código de barras cuando una etiqueta está dañada.

3. **Confirmación Obligatoria en Cada Operación**:
   - Al escanear o escribir un código, el sistema muestra o pregunta el **nombre del producto**, el precio y la cantidad, y abre un cuadro de confirmación obligatorio (`¿Confirmas que esta operación es correcta?`) tanto al agregar productos como antes de registrar cualquier **Compra**, **Ajuste (suma/resta)** o **Venta**.

4. **Protección Antirrobo de Celulares (Vendedoras y Administradora)**:
   - **Si le roban el celular a una vendedora**: La administradora entra a la pestaña **🛡️ Cuentas y Celulares Robados** y presiona **"🛑 Bloquear Cuenta y Celular"**. Esto desactiva su cuenta Gmail y destruye su sesión en el servidor al instante (el teléfono robado queda fuera en el próximo clic).
   - **Si le roban el celular a la administradora**: La administradora inicia sesión con su cuenta Gmail desde cualquier otra computadora o teléfono y presiona **"🔒 ACTIVAR BLOQUEO TOTAL Y EXPULSAR CELULARES"**. Esto cierra todas las sesiones abiertas en todos los dispositivos (incluido el celular robado) y congela las ventas hasta que ella lo reactive. Also puede revocar accesos de la app desde [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

---

## Cómo Ejecutarlo en tu Computadora

1. Instala **Node.js LTS** (versión 18 o superior) desde [https://nodejs.org](https://nodejs.org).
2. Abre una terminal en la carpeta del proyecto:
   ```bash
   cd C:\Users\user\.gemini\antigravity\scratch\inventario-seguro
   npm install
   ```
3. Copia el archivo `.env.example` a `.env`:
   ```bash
   copy .env.example .env
   ```
   *(Para probar rápidamente en tu PC sin configurar Google Cloud aún, cambia `ALLOW_DEMO_LOGIN=true` en tu archivo `.env` y coloca tu correo en `ADMIN_EMAIL`).*
4. Inicia el servidor:
   ```bash
   npm start
   ```
5. Abre `http://localhost:3000` en tu navegador.

---

## Cómo Configurar el Inicio de Sesión con Gmail (Google Cloud Gratis)

1. Entra a [Google Cloud Console](https://console.cloud.google.com/).
2. Crea un proyecto nuevo y ve a **APIs y servicios > Pantalla de consentimiento de OAuth** (elige *Externo*, coloca el nombre de tu negocio y tu correo).
3. Ve a **Credenciales > Crear credenciales > ID de cliente de OAuth**:
   - Tipo de aplicación: **Aplicación web**.
   - En **URI de redireccionamiento autorizados**, agrega:
     - Para pruebas locales: `http://localhost:3000/api/auth/google/callback`
     - Cuando lo subas a la nube: `https://tu-dominio-en-la-nube.com/api/auth/google/callback`
4. Copia el **Client ID** y el **Client Secret** en las variables de entorno del servidor (`GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`) y asegúrate de dejar `ALLOW_DEMO_LOGIN=false`.

---

## Cómo Alojarlo en la Nube Gratis / Económico (con HTTPS para la Cámara del Celular)

> **Importante**: Los navegadores de celulares (Chrome en Android y Safari en iPhone) exigen que la página tenga **HTTPS** (candado seguro) para permitir abrir la cámara lectora de códigos de barras desde internet.

Opciones recomendadas que incluyen **HTTPS automático gratis** y variables de entorno privadas en el backend:

1. **Render.com** (Web Service con Node.js) o **Railway.app** / **Fly.io**:
   - Conectas tu repositorio de GitHub (sin subir el archivo `.env`).
   - En el panel de *Environment Variables* de Render/Railway, cargas:
     - `ADMIN_EMAIL` = tu correo Gmail
     - `SESSION_SECRET` = una frase larga aleatoria
     - `GOOGLE_CLIENT_ID` = tu ID de cliente de Google
     - `GOOGLE_CLIENT_SECRET` = tu secreto de Google
     - `GOOGLE_REDIRECT_URI` = `https://tu-app.onrender.com/api/auth/google/callback`
     - `ALLOW_DEMO_LOGIN` = `false`
   - Para que el archivo `inventory.db` de SQLite se conserve al reiniciar en la nube, monta un volumen persistente (*Persistent Disk*) en la ruta del proyecto, o usa Railway/Fly.io con volumen de 1 GB.
