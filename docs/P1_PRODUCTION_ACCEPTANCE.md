# MSM MAIL — P1 Engineering Closeout & Production Acceptance

**Estado:** P1 código integrado / producción NO certificada.  
**Entorno objetivo:** mailme.msmmystore.com  
**Base revisada:** main, `cdd0625058a8f5928c70f392d303e85f8a6f3321` (PR #40).  
**Regla:** no declarar GO hasta ejecutar y adjuntar evidencia E2E sobre el SHA desplegado.

## Evidencia de desarrollo
- #28: Spam/Papelera compatible con D1 y mensajes legados.
- #30–#36: Reply/Reply-All, threading, aislamiento del compositor entre buzones, reenvío de adjuntos, borradores, concurrencia entre dispositivos y lectores read_only.
- #37: viewport/safe-area móvil. Engineering Gate run #87 PASS (typecheck, tests, PWA, security).
- #38: conserva el texto de borradores al adjuntar archivos y exige confirmar el descarte. **Merge observado; ejecución CI posterior sin confirmar.**
- #39: matriz de aceptación de producción, Engineering Gate run #91 PASS.
- #40: texto de expiración del login ajustado a 12 h absolutas / 2 h de inactividad con regresión incluida; CI PASS y merge confirmado.
- Sin PR abiertos durante la última consulta del repositorio.

## Aceptación operativa
Anotar en cada ejecución: **fecha UTC | SHA desplegado | entorno | actor/rol | resultado PASS/FAIL/BLOCKED | evidencia anonimizada**. No almacenar secretos, contenido privado, tokens, capturas con datos personales ni IDs de sesión.

| ID | Prueba | Evidencia mínima | Estado |
|---|---|---|---|
| P1-01 | Identificar SHA realmente desplegado, health y bindings D1/KV/control plane | Deploy SHA y health | BLOCKED |
| P1-02 | Comparar migraciones D1 remotas con el repositorio | Historial/versión sin drift | BLOCKED |
| P1-03 | DNS, MX/TXT, Email Routing y catch-all | Plan de solo lectura | BLOCKED |
| P1-04 | Correo externo a buzón y alias; persistencia D1/KV | IDs anonimados y trazas | BLOCKED |
| P1-05 | Rechazo de destinatario no autorizado | Respuesta y logs | BLOCKED |
| P1-06 | Envío a buzón externo con Resend | Message ID anonimado, delivered | BLOCKED |
| P1-07 | Webhook firmado, inválido, duplicado, bounced/failed | Estado y rechazo de firma | BLOCKED |
| P1-08 | Reply/Reply All entrante y saliente, CC sin self/duplicados | Thread y destinatarios de prueba | BLOCKED |
| P1-09 | Reenvío adjuntos; límites 5 archivos, 5 MB/cada uno y 10 MB total | Archivos sintéticos y error esperado | BLOCKED |
| P1-10 | Guardar/reabrir borrador, texto con adjuntos y confirmación al descartarlos | Estado tras recarga y diálogo | BLOCKED |
| P1-11 | Dos dispositivos: edición concurrente rechazada con 409 | Resultado versionado | BLOCKED |
| P1-12 | Spam/Papelera/legacy y restauración | Conteos/ubicaciones | BLOCKED |
| P1-13 | read_only, send_only, read_write, MFA, revocación y aislamiento tenant | 403/404 esperados y acceso autorizado | BLOCKED |
| P1-14 | 320/390 px, teclado móvil, altura reducida, safe-area y desktop | Capturas anonimizadas y ausencia overflow | BLOCKED |
| P1-15 | Límites Free Cloudflare/Resend y scheduler/mantenimiento | Cuotas observadas y ejecuciones | BLOCKED |

**BLOCKED** significa “evidencia operativa no obtenida en esta auditoría”, no “funcionalidad fallida”.

## Observación de despliegue — 2026-11-05

- Consulta de la interfaz pública abierta en `https://mailme.msmmystore.com/` mediante sesión de navegador conectada: la pantalla de acceso todavía muestra `expira después de 30 días`.
- La rama `main`, commit `cdd0625058a8f5928c70f392d303e85f8a6f3321`, muestra el texto corregido `expira a las 12 horas o tras 2 horas de inactividad` y un test automatizado para impedir regresiones.
- **Diagnóstico:** inconsistencia observable entre la interfaz consultada y `main`. Posibles explicaciones incluyen despliegue anterior, caché del navegador/asset o una versión diferente del frontend. No se ha observado el SHA efectivo del Worker; por tanto **NO afirmar causa raíz**.
- P1-01 continúa **BLOCKED** hasta confirmar SHA de deployment, invalidación/versión de assets y revisión en sesión limpia. Este control es prioritario antes de cualquier prueba E2E.
- Las consultas públicas HTTP por el canal externo de lectura no estuvieron disponibles; las pestañas del panel Cloudflare y del diagnóstico autenticado tampoco entregaron contenido. No inferir fallo del servicio ni DNS a partir de estos errores de acceso de herramientas.


## Auditoría consolidada — 2026-11-05 (evidencia posterior a PR #45)

**Base Git:** `main` commit `76e48083686aa3d448cd3e54991da8fc03cedfac`. **CI:** PR #45, run `42060977218`, job `127362315458` concluido en éxito (typecheck, tests y contratos, PWA, security). **Cobertura observada:** 133 tests de código + 9 tests de sonda pública, todos PASS; esto **no** constituye E2E autenticado.

**Pruebas de producción aportadas por el operador:**
- Frontend `/`: HTTP 200, contenido actual; `/index.html` y variante con query controlada: redirecciones canónicas 307; `qa:p1:public-deploy` PASS.
- `/api/health`: `{"status":"ok","service":"MSM MAIL","environment":"preview"}`; solicitud anónima a API privada: HTTP 401.
- Wrangler deployment listado: versión `a423e816-61f9-455e-9ac0-208c297d2ebb`, creada `2026-11-05T16:01:12Z`, **Source: Unknown**. El ID no prueba por sí solo que el bundle sea idéntico al SHA Git.
- D1 `msm-mail-preview-db`: `wrangler d1 migrations list --remote` comunica `no migrations to apply`; aún falta inspeccionar el historial aplicado y el esquema real.
- DNS: tres MX Cloudflare, SPF, DMARC y TXT DKIM publicado; Resend Domains en estado `Verified`, según operador.
- Cloudflare Email Routing: panel conectado muestra regla **Catch-all**, **Activo**, destino `msm-mail-preview`; no se modificó configuración.
- Cuenta de prueba MSM MAIL: `/api/sending/readiness` devuelve `ready=true`, `reason=ready_for_attempt`; `/api/sending/diagnostic` devuelve `reachable=true`, `bindingPresent=true`, HTTP 200.
- Operador confirma envío desde MSM MAIL a Gmail y recepción correcta; también confirma recepción externa hacia MSM MAIL. **Evidencia E2E manual declarada**, no incluye IDs anonimizados de eventos, firma de cabecera ni persistencia D1/KV observada.
- `plan:dns` y `plan:email-routing` no ejecutados por falta de `CONTROL_PLANE_ADMIN_TOKEN`; no se creó ni compartió token.

**Matriz de cobertura P1-07 a P1-15 (auditoría de una ronda):**

| Control | Cobertura automática CI de main | Evidencia E2E en entorno | Estado de aceptación |
|---|---|---|---|
| P1-07 webhook Svix / duplicados / bounced / failed | Firma válida/rechazos, preflight de webhook y relay probados | Falta registro real de eventos, duplicados y estados finales | BLOCKED — E2E |
| P1-08 Reply y Reply All, CC y threading | Respuestas inbound/outbound, deduplicación, hilos e idempotencia probados | Sin recorrido de buzón autenticado verificado | BLOCKED — E2E |
| P1-09 forward con adjuntos y límites | Permisos, tamaños, carga del original y validación MIME probados | Sin adjuntos sintéticos enviados y recibidos | BLOCKED — E2E |
| P1-10 borradores y descartar adjuntos | Autosave, conservación de texto y confirmación de descarte probados | Sin recarga de sesión real y prueba de interfaz | BLOCKED — E2E |
| P1-11 concurrencia dos dispositivos y 409 | Versionado y compare-and-swap probados | Sin dos sesiones reales concurrentes | BLOCKED — E2E |
| P1-12 Spam/Papelera/legacy | Aislamiento de Spam virtual y marcadores legacy probados | Sin mover/restaurar correo de prueba en producción | BLOCKED — E2E |
| P1-13 permisos/MFA/aislamiento | MFA, sesiones, revocación, guards read_only/send_only probados | Anónimo 401 comprobado; matriz multi-rol no recorrida | BLOCKED — E2E |
| P1-14 móvil 320/390, desktop, safe-area | Contratos responsive y compositor móvil probados | Sin capturas comparativas reales | BLOCKED — E2E |
| P1-15 Free y scheduler | Límites simulados Resend/D1/KV/Workers y scheduler probados | Sin medición de consumo real / DLQ / mantenimiento | BLOCKED — operativa |

**Política:** no confundir la suite CI verde con entrega, persistencia o roles certificados en producción. P1-04/P1-06 tienen **PASS manual reportado** y pendientes de trazabilidad; P1-01 tiene **PASS parcial** (salud/bindings públicos) pendiente de procedencia binaria del bundle. P1-02 migraciones pendientes cero, pendiente de cotejo estructural. P1-03 DNS y routing evidenciados, pendiente de inspección íntegra de reglas y trazas de mail.

**Próxima certificación:** obtener evidencia anonimizada y ejecutable de los controles de la tabla en sesión autorizada, sin reutilizar tokens de bootstrap, sin alterar DNS de forma automática y sin enviar a destinatarios no autorizados.

## Política GO/NO-GO
- **GO** solo si P1-01..15 = PASS, el SHA desplegado tiene CI verde, no hay defectos P0/P1 y se verificaron rutas DNS/Resend.
- **NO-GO** si hay cualquier FAIL o BLOCKED sin aceptación explícita de alcance.
- No desplegar, cambiar DNS, enviar correos reales ni modificar instalaciones sin cuentas de prueba autorizadas y acceso operativo. No activar pagos ni superar cuotas Free.
- Tras PASS registrar fecha, SHA, autor de aceptación y evidencia; pasar deuda técnica no bloqueante a P2.

## Próxima ejecución
1. Confirmar el deploy SHA en Cloudflare.
2. Leer diagnósticos y planes DNS/routing sin escribir cambios.
3. Ejecutar E2E con buzones de prueba controlados y registrar resultado por ID.
4. Auditar cuotas y cerrar acta GO/NO-GO.

Este documento es una **matriz de certificación**, no un certificado de producción.
