# SafyMail — pruebas de correo en preview

Este procedimiento utiliza únicamente el Worker `safymail-preview`. No aplicar cambios en producción ni reemplazar registros MX existentes sin revisar primero el estado actual.

## 1. Preparación de la aplicación

Desde `./`:

```bash
git pull origin feature/europe-mail-center
npm install
npm run validate:migrations
npm test
npm run typecheck
```

Después de que todas las comprobaciones pasen:

```bash
npx wrangler d1 migrations apply safymail-preview --remote --env preview
npx wrangler deploy --env preview
```

La migración 0018 añade metadatos de autenticación y señales de riesgo de phishing a los mensajes entrantes.

## 2. Revisar DNS antes de cambiar nada

En Cloudflare, seleccionar la zona del dominio y abrir **DNS → Records**. Anotar los MX actuales. No eliminar ni reemplazar registros durante la inspección.

En SafyMail:
1. Abrir `/admin` e iniciar sesión como superadministrador con MFA.
2. Entrar en **Dominios**.
3. Pulsar **Ver DNS** en el dominio de prueba.
4. Revisar los MX observados, los MX faltantes, SPF, DMARC y los registros publicados por Resend.

La comprobación de MX espera los tres hosts de Cloudflare Email Routing:
- `route1.mx.cloudflare.net`
- `route2.mx.cloudflare.net`
- `route3.mx.cloudflare.net`

SPF debe publicarse como un único registro TXT que autorice todos los remitentes legítimos. Nunca crear un segundo registro SPF independiente. Los selectores y valores DKIM deben copiarse desde los registros de Resend asociados al dominio exacto.

MX solo identifica los servidores receptores; no demuestra que la regla de routing esté activa.

## 3. Configurar la regla Cloudflare → Worker

En el dashboard de Cloudflare:
1. Seleccionar el dominio, por ejemplo `example.com`.
2. Ir a **Compute → Email Service → Email Routing** (la etiqueta puede variar ligeramente según la vista).
3. Abrir **Routing Rules**.
4. Crear una regla específica para la primera dirección de prueba:
   - Email pattern: `pruebas`
   - Domain: `example.com`
   - Action: **Send to a Worker**
   - Worker: **safymail-preview**
5. Guardar y comprobar que la regla queda **Active**.

No configurar todavía una regla catch-all (`*`) ni repetir la regla en los tres dominios. Primero validar la entrega de una dirección y un dominio.

Si Cloudflare solicita habilitar Email Routing o revisar MX, comparar los valores propuestos con los registros ya publicados. No aceptar una sustitución de MX sin revisar qué servicio recibe actualmente el correo.

## 4. Crear el buzón en la aplicación

1. En SafyMail → Admin → **Buzones**.
2. Crear el buzón `test@example.com`.
3. Seleccionar la empresa CoolBrands Tech y el dominio correcto.
4. Asignar el superadministrador para la prueba si corresponde.
5. Confirmar que el buzón aparece en el webmail.

El receptor solo acepta buzones o alias activos que existan en D1 y pertenecen a una empresa activa. Los destinatarios desconocidos se rechazan.

## 5. Probar recepción

1. Enviar desde una cuenta externa distinta a `test@example.com`.
2. Revisar **Workers & Pages → safymail-preview → Logs** mientras se envía.
3. Comprobar que el mensaje aparece en Recibidos.
4. Abrirlo y revisar el cuerpo de texto, la versión HTML aislada, adjuntos y los resultados de autenticación.
5. La vista HTML se ejecuta en un iframe sandbox sin scripts ni recursos remotos por defecto. Las alertas de riesgo son señales orientativas; no constituyen un veredicto antispam.

## 6. Probar envío

1. Desde el webmail, seleccionar el buzón de prueba.
2. Enviar un correo sencillo a otra cuenta externa controlada.
3. Revisar el estado inicial en la carpeta Enviados.
4. Comprobar en Resend que el evento pasa a enviado y, cuando llegue, entregado.
5. Revisar los webhooks y los registros del Worker si el estado no cambia.

El estado `sent` significa que Resend aceptó el mensaje; solo `delivered` confirma el evento de entrega comunicado por el proveedor. Ningún proveedor puede garantizar que el mensaje termine en la bandeja principal en vez de spam.

## 7. Repetir por dominio

Solo después de validar CoolBrands:
- `tandemimport.com`
- `rewiuindustrial.com`

Para cada uno, comprobar MX/SPF/DMARC, registros de Resend, regla de Worker, buzón real y prueba de ida y vuelta. No modificar DNS ni activar catch-all sin autorización explícita.
