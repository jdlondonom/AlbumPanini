# Pruebas del escaner desde un celular

El escaner necesita permiso de camara y una conexion HTTPS confiable. En un
celular, `127.0.0.1` se refiere al propio telefono; la IP del PC por HTTP no es
suficiente para habilitar `getUserMedia`. Esta configuracion permite probar en
Rancher Desktop sin publicar cambios en Vercel ni enviar fotografias a un tunel
externo.

## Iniciar el acceso HTTPS local

Desde la carpeta del proyecto, con Rancher Desktop y la app local en ejecucion:

```powershell
.\scripts\setup-mobile-https.ps1
```

El script selecciona la unica IPv4 privada con puerta de enlace activa. Si hay
varias (por ejemplo, Wi-Fi y VPN), elige explicitamente la IP de la red en la que
esta el telefono:

```powershell
.\scripts\setup-mobile-https.ps1 -LanIp 192.168.40.16
```

La IP del ejemplo debe seguir perteneciendo a este PC. El resultado muestra la
URL exacta, por ejemplo `https://192.168.40.16:3443/app`. Usa esa direccion desde
un navegador completo (Safari o Chrome), no desde el navegador incrustado de
otra app. Ambos dispositivos deben estar en la misma red Wi-Fi de confianza.

El acceso al telefono escucha exclusivamente en la IP privada elegida y en el
puerto TCP 3443. Puedes escoger otro puerto libre con `-Port 3444`. Rancher corre
Docker dentro de WSL, que no puede enlazarse directamente a la IP Wi-Fi de Windows:
por eso Caddy se publica en `127.0.0.1:7443` y un pequeno proceso PowerShell oculto
reenvia TCP desde la IP Wi-Fi a ese puerto loopback. No descifra ni registra las
solicitudes; el HTTPS termina en Caddy. Si 7443 esta ocupado, usa `-ProxyPort 7444`.

No publica HTTP, el panel administrativo de Caddy ni PostgreSQL. La app del PC
conserva `http://127.0.0.1:3010`. El script inicia solo `mobile-https` y su puente,
sin reconstruir ni reiniciar la app o la base de datos. No instala servicios,
tareas programadas ni reglas persistentes de red. Ninguno de estos dos procesos
arranca automaticamente con el PC: ejecuta el script cuando quieras probarlo.

## Confiar en el certificado, una sola vez por telefono

Caddy crea una CA exclusiva para este entorno y mantiene sus claves privadas en
un volumen de Docker. El script copia unicamente el certificado **publico** a
`.local-https/album-panini-root.crt` y muestra su huella SHA-256. Esa carpeta esta
excluida de Git y del contexto de construccion de Docker.

Transfiere ese archivo al celular por un medio que controles (por ejemplo, USB).
Verifica que se llame **Album Panini pruebas - CA local** y compara la huella si
el sistema la muestra. Nunca transfieras archivos `.key`, exportes el volumen
de Caddy ni confies en certificados descargados de una fuente desconocida.

Confiar en una CA autoriza al dispositivo a aceptar certificados firmados por
ella. Hazlo solo en un telefono de pruebas o de tu propiedad, conserva las
claves en este PC y elimina esa confianza al terminar. El script no instala
certificados en Windows ni cambia ajustes del telefono.

- **iPhone/iPad:** abre e instala el perfil del certificado. Luego activa la
  confianza SSL/TLS en Ajustes > General > Informacion > Ajustes de confianza de
  certificados para **Album Panini pruebas - CA local**. Instalar el perfil no
  activa por si solo la confianza completa. [Instrucciones oficiales de Apple](https://support.apple.com/es-es/102390).
- **Android:** busca "Instalar certificado" en Ajustes de seguridad, entra a
  "Certificado de CA" y selecciona el archivo publico. No es un certificado
  personal con clave privada. La ruta y las restricciones dependen del
  fabricante; suele estar en Seguridad y privacidad > Mas ajustes de seguridad
  > Cifrado y credenciales. En equipos gestionados la politica puede impedirlo.
  [Ayuda oficial de certificados de Android/Pixel](https://support.google.com/pixelphone/answer/2844832?hl=es).

Vuelve a abrir la URL HTTPS. No omitas una advertencia TLS para iniciar sesion:
resuelve la confianza primero. Al pulsar "Escanear laminas", concede permiso de
camara a este sitio. El aviso de camara, el enfoque y la velocidad del OCR deben
probarse en el telefono fisico; no quedan validados por una prueba desde el PC.

## Comprobaciones de conexion

Puedes comprobar HTTPS desde PowerShell usando exclusivamente la CA exportada,
sin instalarla en el almacen de confianza de Windows:

```powershell
curl.exe --ssl-revoke-best-effort --cacert .\.local-https\album-panini-root.crt https://192.168.40.16:3443/health
```

El resultado esperado es `{"status":"ok"}`. Cambia la IP y el puerto si no
coinciden con los que mostro el script. `--ssl-revoke-best-effort` permite a
Schannel en Windows comprobar esta CA local aunque no tenga un servidor publico
de revocacion; sigue validando la cadena del certificado y la IP del sitio.
No uses `-k`/`--insecure`. [Referencia de curl](https://curl.se/docs/manpage.html#--ssl-revoke-best-effort).

Si el PC responde pero el celular no conecta, revisa que no este en Wi-Fi de
invitados o con aislamiento entre dispositivos. Una VPN o el firewall de Windows
pueden bloquear el acceso. No desactives el firewall ni abras puertos del router
a Internet. Si hace falta una regla, revisala antes de autorizarla y limitate al
puerto TCP elegido, la IP del PC y la subred local en el perfil privado. Esta
configuracion no crea reglas automaticamente.

Si cambia la IP del PC, ejecuta de nuevo el script con la IP nueva. El certificado
del sitio se regenerara bajo la misma CA persistente; usa la nueva URL. No borres
los volumenes de Caddy: al generar una CA nueva tendrias que volver a instalar su
certificado en el celular.

## Datos y prueba funcional

El proxy utiliza la **misma base local** de la app en Rancher, que es independiente
de Vercel. Para no alterar un inventario real del entorno local, realiza las
pruebas con una cuenta de prueba separada. No importes datos de produccion para
probar, no compartas contrasenas ni claves MFA y no uses credenciales en URLs.

La aceptacion del escaner debe cubrir al menos estos casos con una cuenta de
prueba: primera copia en el album, nueva copia como repetida, numero corregido
antes de confirmar, cancelacion sin cambios, doble toque sin duplicacion,
reintento de red y sincronizacion con otra pestana. Prueba codigos conocidos con
buena luz y con reflejos; confirma siempre equipo y numero antes de guardar.

## Cerrar las pruebas

```powershell
.\scripts\setup-mobile-https.ps1 -Stop
```

Esto detiene solo el proxy y el puente temporal de Windows; conserva los datos y
certificados para futuras pruebas. Antes de detener el proceso se comprueban su
PID, hora de inicio, ruta de script e identificador de arranque; no se detienen
otros procesos PowerShell. El estado y los logs locales se guardan en
`.local-https`, fuera de Git. No ejecutes `docker compose down -v`, porque borraria volumenes de datos
del proyecto. Si ya no usaras esta CA, elimina solo **Album Panini pruebas - CA
local** de los certificados/perfiles del celular; no borres todas sus
credenciales.

Referencias de la configuracion: [HTTPS local de Caddy](https://caddyserver.com/docs/automatic-https#local-https),
[opciones de Caddy](https://caddyserver.com/docs/caddyfile/options#skip-install-trust)
y [requisitos de la camara en el navegador](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#security).
