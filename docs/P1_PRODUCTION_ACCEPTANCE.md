# MSM MAIL — P1 Engineering Closeout & Production Acceptance

**Estado:** P1 código integrado / producción NO certificada.  
**Entorno objetivo:** mailme.msmmystore.com  
**Base revisada:** main, `9ff26ef71ac821dcf91d01111e988626c822547d` (PR #38).  
**Regla:** no declarar GO hasta ejecutar y adjuntar evidencia E2E sobre el SHA desplegado.

## Evidencia de desarrollo
- #28: Spam/Papelera compatible con D1 y mensajes legados.
- #30–#36: Reply/Reply-All, threading, aislamiento del compositor entre buzones, reenvío de adjuntos, borradores, concurrencia entre dispositivos y lectores read_only.
- #37: viewport/safe-area móvil. Engineering Gate run #87 PASS (typecheck, tests, PWA, security).
- #38: conserva el texto de borradores al adjuntar archivos y exige confirmar el descarte. **Merge observado; ejecución CI posterior sin confirmar.**
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
