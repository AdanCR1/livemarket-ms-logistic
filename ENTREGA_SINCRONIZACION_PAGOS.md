# Sincronización de pagos y reservas — entrega 2026-11-06

Implementado exclusivamente en MS2, MS4 y MS6. No se aplicó SQL ni se desplegaron Workers. No se ejecutó ningún débito ni se entregó el evento real.

## Cambios concretos

- MS2 `src/routes/internal.ts`: POST interno `/inventory/status`, autenticado con `MS2_INTERNAL_KEY`, lee `id/store_id/state/expires_at`. No invoca COMMIT/RELEASE. No necesita migración: usa la tabla y permisos existentes.
- MS4 `src/services/payment-events.service.ts`: consulta la prueba persistida de MS6, ignora cualquier fecha del emisor, registra PREPARE, consulta MS2, confirma solamente RESERVED, reconoce COMMITTED y finaliza el pedido después de la confirmación. RELEASED/pago tardío generan `RESOLUTION_REQUIRED` sin tocar custodia ni reservar de nuevo.
- MS4 `src/services/inventory.service.ts`: consulta de estado con comprobación de identidad.
- MS4 `src/routes/internal.routes.ts`: pasa bindings; COMMIT del reconciliador exige recibo y usa el mismo flujo recuperable. RELEASE queda diferido sin garantía financiera segura.
- MS4 SQL `20261106_timely_payment_receipts.sql`: ledger con event_id, payment_id y order_id únicos; paid_at auténtico separado de processed_at; bloqueo del pedido; PREPARE/FINALIZE idempotentes; respaldo de las RPC originales; protección de RELEASE; expiración conservadora.
- MS6 `src/services/payment-proof.ts` y ruta interna: devuelve fecha, identidades e importe persistidos de un pago ORDER_PAYMENT/PAID con escrow existente. GET `/api/internal/payments/:id/proof`, protegido por `PAYMENTS_INTERNAL_KEY`.
- MS6 `src/services/payment-outbox.ts`: conserva business event_id; valida contra pago persistido; selector payment_id u outbox_id; claim con lease y ACK v2 solamente después de respuesta real exitosa. Errores quedan FAILED/reintentables; ACK perdido deja lease recuperable.
- MS6 `src/services/ms4-client.ts`: conserva códigos seguros de error del consumidor para diagnóstico de resolución manual.
- MS6 `src/routes/qr.routes.ts`: waitUntil después de execute_qr_payment exitoso, sin depender del navegador ni hacer otro cobro.
- MS6 `src/index.ts`, `wrangler.jsonc`: Scheduled Handler y Cron cada minuto. No llama a liquidación, reembolso ni reparación bancaria.
- MS6 SQL `20261106_order_payment_dispatch.sql`: claim específico/filtro de pedidos usando leases v2 existentes. El Cron solo reclama eventos creados desde la instalación. Históricos requieren selector explícito; SUBSCRIPTION_CHANGED queda intacto.

## Limitación deliberada de expiración

La RPC de expiración nueva difiere los pedidos pendientes vencidos con `FINANCIAL_CLEARANCE_REQUIRED`, y el reconciliador no ejecuta RELEASE automáticamente. Esto retiene stock impagado; no se presenta como liberación automática resuelta. Consultar «no hay pago» y liberar no es seguro: el débito puede estar en vuelo. Restablecer esa automatización requiere validar un cierre atómico de intentos en MS6 contra execute_qr_payment, cuyo SQL real no está disponible en el repositorio. No se altera esa RPC financiera sin esa validación. Las reservas pagadas oportunamente pueden conciliarse mientras sigan RESERVED/COMMITTED.

## SQL: destino, orden y rollback

Antes de empezar, detener consumidores antiguos/manuales v1/v2 y jobs de expiración/release externos. Las migraciones son transaccionales, se ejecutan una sola vez y no reproducen eventos históricos.

1. **MS2:** ningún SQL nuevo. Mantener `ms2_inventory_reservations`, `ms2_finish_inventory_reservation` y permisos service_role existentes.
2. **Supabase MS4:** ejecutar `D:\Grado\livemarket-ms-logistic\sql\20261106_timely_payment_receipts.sql`. Depende de orders, inventory_outbox y ambas RPC actuales. Respalda las RPC por rename; nuevas funciones solo service_role.
3. **Supabase MS6:** ejecutar **solo** `D:\Grado\livemarket-ms-payments\sql\20261106_order_payment_dispatch.sql`. Depende de v2 ya instalada. **No volver a ejecutar 20261105_payment_outbox_leases.sql.**

Con conexiones PostgreSQL configuradas de forma privada, comandos equivalentes:

```powershell
psql $env:MS4_DATABASE_URL -v ON_ERROR_STOP=1 -f D:/Grado/livemarket-ms-logistic/sql/20261106_timely_payment_receipts.sql
psql $env:MS6_DATABASE_URL -v ON_ERROR_STOP=1 -f D:/Grado/livemarket-ms-payments/sql/20261106_order_payment_dispatch.sql
```

Los archivos `test_timely_payment_receipts.sql` y `test_order_payment_dispatch.sql` son fixtures con ROLLBACK para base aislada. No ejecutarlos sobre producción: emplean supuestos de fixture, no inspeccionan usuarios reales. Las funciones probadas solo operan PostgreSQL, sin HTTP ni extensiones de red.

Rollback: detener Cron/consumidores, comprobar que los recibos aplicados tienen outbox SENT y que no hay conciliaciones pendientes. Ejecutar primero el archivo MS6 `20261106_order_payment_dispatch.rollback.sql` (rechaza leases activos), después MS4 `20261106_timely_payment_receipts.rollback.sql` (rechaza recibos no APPLIED). El ledger MS4 se conserva; no hay rollback de saldos/estados pagados. Restaurar Workers anteriores de forma coordinada. No reactivar el expirador anterior con pagos no notificados.

## Despliegue aprobado: MS2 → MS4 → MS6

No hay variables runtime nuevas. Se usan las claves internas existentes por HTTPS, incluso entre cuentas distintas. No habilitar `ESCROW_AUTO_SETTLEMENT_VERIFIED=true`.

```powershell
Set-Location D:/Grado/livemarket-ms-catalog
pnpm exec wrangler deploy --minify
Set-Location D:/Grado/livemarket-ms-logistic
pnpm exec wrangler deploy --minify
Set-Location D:/Grado/livemarket-ms-payments
pnpm exec wrangler deploy --minify
```

Entre MS4 y MS6 puede haber una ventana con proof 404: los eventos permanecen reintentables. Planificar la actualización coordinada. Desplegar MS6 habilita el Cron declarado; los eventos anteriores al corte quedan excluidos. No ejecutar `/reconcile` global para recuperar este pago.

## Recuperar exclusivamente el pago indicado

Lectura real realizada: la reserva `res_e9828e00-f4f1-4aa8-9601-5ab5acee9084` estaba RESERVED, y MS4 PENDING_PAYMENT/PENDING. Esta lectura no bloquea cambios posteriores: el flujo vuelve a consultar y COMMIT es idempotente.

Tras SQL y despliegues aprobados, usar claves en variables de sesión privadas, nunca pegarlas en el informe:

```powershell
$ms6='https://livemarket-ms-payments.soportenonis.workers.dev'
$ms2='https://livemarket-ms-catalog.jasoncortezreyes.workers.dev'
$paymentsHeaders=@{'X-Internal-Key'=$env:PAYMENTS_INTERNAL_KEY}
$inventoryHeaders=@{'X-Internal-Key'=$env:MS2_INTERNAL_KEY}
Invoke-RestMethod "$ms6/api/internal/payments/36ba13f6-d4c2-446c-a5e8-6d3018bdf7b7/proof" -Headers $paymentsHeaders
Invoke-RestMethod "$ms2/api/internal/inventory/status" -Method Post -Headers $inventoryHeaders -ContentType application/json -Body '{"reservation_id":"res_e9828e00-f4f1-4aa8-9601-5ab5acee9084"}'
# Única operación de recuperación: no cobra y no reclama otros eventos.
Invoke-RestMethod "$ms6/api/internal/process-outbox" -Method Post -Headers $paymentsHeaders -ContentType application/json -Body '{"outbox_id":"360b30f5-614a-4728-ac6a-8a9086688893"}'
```

Antes de recuperar, proof debe indicar order_id `c1998ee1-eae2-4616-a228-956bec148eff`, 20 BOB, PAID y paid_at previo a `2026-11-06T03:54:19.105612Z`. No enviar una fecha inventada. La entrega conserva business event_id `31242314-aa64-4b56-a9cc-5db786dfdbd6`.

Esperado: claimed=1, sent=1, failed=0, ack_failed=0. Si claimed=0, consultar status/next_retry_at/claimed_at: puede estar SENT, en backoff o con lease activo. Esperar el backoff/lease y repetir exactamente el mismo selector; no resetear estados mediante SQL. Un segundo intento tras SENT reclama cero. Si RESOLUTION_REQUIRED, conservar HELD y resolver manualmente; no forzar COMMIT ni reembolso.

Verificación SQL **solo lectura** en las bases respectivas:

```sql
-- MS4
select id,status,payment_status from public.orders where id='c1998ee1-eae2-4616-a228-956bec148eff';
-- Esperado CONFIRMED / PAID
select event_id,payment_id,paid_at,state,reason,processed_at from public.ms4_payment_receipts
 where order_id='c1998ee1-eae2-4616-a228-956bec148eff';
-- Esperado evento original / APPLIED
-- MS2
select id,state from public.ms2_inventory_reservations
 where id='res_e9828e00-f4f1-4aa8-9601-5ab5acee9084'; -- COMMITTED
-- MS6
select id,status,attempts,last_error,claim_token from public.payment_outbox
 where id='360b30f5-614a-4728-ac6a-8a9086688893'; -- SENT / claim_token NULL
select id,status,amount,currency,paid_at from public.payments
 where id='36ba13f6-d4c2-446c-a5e8-6d3018bdf7b7'; -- PAID / 20 BOB
select status from public.escrow_settlements where payment_id='36ba13f6-d4c2-446c-a5e8-6d3018bdf7b7'; -- HELD
select count(*) from public.bank_transactions where payment_id='36ba13f6-d4c2-446c-a5e8-6d3018bdf7b7' and tx_type='PURCHASE_PAYMENT'; -- 1
```

Verificación HTTP del pedido, con sesión del comprador:

```powershell
Invoke-RestMethod 'https://livemarket-ms-logistic.soportenonis.workers.dev/api/orders/c1998ee1-eae2-4616-a228-956bec148eff' -Headers @{Authorization="Bearer $env:BUYER_ACCESS_TOKEN"}
```

Abrir el QR del pedido en Mis pedidos: el polling de MS4 debe mostrar «Pago confirmado» y retirar «Vence en». No se modificó el frontend: la condición ya existe y se probó con navegador y fixtures.

## Pruebas ejecutadas

- MS2: 1 prueba HTTP autenticada/read-only; Wrangler dry-run PASS. Typecheck con TypeScript del MS4 detecta errores preexistentes en index.ts/private.ts (console/lib, JWT cast, validation.data); no se modificaron esos archivos.
- MS4: typecheck PASS; 27 pruebas unitarias/rutas/regresión PASS.
- MS6: typecheck PASS; 12 pruebas PASS (Cron, selector, autenticación, rechazo lógico, ACK fallido, escrow, logs).
- PostgreSQL aislado PGlite: ambas migraciones, pruebas con ROLLBACK y sus rollbacks PASS; leases, reintentos, ACK repetido/obsoleto, aislamiento de históricos y SUBSCRIPTION_CHANGED.
- Integración HTTP + PostgreSQL real aislado: 9 escenarios PASS: inmediato, tardío oportuno, COMMITTED, RELEASED, pago fuera de plazo, MS2 temporal, respuesta FINALIZE perdida, despachos concurrentes, Cron. Usa handlers reales de los tres servicios y adaptador HTTP PostgREST simulado; no es una prueba distribuida de Supabase/Cloudflare. PGlite serializa conexiones: no se afirma una prueba multi-sesión de PostgreSQL remoto.
- Navegador Edge: prueba existente frontend PASS y prueba explícita de retirada del contador PASS, con fixtures.
- Wrangler dry-run MS2/MS4/MS6 PASS; ninguna publicación. MS6 usa Wrangler 3 y emite advertencia de versión, sin fallo de bundle.

Comandos reproducibles (Node 24; PGLITE_MODULE apunta al módulo PGlite instalado en un directorio de herramientas, no a Supabase):

```powershell
Set-Location D:/Grado/livemarket-ms-logistic
pnpm exec tsc --noEmit
node --experimental-transform-types --import ./tests/register-ts.mjs --test tests/internal-routes.test.mjs tests/payment-sync.test.mjs tests/inventory.test.mjs tests/plans.test.mjs tests/checkout.test.mjs tests/delivery-access.test.mjs
$env:PGLITE_MODULE='file:///C:/Users/jason/AppData/Local/Temp/marketcloud-workers-audit-pg/node_modules/@electric-sql/pglite/dist/index.js'
node tests/sql-payment-sync.mjs
node --experimental-transform-types --import ../livemarket-ms-payments/tests/register-ts.mjs tests/payment-flow.integration.mjs
node tests/payment-ui.browser.mjs
Set-Location D:/Grado/livemarket-ms-payments
pnpm exec tsc --noEmit
node --import ./tests/register-ts.mjs --test tests/outbox.test.mjs tests/logging.test.mjs tests/dispatch.test.mjs
node tests/sql-dispatch.mjs
Set-Location D:/Grado/livemarket-ms-catalog
node --import ../livemarket-ms-payments/tests/register-ts.mjs --test tests/reservation-status.test.mjs
```

Si PGlite no está instalado, instalarlo en un directorio aislado de herramientas con pnpm y ajustar PGLITE_MODULE; las pruebas no cargan .dev.vars ni credenciales reales. La prueba UI necesita Astro local activo; usar `pnpm exec astro dev --background` en frontend. La lectura opcional `tests/read-payment-schema.mjs` sí usa .dev.vars para consultas GET, no forma parte de la simulación ni de la instalación.
