# SafyMail — preparación de entorno de pruebas Cloudflare

Este procedimiento crea recursos **separados de producción**. No configura DNS, Email Routing ni dominios empresariales.

## Estado y límites

La rama usa actualmente un ID D1 de marcador en `wrangler.toml` y un ID KV de marcador. El almacenamiento de archivos usa Workers KV para evitar activar R2. No ejecutar `db:remote` ni `deploy` hasta sustituir el ID y revisar las variables. El entorno de pruebas debe usar recursos propios:

- D1: `safymail-preview`
- Workers KV namespace: `safymail-storage-preview`
- Worker: `safymail-preview`

## Requisitos

- Cuenta Cloudflare con Workers, D1 y Workers KV habilitados. Workers KV está incluido en el plan Workers Free.
- Node.js 22+.
- Acceso autenticado a Wrangler: `npx wrangler login`.
- No guardar API tokens, claves ni secretos en Git.

## Crear recursos de prueba

Desde `./`:

```bash
npx wrangler login
npx wrangler d1 create safymail-preview
npx wrangler kv namespace create safymail-storage-preview
```

Copia el `database_id` de D1 y el `id` del namespace KV. Coloca el ID KV en `wrangler.toml` como `REPLACE_WITH_KV_NAMESPACE_ID` y el ID D1 en su marcador. No reutilices recursos de producción.

Ejemplo de configuración que debe completarse con el ID real:

```toml
[env.preview]
name = "safymail-preview"

[env.preview.vars]
APP_NAME = "SafyMail"
ENVIRONMENT = "preview"

[[env.preview.d1_databases]]
binding = "DB"
database_name = "safymail-preview"
database_id = "PEGAR_ID_D1_REAL"
migrations_dir = "migrations"

[[env.preview.kv_namespaces]]
binding = "MAIL_STORAGE"
id = "PEGAR_ID_KV_REAL"
```

## Migrar y validar

```bash
npx wrangler d1 migrations apply safymail-preview --remote --env preview
npx wrangler deploy --env preview
```

Antes de desplegar, configurar Cloudflare Access para la URL de preview y restringirla a las identidades autorizadas. Añadir los secretos desde terminal; nunca incluirlos en commits:

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN --env preview
npx wrangler secret put ACCESS_AUD --env preview
npx wrangler secret put RESEND_API_KEY --env preview
npx wrangler secret put RESEND_WEBHOOK_SECRET --env preview
```

El proyecto debe tener configurado el middleware de identidad para el entorno preview antes de habilitar el acceso a usuarios reales. Usa claves de prueba de Resend y un dominio de pruebas verificado; no utilices todavía los dominios de CoolBrands Tech, ImportTandem o REWIU.

## Pruebas de aceptación antes de DNS

1. Acceso denegado sin identidad válida de Cloudflare Access.
2. Usuario de una empresa no puede consultar mensajes ni adjuntos de otra.
3. Recepción solo acepta direcciones provisionadas.
4. Mensaje entrante y adjuntos quedan guardados en D1/Workers KV.
5. Mensaje duplicado no crea una segunda fila.
6. Envío de prueba por Resend y actualización de estado mediante webhook firmado.
7. Suspender un buzón bloquea acceso y envío sin borrar su historial.

## No hacer en esta fase

- No modificar registros MX, SPF, DKIM ni DMARC de dominios empresariales.
- No activar Email Routing para dominios productivos.
- No desplegar sobre el Worker de producción.
- No introducir secretos en el repositorio.

## Límites importantes de Workers KV en el plan gratuito

- 1 GB de almacenamiento por cuenta/namespace.
- 100.000 lecturas al día.
- 1.000 escrituras, eliminaciones y listados al día; al alcanzar el límite, las operaciones adicionales fallan en el plan Free.
- Tamaño máximo por valor: 25 MiB. La recepción limita el mensaje MIME original por debajo de ese máximo.
- KV es eventualmente consistente: una clave nueva puede tardar hasta 60 segundos en propagarse a otras ubicaciones. El sistema usa claves aleatorias e inmutables para los archivos y no sobrescribe objetos existentes.

No activar un plan Workers Paid ni ningún producto que solicite un método de pago. Verificar siempre que la cuenta permanece en Workers Free.
