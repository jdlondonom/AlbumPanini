# Mi Álbum Panini 2026

Aplicación para controlar tres inventarios por cuenta:

- láminas pegadas en el álbum;
- colección adicional sin pegar;
- repetidas disponibles.

Incluye autenticación con contraseña, MFA TOTP, sesiones persistentes y sincronización del progreso entre dispositivos.

## Arquitectura

- Express sobre Node.js 24.
- PostgreSQL para usuarios, sesiones, MFA, límites de acceso y progreso.
- Copia local del progreso en el navegador para recuperación ante fallos de red.
- Una Vercel Function recibe todas las rutas mediante `api/index.js`.

SQLite no se utiliza en producción porque el sistema de archivos de Vercel Functions es efímero.

## Despliegue en Vercel

### 1. Crear la base de datos

En el proyecto de Vercel abre **Storage → Marketplace** e instala una integración PostgreSQL, por ejemplo Neon. Conecta la base al proyecto y confirma que Vercel haya creado `DATABASE_URL`.

Usa la URL de conexión con pooler que entregue el proveedor. Mantén la base y la Function en regiones cercanas.

### 2. Configurar secretos

Genera una clave de 32 bytes una sola vez:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

En **Project → Settings → Environment Variables** configura:

- `AUTH_ENCRYPTION_KEY`: resultado del comando anterior;
- `DATABASE_URL`: normalmente la instala automáticamente el proveedor PostgreSQL;
- `DATABASE_POOL_MAX`: `5` es suficiente para esta aplicación.

No cambies `AUTH_ENCRYPTION_KEY` después de configurar MFA: hacerlo impediría descifrar los secretos TOTP existentes. No guardes esta clave en GitHub.

### 3. Desplegar

Importa `https://github.com/jdlondonom/AlbumPanini` en Vercel. La configuración de `vercel.json` detectará la Function y dirigirá todas las rutas hacia Express.

También puedes desplegar con la CLI:

```powershell
npx vercel --prod
```

### 4. Migrar o crear el usuario remoto

La cuenta local anterior no se sube a GitHub. Después de conectar PostgreSQL, copia temporalmente en `.env.local` los mismos valores de `DATABASE_URL` y `AUTH_ENCRYPTION_KEY` configurados en Vercel.

Para copiar la cuenta existente desde `data/auth.sqlite`, conservando su contraseña y configuración MFA, ejecuta:

```powershell
npm install
npm run migrate-legacy-users
```

La migración no copia sesiones abiertas. Si no tienes la base anterior o quieres crear otra cuenta, ejecuta:

```powershell
npm install
npm run create-user -- --username TU_USUARIO --email TU_CORREO
```

La contraseña se solicita de manera interactiva y no se muestra ni se guarda en el historial de la terminal. En el primer ingreso aparecerá el QR para activar MFA.

## Ejecución local

Copia `.env.example` como `.env.local`, configura una base PostgreSQL accesible y luego ejecuta:

```powershell
npm install
npm start
```

Abre [http://127.0.0.1:3010](http://127.0.0.1:3010).

## Progreso anterior

El progreso se almacena ahora en PostgreSQL y también como respaldo en `localStorage`.

- Si ya usabas la versión protegida en `127.0.0.1:3010`, ejecútala una vez conectada a PostgreSQL: cuando la cuenta remota esté vacía, el progreso local se cargará automáticamente.
- Si abrías directamente el archivo HTML, exporta primero el JSON desde esa versión y luego usa **Importar progreso** en la aplicación desplegada.

Después de la primera sincronización, el inventario estará disponible al iniciar sesión desde otros dispositivos.

## Seguridad

- Contraseñas derivadas con `scrypt` y sal aleatoria.
- MFA TOTP con secreto cifrado mediante AES-256-GCM.
- Prevención atómica de reutilización del mismo código TOTP.
- Cookies `HttpOnly`, `SameSite=Strict` y `Secure` en producción.
- Rotación de sesión tras validar contraseña y MFA.
- Protección CSRF para logout y sincronización del progreso.
- Límites de intentos y bloqueo temporal almacenados en PostgreSQL.
- CSP y encabezados de seguridad mediante Helmet.
- Secretos y archivos locales excluidos por `.gitignore`.

## Pruebas

```powershell
npm test
npm audit --omit=dev
```

Las pruebas utilizan PostgreSQL en memoria y validan contraseña, TOTP, cifrado, login, alta MFA, sesiones, logout y sincronización del progreso.
