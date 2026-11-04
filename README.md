# Mail Center — plantilla genérica

Plantilla reutilizable para desplegar instalaciones independientes de un centro de correo sobre Cloudflare Workers, D1, KV y Resend. Esta rama separa la configuración por instalación y está incorporando un instalador automatizado. No debe considerarse lista para producción hasta completar las pruebas de aprovisionamiento, seguridad y correo end-to-end.

## Compatibilidad con planes gratuitos

La plantilla tiene como requisito obligatorio funcionar con Cloudflare Workers Free y Resend Free, sin suscripciones ni facturación automática. Las cuotas se comparten por cuenta y el instalador debe validar capacidad antes de aprovisionar. Consulta [compatibilidad Free y límites de capacidad](docs/FREE_TIER_COMPATIBILITY.md).

**Importante:** el scheduler central y el preflight de límites duros conocidos (D1, Workers, namespaces KV y Resend) y el bloqueo de concurrencia por cuenta Cloudflare ya están implementados en la rama de plantilla. La plantilla aún no debe declararse Free-ready hasta ejecutar CI, aplicar las migraciones del control plane (incluida la nueva reserva por cuenta), instalar `MAINTENANCE_TOKEN` en cada Worker y validar el ciclo real de mantenimiento. Las cuotas de Requests, D1, KV y Queue siguen necesitando medición adicional. El envío de mensajes utiliza un relay del control plane con reservas de cuota compartidas por cuenta Resend (100/día y 3.000/mes UTC) e idempotencia entre instalaciones. Las operaciones administrativas de dominios Resend aún usan la clave runtime de cada Worker.

## Arquitectura

- Cloudflare Workers + Hono + TypeScript.
- Cloudflare D1 para usuarios, empresas, dominios, buzones, mensajes, permisos, auditoría y estados.
- Workers KV para originales MIME y adjuntos. No utiliza R2.
- Cloudflare Email Workers `email()` + PostalMime para recepción.
- Resend API para envío y webhooks Svix para estados de entrega.
- Autenticación propia, cookies seguras, PBKDF2, perfil de buzón autogestionado y MFA TOTP por usuario.
- Scheduler central cada 15 minutos por Queue para limpieza y reintentos de envío con backoff exponencial; los Workers de correo no consumen Cron Triggers individuales.

## Estructura

- `src/index.ts`: API, recepción, envío, webhooks y reintentos programados.
- `src/middleware/auth.ts`: sesiones y verificación de contraseñas.
- `src/auth/routes.ts`: bootstrap, login, MFA challenge y logout.
- `src/auth/security.ts`: inscripción TOTP y códigos de recuperación.
- `src/auth/totp.ts`: RFC 6238, AES-GCM y códigos de recuperación.
- `src/email/inbound.ts`: recepción y análisis MIME.
- `src/admin/routes.ts`: consultas del panel global.
- `public/`: webmail y panel administrativo.
- `migrations/`: migraciones D1 ordenadas.
- `src/auth/totp.test.ts`: pruebas unitarias de los primitivos TOTP.

## Configuración por instalación

No se versiona un `wrangler.toml` con identificadores de recursos de una instalación concreta. Cada instalación genera su propia configuración local a partir de `installation.json`.

```bash
cp installation.example.json installation.json
# Completar los datos y los IDs de los recursos dedicados
npm run configure:installation
npm run test:installer
```

El archivo generado `wrangler.toml` y `installation.json` están excluidos de Git. No introducir tokens de Cloudflare, claves Resend ni secretos de runtime en esos archivos. La generación de configuración no crea recursos ni despliega el Worker todavía. Consulta `docs/TEMPLATE_ARCHITECTURE.md` y `docs/INSTALLER_IMPLEMENTATION.md`.

Comandos desde `./`:

```bash
npm install
npm run validate:migrations
npm test
npm run typecheck
npx wrangler deploy --dry-run
```

Aplicar migraciones locales:

```bash
npm run db:local
```

Aplicar migraciones remotas de preview:

```bash
npx wrangler d1 migrations apply safymail-preview --remote --env preview
```

No ejecutar el despliegue de producción ni modificar DNS como parte de la validación preview.

## Despliegue automatizado de una instalación

Cuando el trabajo de aprovisionamiento del control plane haya terminado y la instalación figure en `configuring`, el operador puede desplegar el Worker desde un terminal de confianza:

```bash
read -r -p "URL HTTPS del control plane: " CONTROL_PLANE_URL
read -r -s -p "Token admin del control plane: " CONTROL_PLANE_ADMIN_TOKEN; echo
read -r -p "ID de instalación: " INSTALLATION_ID
read -r -s -p "Token Cloudflare con permisos de Workers y D1: " CLOUDFLARE_API_TOKEN; echo
read -r -s -p "Clave API de Resend dedicada: " RESEND_API_KEY; echo
read -r -s -p "Clave TOTP persistente (32 bytes base64url): " TOTP_ENCRYPTION_KEY; echo
export CONTROL_PLANE_URL CONTROL_PLANE_ADMIN_TOKEN INSTALLATION_ID CLOUDFLARE_API_TOKEN RESEND_API_KEY TOTP_ENCRYPTION_KEY
npm run deploy:installation
unset CONTROL_PLANE_ADMIN_TOKEN CLOUDFLARE_API_TOKEN RESEND_API_KEY TOTP_ENCRYPTION_KEY
```

La clave TOTP debe generarse una sola vez con `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`, guardarse en un gestor seguro y reutilizarse en todos los despliegues de esa instalación. El script aplica migraciones D1, despliega el Worker e instala secretos desde el terminal. Muestra el token temporal de bootstrap una sola vez: úsalo para crear el primer administrador y elimínalo inmediatamente después. No ejecutes de nuevo el script tras completar el bootstrap sin planificar la rotación de ese token.

Esta fase no configura DNS, Email Routing ni dominio personalizado, no crea el administrador automáticamente y no cambia el estado a `ready`. Esos pasos requieren verificación y todavía están pendientes. No ejecutar desde navegador ni exponer estas variables a código cliente.

Consulta [la guía del instalador](docs/INSTALLER_IMPLEMENTATION.md).

Antes de cambiar DNS, ejecuta el análisis de solo lectura para los registros de salida de Resend:

```bash
read -r -p "URL HTTPS del control plane: " CONTROL_PLANE_URL
read -r -s -p "Token admin del control plane: " CONTROL_PLANE_ADMIN_TOKEN; echo
read -r -p "ID de instalación: " INSTALLATION_ID
read -r -s -p "Token Cloudflare con permiso DNS Read: " CLOUDFLARE_API_TOKEN; echo
export CONTROL_PLANE_URL CONTROL_PLANE_ADMIN_TOKEN INSTALLATION_ID CLOUDFLARE_API_TOKEN
npm run plan:dns
unset CONTROL_PLANE_ADMIN_TOKEN CLOUDFLARE_API_TOKEN
```

El plan distingue registros correctos, registros ausentes y conflictos que requieren intervención manual. Nunca crea, reemplaza ni elimina DNS. SPF, DKIM, DMARC, MX y CNAME existentes se preservan; cualquier conflicto detiene la propuesta de aplicación automática. Esta fase solo analiza los registros que Resend devuelve para el dominio de salida; Email Routing entrante se analiza por separado.

Para inspeccionar también Email Routing entrante, usa un token Cloudflare de solo lectura con permisos Zone Settings Read y Email Routing Rules Read:

```bash
read -r -p "URL HTTPS del control plane: " CONTROL_PLANE_URL
read -r -s -p "Token admin del control plane: " CONTROL_PLANE_ADMIN_TOKEN; echo
read -r -p "ID de instalación: " INSTALLATION_ID
read -r -s -p "Token Cloudflare DNS/Email Routing de solo lectura: " CLOUDFLARE_API_TOKEN; echo
export CONTROL_PLANE_URL CONTROL_PLANE_ADMIN_TOKEN INSTALLATION_ID CLOUDFLARE_API_TOKEN
npm run plan:email-routing
unset CONTROL_PLANE_ADMIN_TOKEN CLOUDFLARE_API_TOKEN
```

Este análisis consulta los requisitos MX/TXT de Cloudflare, el estado del servicio y la regla catch-all actual. No habilita Email Routing ni cambia reglas o DNS. Si hay un catch-all activo que apunta a otro destino, lo informa y no lo sustituye.

Cuando el análisis indique que Email Routing está habilitado y en estado `ready`, puedes crear la regla catch-all para el Worker. Requiere un token con Email Routing Rules Write, Zone Settings Read y Workers Scripts Read:

```bash
npm run setup:email-routing -- --apply
```

El comando solo crea la ruta si no existe una regla activa incompatible. Si encuentra el catch-all predeterminado deshabilitado, pide escribir el dominio completo antes de activarlo. Nunca reemplaza una regla activa que apunte a otro destino ni modifica DNS.

Si el plan no muestra conflictos y quieres crear únicamente los registros ausentes, ejecuta:

```bash
npm run apply:dns -- --apply
```

El comando vuelve a consultar DNS, muestra exactamente qué creará y exige escribir el dominio completo en el terminal. Solo envía solicitudes de creación; nunca actualiza ni elimina registros existentes.


## Secretos

Los secretos se configuran directamente con Wrangler; nunca deben guardarse en Git ni compartirse por chat.

- `BOOTSTRAP_TOKEN`: clave temporal para crear el primer superadministrador.
- `TOTP_ENCRYPTION_KEY`: clave aleatoria de 32 bytes codificada en base64url para cifrar secretos TOTP con AES-GCM.
- `RESEND_API_KEY`: clave de API de Resend para operaciones administrativas de dominios; el envío utiliza el relay central.
- `RESEND_RELAY_TOKEN`: token HMAC exclusivo de instalación emitido por el control plane.
- `CONTROL_PLANE_URL` e `INSTALLATION_ID`: variables de runtime generadas por el instalador.
- `RESEND_WEBHOOK_SECRET`: secreto de firma Svix del webhook Resend.

Para generar la clave TOTP localmente y cargarla en preview:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put TOTP_ENCRYPTION_KEY --env preview
```

Copia el resultado directamente al prompt de Wrangler y no lo pegues en el chat ni en archivos versionados. La clave debe respaldarse de forma segura: perderla impide descifrar los secretos TOTP existentes.

Bootstrap inicial:

1. Configura `BOOTSTRAP_TOKEN` en preview (mínimo 32 caracteres).
2. Abre la aplicación y crea el superadministrador.
3. Elimina `BOOTSTRAP_TOKEN` al terminar: `npx wrangler secret delete BOOTSTRAP_TOKEN --env preview`.
4. Configura `TOTP_ENCRYPTION_KEY`, inicia sesión y activa la verificación en dos pasos desde el webmail.
5. Guarda los códigos de recuperación fuera de la aplicación. Solo se muestran una vez.

El login de cualquier usuario con TOTP activo exige contraseña y segundo factor. Las rutas administrativas y el acceso del superadministrador a los datos de buzones exigen una sesión MFA verificada. Los usuarios de buzón pueden editar su nombre visible (también utilizado como nombre del remitente), cambiar su contraseña verificando la actual y gestionar TOTP desde «Mi cuenta». El cambio de contraseña revoca las demás sesiones. La activación TOTP exige confirmar un código de la aplicación y genera códigos de recuperación de un solo uso; desactivarlo exige contraseña y código TOTP vigentes. El superadministrador no puede desactivar su MFA.

## Dominios y correo

Crear una empresa, dominio, buzón y alias desde el panel administrativo. La aplicación no cambia DNS automáticamente.

### Recepción

1. Configura Cloudflare Email Routing / Email Service para el dominio.
2. Verifica los registros MX con el botón de comprobación del panel.
3. Crea en el panel de Cloudflare una regla de routing que envíe los destinatarios correspondientes a este Worker.
4. Comprueba la recepción real con un mensaje de prueba.

La comprobación DNS valida que el MX apunte a los servidores de Cloudflare; no confirma por sí sola que exista una regla que dirija el mensaje al Worker. La recepción utiliza la dirección destinataria para resolver un buzón o alias activo.

### Envío

1. Configura `RESEND_API_KEY` en preview.
2. Desde el panel, crea la configuración del dominio en Resend.
3. Publica los registros DNS devueltos por Resend. Se solicita región `eu-west-1`.
4. Verifica el dominio desde el panel; el estado solo se marca como verificado cuando Resend confirma el dominio.
5. Configura `RESEND_WEBHOOK_SECRET` y registra en Resend el webhook `https://TU-DOMINIO/api/webhooks/resend` para `email.sent`, `email.delivered`, `email.bounced` y `email.failed`.

No reemplaces un registro SPF existente: integra los mecanismos requeridos en un único registro. No marques manualmente un dominio como verificado; el endpoint de confirmación manual está deshabilitado.

## Seguridad y aislamiento

- No existe registro público. El primer superadministrador se crea mediante bootstrap protegido.
- Contraseñas: PBKDF2-HMAC-SHA-256 con salt individual aleatorio y 100.000 iteraciones por compatibilidad WebCrypto del Worker.
- Sesiones: token aleatorio, hash SHA-256 en D1, cookie `Secure`, `HttpOnly`, `SameSite=Strict`, 12 horas de duración absoluta y 2 horas de inactividad.
- Login: bloqueo temporal tras ocho fallos en una ventana de 15 minutos.
- Superadministración: TOTP RFC 6238 con protección contra reutilización de contador, secreto cifrado AES-GCM y códigos de recuperación de un solo uso almacenados como hashes.
- Operaciones mutables: validación de `Origin`; respuestas privadas sin caché.
- Cabeceras: CSP, `nosniff`, protección contra framing y política de referencia.
- El backend deriva la identidad de la sesión y valida permisos de empresa y buzón en cada operación.
- Cada buzón tiene una identidad de inicio de sesión independiente: su email es la dirección completa del buzón y su contraseña PBKDF2 es individual. La identidad solo recibe membresía en su empresa y permiso read_write para ese buzón; el panel permite restablecer su contraseña y revoca sus sesiones anteriores.
- El inicio de sesión de cada buzón está limitado a los hostnames activos asociados a su empresa en Hostnames. Configura allí el hostname webmail correspondiente y enrútalo al Worker; la creación del buzón no modifica DNS ni crea hostnames automáticamente.
- Suspender un buzón suspende también su identidad de acceso y revoca sus sesiones, sin borrar mensajes ni adjuntos. Reactivarlo vuelve a habilitar su identidad; un restablecimiento de contraseña puede provisionar la identidad de buzones creados antes de este modelo.
- Los usuarios operativos requieren membresía y permisos explícitos; los hostnames de acceso no registrados o suspendidos fallan de forma cerrada.
- Las suspensiones conservan los mensajes y adjuntos; la reactivación restaura el acceso según el estado de empresa, dominio o buzón.
- Mensajes entrantes: deduplicación por buzón y `Message-ID`; límites de MIME y adjuntos; el HTML original no se expone en la API ni se renderiza en el lector.
- Envío: clave de idempotencia y reintentos programados para errores transitorios; los fallos permanentes se marcan como fallidos.
- Workers KV tiene cuotas y límites de tamaño/operaciones. El sistema no promete almacenamiento gratuito ilimitado: mantiene un límite interno de 600 MiB para MIME y adjuntos, registra reservas/consumo en D1 y muestra el uso en el panel administrativo. Los límites de operaciones diarios de Cloudflare siguen aplicando.

## API principal

- `GET /api/health`, `GET /api/auth/status`.
- `POST /api/auth/bootstrap`, `POST /api/auth/login`, `POST /api/auth/mfa/verify`, `POST /api/auth/logout`.
- `POST /api/security/totp/enroll`, `POST /api/security/totp/confirm`, `GET /api/security/totp/status`.
- `GET /api/me`, `GET /api/accounts`.
- `GET /api/messages`: búsqueda con `q`, límite y cursor estable (`cursor_date`, `cursor_id`).
- `GET /api/messages/:id`, `GET /api/attachments/:id`, `PATCH /api/messages/:id`.
- `POST /api/messages/send`, `POST /api/drafts`, `PATCH /api/drafts/:id`.
- `GET|POST|PATCH|DELETE /api/contacts` y `/api/contacts/:id`.
- `POST /api/webhooks/resend`.
- Rutas administrativas bajo `/api/admin`: empresas, dominios, buzones (crear identidad y contraseña, editar nombre visible, restablecer contraseña, suspender/reactivar), alias, usuarios operativos, hostnames y auditoría.
- Verificación de dominios: `/api/admin/domains/:id/resend/setup`, `/verify-outbound`, `/verify-inbound` y `/dns`.

## Estado y límites pendientes

Implementado en la rama: webmail base, aislamiento por empresa/hostname, panel global, contactos, carpetas, búsqueda y paginación, respuesta/reenviado con threading, recepción MIME, KV, envío Resend con adjuntos, webhook, reintentos mediante scheduler central, gestión de dominios y MFA TOTP. Los adjuntos salientes se conservan en KV para permitir reintentos idempotentes; máximo 5 archivos, 5 MB por archivo y 10 MB en total. Los adjuntos aún no se conservan dentro de borradores.

Bloqueado hasta configurar servicios externos: secreto TOTP, credenciales Resend, DNS de los dominios, Email Routing y regla Cloudflare hacia el Worker, y webhook Resend.

Pendiente de validación final: typecheck/build CI, pruebas de integración de D1/KV, pruebas automatizadas multiempresa/IDOR, recepción y envío reales, webhooks, reintentos, cuotas/rendimiento, recuperación de MFA, revisión integral de CSP/XSS/CSRF y aceptación de los tres loops.

El proyecto no debe declararse listo para producción hasta cerrar los hallazgos críticos/altos y completar las pruebas de extremo a extremo.


## PWA e instalación

El webmail incluye un manifiesto y un service worker para instalar Mail Center como aplicación desde navegadores compatibles.

- Android/Chrome y escritorio: utiliza el botón **Instalar app** cuando el navegador lo ofrezca, o la opción de instalación del menú del navegador.
- iPhone/iPad: abre el webmail en Safari, pulsa **Compartir** y selecciona **Añadir a pantalla de inicio**.
- El service worker conserva únicamente la carcasa estática de la aplicación y los iconos. Excluye todas las rutas `/api/`, la administración y los adjuntos; no almacena correos, credenciales ni sesiones.
- Sin conexión se muestra una indicación de conectividad; consultar y enviar mensajes requiere conexión.
- Las notificaciones de nuevos mensajes se actualizan mediante consulta periódica mientras la aplicación está visible. El sonido es opcional y se habilita desde el control de la barra superior. Las notificaciones push del sistema operativo no forman parte de esta iteración.

Validar el manifiesto, los recursos PWA, las exclusiones de caché y la sintaxis JavaScript:

```bash
npm run validate:pwa
```


## Generic template setup

This branch is being converted into a reusable, isolated mail-center template. Do not copy resource IDs from another installation.

1. Copy `installation.example.json` to the ignored local file `installation.json`.
2. Fill in the project name, Worker slug, domain, administrator email and Cloudflare account/zone IDs.
3. Provision a dedicated D1 database and KV namespace for this installation, then enter their IDs.
4. Run `npm run configure:installation` to generate the local `wrangler.toml`.
5. Run `npm run test:installer` to test the configuration generator.

The generated `wrangler.toml` and `installation.json` are intentionally excluded from Git. Never place Cloudflare API tokens, Resend API keys, webhook secrets or encryption keys in these files. This configuration step does not provision resources or deploy the Worker yet; those capabilities are being implemented in the control plane.

See [the template architecture](docs/TEMPLATE_ARCHITECTURE.md) and [installer implementation notes](docs/INSTALLER_IMPLEMENTATION.md).
