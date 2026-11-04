# Arquitectura de la plantilla genérica Mail Center

Estado: diseño inicial basado en la auditoría de `template/mail-center`.
Alcance de este documento: definir el flujo, parámetros mínimos, límites de confianza y criterios de automatización antes de modificar la aplicación.

## 1. Auditoría de la base actual

La rama contiene una aplicación de correo funcional como base, no un instalador:

- Cloudflare Worker con Hono y TypeScript.
- D1 para identidades, empresas, dominios, buzones, mensajes, permisos y auditoría.
- KV para MIME y adjuntos.
- Recepción mediante el handler Email Worker y PostalMime.
- Envío, verificación de dominio y webhooks mediante Resend.
- Webmail, panel administrativo, autenticación propia, MFA TOTP y 20 migraciones.
- Scripts de validación de migraciones, PWA, HTML y controles de seguridad.

Capacidades que todavía no existen:

- No hay un instalador ni un orquestador de aprovisionamiento.
- No hay adaptador de Cloudflare API ni creación automatizada de Worker, D1, KV, DNS o Email Routing.
- El flujo actual de Resend vincula un dominio ya creado en Resend; no crea el dominio.
- La publicación de registros DNS y la regla de Email Routing se documentan como tareas manuales.
- Las APIs actuales usan sesión/cookie de la aplicación; no hay API keys de integración ni servidor MCP.
- Las pruebas son principalmente unitarias y validadores estáticos; falta una suite de aprovisionamiento e integración end-to-end.

Configuración que no debe heredarse en una plantilla genérica:

- `wrangler.toml` contiene nombres e identificadores reales de los entornos Europe Mail Center Preview y Producción.
- Los nombres de Worker, D1, KV, APP_NAME y ENVIRONMENT están fijados a esta instalación.
- Los valores e identificadores de recursos deben generarse por instalación. No se deben reutilizar los recursos de Preview ni los de Producción existentes.

## 2. Modelo operativo recomendado

**Instancias de correo independientes por instalación.** Cada instalación tendrá su propio Worker, D1, KV, secretos de runtime, dominio y usuarios. Los datos y credenciales de una instalación no se comparten con otra.

El aprovisionamiento se ejecutará desde un **plano de control separado** de los Workers de correo. Este servicio crea y configura los recursos, pero no forma parte del runtime que procesa los buzones. Así, un fallo o compromiso de una instancia de correo no concede acceso directo a las credenciales maestras de Cloudflare o Resend.

El plano de control puede administrarse centralmente, pero la gestión central es opcional. La arquitectura no debe exigir que los datos de correo pasen por el plano de control ni que este actúe como proxy de lectura de buzones.

## 3. Parámetros de configuración

### Datos que sí debe aportar el usuario

1. Nombre del proyecto o instalación. Se puede proponer automáticamente a partir del dominio.
2. Dominio principal.
3. Correo del administrador inicial.
4. Autorización de Cloudflare: token de API de alcance mínimo, más selección de cuenta y zona cuando haya más de una.
5. Clave de Resend con permisos suficientes para crear y verificar dominios y configurar webhooks.

### Valores generados automáticamente

- Slug y nombres únicos del Worker, D1 y KV.
- Identificadores de los recursos Cloudflare.
- Configuración del entorno y bindings del Worker.
- Clave TOTP independiente por instalación.
- Token de bootstrap de un solo uso y de alta entropía.
- API keys de la aplicación, claves de firma y secretos auxiliares.
- Webhook de Resend y URL de destino.
- Registros DNS que se puedan publicar sin colisionar con servicios existentes.
- Identificadores de instalación, checkpoints y claves de idempotencia.

### Valores opcionales, con valores predeterminados seguros

- Región de Resend: `eu-west-1` por defecto.
- Jurisdicción D1: ofrecer `eu` cuando se requiera residencia europea.
- Dominios adicionales.
- Hostname personalizado del webmail.
- Política de retención, límites de almacenamiento y límites de envío.

No se deben pedir IDs de D1/KV, nombres técnicos, tokens bootstrap, claves TOTP, URLs de webhook ni secretos de sesión. El instalador debe generarlos.

## 4. Flujo automatizado de instalación

Estados persistentes de una instalación:

`draft → authorizing → discovering → planning → provisioning → configuring → waiting_dns → verifying → bootstrapping → ready`

Estados alternativos: `paused`, `failed`, `cancelled`.

Cada paso debe registrar su estado, resultado no sensible, recurso creado, marca temporal e identificador de idempotencia. Los reintentos deben continuar desde el último checkpoint y reconciliar el estado real del proveedor antes de crear recursos de nuevo.

### Etapas

1. **Recopilación mínima**: validar dominio, correo y nombre; detectar valores derivados.
2. **Autorización**: validar las credenciales contra los proveedores y descubrir cuentas, zonas y recursos accesibles.
3. **Preflight**: comprobar si el dominio pertenece a la cuenta elegida, si existe el Worker o si hay recursos con nombres conflictivos, si DNS está alojado en Cloudflare y si hay correo entrante ya configurado.
4. **Plan de cambios**: producir una vista previa de recursos y registros que se crearán, modificarán o dejarán pendientes. No ejecutar escrituras DNS destructivas de forma implícita.
5. **Provisioning Cloudflare**: crear D1 y KV, generar configuración del Worker, aplicar migraciones y desplegar el Worker.
6. **Provisioning Resend**: crear o vincular el dominio, seleccionar región, recuperar los registros requeridos y configurar webhook.
7. **DNS y recepción**: crear únicamente registros ausentes y no conflictivos, habilitar Email Routing y asociar la regla al Worker cuando la zona y los permisos lo permitan.
8. **Secretos**: instalar los secretos runtime directamente en Cloudflare; el navegador nunca recibe esos valores.
9. **Bootstrap**: crear el administrador inicial con un enlace/token de un solo uso y exigir activación de MFA.
10. **Verificación**: comprobar bindings, migraciones, DNS, verificación Resend, recepción, envío, webhook y aislamiento.
11. **Entrega**: mostrar URL, estado, recursos, instrucciones residuales y procedimiento de recuperación.

## 5. Reglas de seguridad y secretos

### Separación de credenciales

- El token Cloudflare y la clave Resend de administración solo se reciben y procesan en el backend del plano de control.
- Nunca se incluyen en HTML, JavaScript, almacenamiento del navegador, URLs, logs, errores, Git ni variables públicas del Worker.
- La instancia de correo no recibe el token Cloudflare.
- La clave Resend de administración no se instala en el Worker. Tras el aprovisionamiento se debe generar una clave de envío restringida al dominio, si el proveedor lo permite, y usar esa clave en runtime.
- Los secretos runtime se instalan como secretos del Worker mediante la API de Cloudflare.
- Cada instalación genera su propia clave TOTP. Nunca reutilizar la clave de otra instalación.

### Almacenamiento del plano de control

Si se necesita conservar credenciales para administrar instalaciones después del alta, usar cifrado envelope con KMS/secret manager, separación por tenant, control de acceso estricto, rotación y revocación. La clave maestra no debe residir en la misma base de datos que los secretos cifrados.

Si la credencial solo se necesita para la instalación inicial, preferir retención efímera y borrado verificable al finalizar. La modalidad de administración persistente debe ser explícita.

### Protección del instalador

- MFA para operadores y RBAC por instalación.
- Sesiones seguras, CSRF, CSP estricta, protección XSS, rate limits y límites de tamaño.
- Redacción de secretos en logs, trazas y mensajes de error.
- No permitir que el usuario proporcione URLs arbitrarias para que el backend las consulte; evitar SSRF.
- Acciones destructivas separadas, con diff y confirmación explícita.
- Auditoría de quién autorizó, qué recurso se modificó y qué resultado hubo, sin almacenar valores secretos.

## 6. DNS: comportamiento seguro

Antes de escribir, consultar los registros actuales y clasificarlos por tipo, nombre y contenido.

- No borrar ni sustituir MX existentes automáticamente.
- No crear un segundo SPF. Si ya existe SPF, proponer la integración correcta y detener el cambio automático hasta validar el contenido.
- No sobrescribir DKIM, DMARC, MX o TXT que pertenezcan a otro proveedor.
- Crear registros ausentes solo cuando no haya colisión y la zona esté bajo autorización.
- Si DNS no está en Cloudflare, generar instrucciones exactas y mantener la instalación en `waiting_dns`.
- Si el dominio recibe correo de otro proveedor, detener la activación de MX/Email Routing y explicar el impacto antes de cualquier cambio.
- No activar una regla catch-all sin que el usuario haya visto y aprobado el alcance.

La recepción mediante Cloudflare Email Routing requiere que el DNS del dominio esté en Cloudflare. Cuando no se cumpla, la instalación puede completar el resto, pero debe declarar la recepción como pendiente o no compatible.

## 7. API y MCP

La API pública de cada instalación debe operar sobre los recursos de correo de esa instalación, no sobre credenciales maestras de proveedores.

- API keys opacas, almacenadas como hash, con scopes, expiración, revocación y auditoría.
- Scopes separados: lectura, escritura, envío, administración de buzones y administración de dominios.
- MCP remoto como adaptador de herramientas sobre la misma capa de servicios/API, con OAuth o credenciales de integración seguras.
- Identidad y tenant derivados de la credencial autenticada; nunca confiar en un `company_id` enviado por el cliente.
- Confirmación reforzada para enviar correo, borrar, suspender o cambiar configuración crítica.
- Rate limits y límites de envío por instalación.
- No exponer herramientas MCP para administrar Cloudflare/Resend desde el Worker de correo.

## 8. Fases de implementación

1. **Generalización**: retirar IDs/nombres de la instalación original de la configuración de plantilla; introducir esquema tipado de configuración y generación de nombres.
2. **Plano de control**: modelo de instalación, estados, checkpoints, idempotencia, auditoría y almacenamiento seguro.
3. **Adaptadores**: Cloudflare (cuenta, zona, Worker, D1, KV, DNS y Email Routing) y Resend (dominio, registros, verificación y webhooks).
4. **Orquestador**: preflight, plan de cambios, ejecución, reintentos, reconciliación y recuperación.
5. **Bootstrap y seguridad**: secretos runtime, administrador inicial, MFA, revocación y endurecimiento.
6. **API de integración**: scopes, API keys y límites por instalación.
7. **MCP**: servidor remoto con autorización y herramientas allowlist.
8. **Pruebas y aceptación**: mocks de proveedores, pruebas de permisos, pruebas de idempotencia, instalación limpia, reanudación tras fallo, DNS conflictivo, e2e de correo y análisis de seguridad.

## 9. Criterios de aceptación

- Una instalación nueva no requiere editar manualmente IDs ni nombres de recursos.
- Repetir un paso o reanudar un trabajo no crea duplicados.
- Ningún secreto de proveedor aparece en el bundle del navegador, el Worker de correo, Git o logs.
- Los recursos de dos instalaciones son independientes.
- El preflight detecta conflictos y no altera correo/DNS existente sin autorización.
- La instalación puede pausarse, reanudarse y reportar exactamente qué falta.
- El Worker queda operativo con el mínimo de tareas manuales y verifica envío/recepción.
- API y MCP respetan scopes, tenant, límites y auditoría.
- La plantilla no contiene referencias a los IDs o datos de Europe Mail Center Preview/Producción.

## 10. Decisiones que se mantienen configurables

- Administración central persistente frente a aprovisionamiento efímero.
- Si la plantilla se ofrecerá solo para zonas Cloudflare o también para DNS externo con pasos manuales.
- Si la primera versión soportará un dominio o múltiples dominios desde el primer wizard.

Hasta resolver esas decisiones, la implementación debe conservar interfaces desacopladas y no acoplar el producto a una única modalidad de operación.


## 11. Control plane — primera implementación

La rama de plantilla incorpora una API de control independiente en `control-plane/`, con su propio archivo Wrangler y esquema D1. No se monta dentro del Worker de correo.

- Registro de instalaciones, checkpoints, auditoría y secretos cifrados en una D1 exclusiva del control plane.
- Autenticación mediante bearer token cuyo hash SHA-256 se configura como secreto.
- Los tokens maestros Cloudflare y Resend se reciben en la petición de aprovisionamiento y no se persisten.
- Los secretos runtime generados se cifran con AES-GCM-256 y una clave independiente `CONTROL_PLANE_VAULT_KEY`.
- Lease de aprovisionamiento con expiración para evitar ejecuciones concurrentes y permitir recuperación tras interrupciones.
- Los campos appName y workerName pueden inferirse; para crear una instalación bastan dominio y correo de administración.

Alcance actual: creación de registros de instalación y aprovisionamiento de D1/KV, dominio Resend y webhook. El servicio aún no crea ni despliega el Worker destino, no escribe DNS, no configura Email Routing ni realiza el bootstrap del administrador. La API de aprovisionamiento todavía es síncrona y debe migrarse a una cola/Workflow durable antes de ofrecer instalaciones largas sin supervisión.
