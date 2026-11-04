# Compatibilidad obligatoria con planes gratuitos

Estado: requisito de producto y restricciones de diseño. Las cifras se verificaron en la documentación oficial consultada el 3 de noviembre de 2026. Los proveedores pueden modificarlas; el instalador debe comprobar cuotas reales antes de crear recursos.

## Regla de producto

Una instalación estándar debe poder completarse y operar con cuentas gratuitas de Cloudflare y Resend. No se permite exigir Workers Paid, Workers for Platforms, Resend Pro u otra suscripción, activar facturación por consumo, crear recursos que generen cargos sin consentimiento explícito ni ocultar el agotamiento de una cuota.

Si una cuenta no tiene capacidad libre, el instalador debe detenerse antes de crear recursos y explicar qué cuota falta. Primero debe ofrecer reducir uso, liberar recursos o usar otra cuenta gratuita.

## Cuotas oficiales relevantes

### Cloudflare Workers Free

| Recurso | Cuota Free | Impacto |
|---|---:|---|
| Workers | 100 por cuenta | Un Worker por instalación consume una unidad |
| Requests | 100.000 por día por cuenta | Cuota compartida |
| CPU por invocación | 10 ms | Cada handler debe ser ligero |
| Cron Triggers | 5 por cuenta | No asignar un Cron a cada instalación |
| D1 databases | 10 por cuenta | Una D1 del control plane deja como máximo 9 D1 de correo, menos las ya existentes |
| D1 por base | 500 MB | Limitar crecimiento por buzón |
| D1 storage total | 5 GB por cuenta | Compartido |
| D1 rows read | 5 millones/día | Compartido |
| D1 rows written | 100.000/día | Compartido |
| D1 subrequests de lectura | 50 por invocación | Revisar handlers con muchas consultas |
| KV reads | 100.000/día | Compartido |
| KV writes/deletes/lists | 1.000/día por operación | Evitar escrituras frecuentes |
| KV storage | 1 GB | Compartido |
| Queues | 10.000 operaciones/día | Lectura, escritura y borrado consumen operaciones |
| Queue retention | 24 horas | No asumir retención de 14 días |

### Cloudflare Email Routing

- Email Routing entrante está disponible en Workers Free.
- La recepción/routing entrante no tiene cuota de mensajes indicada en la tabla de precios consultada.
- El handler sigue sujeto a CPU y memoria de Workers Free.
- El envío a destinatarios arbitrarios mediante Cloudflare Email Sending requiere Workers Paid; no usarlo como proveedor de salida gratuito.

### Resend Free

| Recurso | Cuota Free |
|---|---:|
| Envíos transaccionales | 3.000/mes |
| Límite diario | 100/día |
| Dominios verificados | 3 |
| Webhook endpoints | 1 |
| Retención de datos | 30 días |

La cuota de envío es compartida por el equipo/cuenta Resend. No habilitar pay-as-you-go. La recepción principal de Mail Center debe seguir siendo Cloudflare Email Routing, no el servicio de inbox de Resend.

## Consecuencias arquitectónicas obligatorias

1. **Un solo Cron central.** `wrangler.template.toml` ya no define Cron por Worker de correo. Un único Cron del control plane se ejecuta cada cinco minutos para expirar credenciales y, cada 15 minutos, despacha mantenimiento mediante la Queue compartida en lotes de hasta diez instalaciones. Cada Worker expone `/api/internal/maintenance`, protegido por un bearer token HMAC único por instalación. El token se entrega únicamente al instalador autenticado mediante `GET /api/installations/:id/runtime-config` y debe configurarse como secreto `MAINTENANCE_TOKEN` en el Worker. El endpoint usa un bloqueo D1 con expiración para evitar mantenimiento concurrente.
2. **Capacidad D1 preflight.** Contar las bases existentes en la cuenta antes de aprovisionar. Una instalación usa una D1; el control plane usa otra. No crear la undécima base en Free. Respetar 500 MB por D1 y 5 GB globales.
3. **Capacidad Worker preflight.** Contar Workers existentes y reservar espacio para el control plane (que aloja el scheduler); no superar 100.
4. **Presupuesto Queue.** La cadencia de mantenimiento es de 15 minutos y los IDs se agrupan de diez en diez para limitar mensajes. El límite D1 Free deja como máximo nueve instalaciones de correo por cuenta cuando el control plane consume una base; por tanto, el scheduler envía como máximo un mensaje de mantenimiento por intervalo (96 al día), más el provisioning. La retención de cola Free es 24 horas. Si el volumen de provisioning o reintentos crece, se debe medir el consumo y reducir fan-out antes de alcanzar 10.000 operaciones diarias.
5. **Resend Free.** Una cuenta Free tiene un solo webhook endpoint. La implementación actual crea uno por instalación; por tanto, exigir una cuenta Resend separada por instalación hasta implementar un receptor compartido que enrute eventos por dominio. Preflight debe detectar un endpoint ocupado y detenerse sin crear otro.
6. **No enviar por Cloudflare Email Sending.** Mantener Resend para salida. La cola de salida aplica límites locales conservadores de 100/día y 3.000/mes, y aplaza mensajes hasta el siguiente reinicio UTC cuando se alcanza una cuota. El contador solo conoce envíos de Mail Center: cada instalación debe usar una cuenta Resend dedicada y no compartirla con otros sistemas o proyectos.
7. **Degradación segura.** Al aproximarse a una cuota, alertar y reducir tareas no críticas. Si una cuota dura se agota, mostrar el estado y reintentar cuando se restablezca; nunca generar cargos automáticamente.

## Estado de implementación del preflight

La rama ya incorpora comprobaciones previas al primer recurso creado:

- Cloudflare: enumera D1, Workers y namespaces KV de la cuenta. Bloquea una nueva D1 cuando ya existen 10, un nuevo Worker cuando ya existen 100 y un nuevo namespace KV cuando ya existen 1.000. Reutilizar recursos existentes no consume otra unidad. Los jobs de aprovisionamiento se serializan mediante un lease por `cloudflare_account_id` en D1 para impedir que dos instalaciones del mismo control plane superen simultáneamente una cuota de conteo.
- Resend: enumera dominios y webhooks. Bloquea un cuarto dominio o una segunda URL de webhook en la misma cuenta.
- Las comprobaciones se ejecutan antes de crear D1, KV, dominios o webhooks. Si la API de un proveedor no permite verificar la capacidad, el proceso falla de forma cerrada.
- Hay pruebas automatizadas para los límites D1, Workers, namespaces KV, webhook, token del scheduler y ventanas de cuota Resend. La validación de migraciones también prueba exclusión mutua por cuenta, recuperación de leases expirados y fencing de propietarios antiguos. Aún deben ejecutarse en CI/local antes de considerar la verificación aprobada.
- La salida Resend cuenta los mensajes aceptados por Mail Center y detiene el envío al alcanzar 100 en el día UTC o 3.000 en el mes UTC. No puede conocer envíos hechos fuera de Mail Center con la misma API key.

El bloqueo por cuenta solo coordina instalaciones gestionadas por esta instancia del control plane; no puede impedir que otros proyectos, usuarios o herramientas creen recursos en la misma cuenta durante el aprovisionamiento. El preflight vuelve a consultar el estado justo antes de crear recursos, pero la cuenta debe dedicarse a esta solución para reducir interferencias.\n\nLímites que siguen pendientes de medición o control: uso diario de Requests, CPU, D1 storage/lecturas/escrituras, KV operations/storage y Queue operations. Las APIs consultadas no exponen un contador fiable y completo de consumo diario/almacenamiento para hacer una reserva exacta; el instalador no debe presentar esos valores como capacidad libre confirmada. El Worker de correo no añade Cron Triggers: el único Cron corresponde al control plane. Antes de instalar/desplegar el control plane en una cuenta que ya tenga otros Workers, se debe verificar manualmente que el total de Cron Triggers no exceda cinco, ya que la consulta de schedules requiere permisos por script y no se debe inferir que hay capacidad a partir del número de Workers. El contador Resend es local y no consulta el consumo externo de la cuenta; por eso la cuenta debe ser exclusiva de esa instalación. La API de proveedores no ofrece todos estos contadores de forma fiable para un preflight universal; deben tratarse como límites pendientes, no como capacidad libre confirmada.

El scheduler central y el endpoint interno autenticado ya están implementados en la rama de plantilla. El Cron por instalación fue retirado de `wrangler.template.toml`. Sin embargo, **todavía no se declara Free-ready** hasta ejecutar pruebas automatizadas, verificar que el secreto `MAINTENANCE_TOKEN` se instala en cada Worker y validar el fan-out con Workers desplegados. El scheduler solo procesa instalaciones en estado `ready`.

## Matriz de capacidad inicial

Para una cuenta Cloudflare Free nueva, sin otros recursos previos:

- 1 D1 reservada al control plane.
- Hasta 9 D1 para instalaciones de correo.
- Hasta 100 Workers en total, contando control plane y cualquier Worker auxiliar.
- Máximo 5 Cron Triggers; el objetivo es consumir solo 1 para todas las instalaciones.
- KV, Requests, D1 rows y Queue operations son cuotas compartidas.

Estos máximos son límites teóricos, no promesas de capacidad operativa. La carga de correo, usuarios y adjuntos puede agotar antes las cuotas diarias o el almacenamiento.

## Criterios de aceptación Free-first

- Preflight consulta y presenta cuotas/capacidad antes de crear recursos.
- No se requiere plan pago ni Workers for Platforms.
- No se activa ningún mecanismo de overage.
- Múltiples instalaciones comparten un scheduler y no agregan Cron Triggers por Worker; cada Worker recibe mantenimiento mediante endpoint interno con token único.
- El instalador detecta los límites de conteo de D1, Workers, namespaces KV y Resend antes de crear recursos. Las cuotas de consumo compartidas que no pueden consultarse de forma fiable se declaran no verificadas; no se presentan como capacidad disponible.
- Cuotas de envío y almacenamiento con límites conservadores configurables.
- Tests simulan límites alcanzados y verifican que no se realizan escrituras adicionales ni se inicia facturación; tests del token scheduler verifican derivación determinista y aislamiento por instalación.
- README y wizard explican cuotas y capacidad real disponible.

## Fuentes oficiales

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/queues/platform/limits/
- https://developers.cloudflare.com/email-service/platform/pricing/
- https://developers.cloudflare.com/email-service/platform/limits/
- https://resend.com/pricing
