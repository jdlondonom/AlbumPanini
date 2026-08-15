# Mi Álbum Panini 2026

Mini app local para controlar tres inventarios independientes:

- láminas asignadas al álbum;
- colección adicional sin pegar;
- repetidas disponibles.

El acceso se realiza mediante un portal local con contraseña, MFA TOTP y sesiones protegidas.

## Requisitos

- Node.js 22.5 o posterior.
- Una aplicación autenticadora compatible con TOTP, por ejemplo Google Authenticator, Microsoft Authenticator o 1Password.

## Instalación local

```powershell
npm install
npm run setup
npm run create-user -- --username TU_USUARIO --email TU_CORREO
npm start
```

Abre [http://127.0.0.1:3010](http://127.0.0.1:3010). En el primer ingreso, después de validar la contraseña, la app mostrará un QR para activar MFA.

La contraseña se solicita de forma interactiva y no se muestra en pantalla. La base de usuarios, la clave de cifrado, las sesiones y el secreto MFA permanecen en archivos locales excluidos por `.gitignore`.

## Datos anteriores del álbum

Al pasar de abrir el HTML directamente a usar `http://127.0.0.1:3010`, el navegador utiliza un origen de almacenamiento diferente. Para conservar el progreso:

1. Abre una última vez el HTML anterior y pulsa **Exportar progreso**.
2. Inicia la aplicación protegida.
3. Pulsa **Importar progreso** y selecciona el JSON exportado.

## Seguridad

- Contraseñas derivadas con `scrypt` y una sal aleatoria por usuario.
- MFA TOTP con protección contra reutilización del mismo código.
- Secreto MFA cifrado mediante AES-256-GCM.
- Cookies `HttpOnly` y `SameSite=Strict`, con `Secure` obligatorio en producción.
- Rotación de sesión después de contraseña y MFA.
- Tokens CSRF en todos los formularios que modifican estado.
- Límite de intentos por dirección IP y bloqueo temporal de la cuenta.
- Política CSP y encabezados de seguridad mediante Helmet.
- Base SQLite y configuración local excluidas del repositorio.

La aplicación escucha solamente en `127.0.0.1` por defecto. Para publicarla en una red o en Internet, usa un proxy HTTPS, cambia `NODE_ENV=production` y administra los secretos fuera del repositorio.

## Pruebas

```powershell
npm test
```

Las pruebas validan el hash de contraseña, vectores TOTP, cifrado del secreto MFA y el flujo completo de login, alta MFA y acceso protegido.
