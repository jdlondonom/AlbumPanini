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

## Escáner de láminas

En **Láminas → Escanear láminas**, abre la cámara trasera y encuadra el código
del reverso, por ejemplo `QAT 5`. También puedes elegir una foto o escribir el
código. El lector propone un resultado: **siempre debes confirmar o corregir
equipo y número antes de registrar una unidad**.

- Primera copia, sin existencias en ninguno de los tres inventarios: al álbum.
- Si ya existe en álbum, colección sin pegar o repetidas: suma una repetida.
- No mueve otras copias ni modifica el inventario Adrenalyn XL.
- Cancelar no registra nada. Cada copia física adicional exige otra confirmación.
- Solo admite referencias del catálogo de 994 láminas, incluido `00`, `FWC` y `CC`.
- El límite existente de repetidas sigue siendo 99 por referencia.

Las fotos se procesan localmente con Tesseract.js y no se guardan ni se envían
al servidor. Los archivos del lector se generan al instalar dependencias mediante
`postinstall`; no usa un CDN. Para regenerarlos ejecuta `npm run prepare:ocr`.
La primera lectura descarga esos archivos desde la misma aplicación y puede tardar
más. Para guardar se necesita conexión y la sesión autenticada.

Si se pierde la respuesta al confirmar, usa **Comprobar registro pendiente**:
reutiliza la misma confirmación para no sumar dos veces. No borres el almacenamiento
del navegador mientras haya un registro pendiente. Los cambios simultáneos entre
dispositivos se verifican con revisiones; ante un conflicto se conserva la copia
local y se solicita revisarlo antes de guardar. No se sobrescribe silenciosamente
el inventario de otro dispositivo.

### Probar en Rancher Desktop y en el celular

```powershell
docker compose up --build -d
docker compose exec -T app npm run prepare:ocr
.\scripts\setup-mobile-https.ps1
```

El segundo comando prepara los archivos en la carpeta compartida de desarrollo;
la imagen de Docker también los genera durante su construcción. Recarga las
pestañas abiertas después de actualizar esta versión.

El PC mantiene `http://127.0.0.1:3010/app`. El celular requiere la URL HTTPS de la
IP del PC que muestra el script, la misma Wi-Fi y confianza manual en el certificado
local. Las instrucciones de conexión, seguridad y cierre están en
[Pruebas desde el celular](docs/mobile-scanner-testing.md). No se instala confianza
en Windows ni se abren reglas de firewall automáticamente.

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

Las pruebas incluyen autenticación, catálogo, reglas de escaneo, cancelación,
recuperación de red, conflictos entre pestañas y persistencia. La mayoría utiliza
PostgreSQL en memoria. `test/progress-postgres.test.js` comprueba transacciones
concurrentes y rollback en PostgreSQL real cuando se proporciona
`SCANNER_TEST_DATABASE_URL`, exclusivamente para una base desechable llamada
`panini_scanner_tests`. Nunca apuntes esa variable a la base de la aplicación.

Para pruebas de navegador sin inventarios reales existe
`scripts/serve-scanner-fixture.js`. Requiere `PANINI_SCANNER_FIXTURE=1`, usa una
base efímera en memoria, no consulta `DATABASE_URL` y está bloqueado en producción.
La cuenta sintética y el secreto TOTP de prueba están documentados dentro de ese
archivo; no son credenciales de la app. Publica ese servidor solamente en loopback
y detén el proceso al terminar.
