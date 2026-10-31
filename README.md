# Estructura del proyecto

```text
livemarket-ms-logistic/
├── README.md                           # Documentación del servicio, sus rutas y sus flujos
├── package.json                        # Scripts de desarrollo, despliegue y generación de tipos
├── pnpm-lock.yaml                      # Versiones resueltas de dependencias para pnpm
├── pnpm-workspace.yaml                 # Configuración de compilaciones permitidas en pnpm
├── tsconfig.json                       # Configuración estricta de TypeScript
├── wrangler.jsonc                      # Configuración de Cloudflare Workers (entrada y compatibilidad)
└── src/
    ├── index.ts                        # Inicializa Hono, CORS, rutas, errores y servidor local
    ├── lib/
    │   ├── errors.ts                   # Error de API tipado y aserción de condiciones
    │   └── supabase.ts                 # Cliente de Supabase, comprobación de entorno y errores DB
    ├── middleware/
    │   ├── auth.ts                     # Verifica JWT y proporciona actor y control por rol
    │   ├── plan-access.ts              # Rechaza operaciones que no tengan el plan PLUS
    │   └── tenant.ts                   # Comprueba el acceso de comprador o comercio a un pedido
    ├── repositories/
    │   ├── deliveries.repository.ts    # Consulta envíos y ejecuta RPC de transiciones de entrega
    │   └── orders.repository.ts        # Consulta, crea, lista y transiciona pedidos
    ├── routes/
    │   ├── deliveries.routes.ts        # Endpoints de creación, seguimiento y resolución de envíos
    │   ├── drivers.routes.ts            # Endpoints para que conductores consulten sus envíos
    │   ├── internal.routes.ts           # Webhook de pagos y tareas internas de conciliación
    │   └── orders.routes.ts             # Endpoints de pedidos y cambios de estado
    ├── services/
    │   ├── delivery.service.ts         # Reglas de negocio de creación y ciclo de vida de envíos
    │   ├── inventory.service.ts        # Integración con MS2 para reserva, confirmación y liberación
    │   ├── order.service.ts            # Creación de pedidos y control de transiciones
    │   ├── pairing.service.ts          # Generación de código y hash para vincular conductor y envío
    │   └── payment-events.service.ts   # Aplicación de eventos de pago a través de PostgreSQL
    └── validators/
        ├── deliveries.schema.ts        # Esquemas Zod para peticiones de envíos
        └── orders.schema.ts            # Esquemas Zod para pedidos y estados
```

# LiveMarket MS Logistic

Microservicio HTTP para gestionar pedidos, reservas de inventario y entregas de LiveMarket. Está construido con TypeScript y Hono; usa Supabase/PostgreSQL para persistencia y RPCs, y se integra con MS2 para las operaciones de inventario.

## Lógicas del proyecto

### Autenticación y acceso

- Las rutas de pedidos, envíos y conductores requieren un JWT Bearer válido. El token se verifica contra las claves de `JWT_JWKS_URL`, así como contra `JWT_ISSUER` y `JWT_AUDIENCE`.
- El JWT debe incluir `sub` y un rol `B2C`, `B2B` o `DRIVER`. Para comercios, `store_id` identifica el comercio asociado al actor.
- Los pedidos se restringen por propietario: el comprador accede a sus pedidos y el comercio a los de su tienda. Un conductor no puede listar pedidos.
- Las rutas internas no usan JWT de usuario; validan `X-Internal-Key` con una clave interna. El endpoint de eventos de pago usa `PAYMENTS_INTERNAL_KEY`; las demás rutas internas usan `MS4_INTERNAL_KEY`.
- `requirePlus` comprueba que el plan recibido sea `PLUS`. La integración con el microservicio de suscripciones está indicada como pendiente y esta comprobación no obtiene el plan por sí misma.

### Pedidos e inventario

1. Solo un actor `B2C` puede crear un pedido. La solicitud se valida con Zod y debe incluir una cabecera `Idempotency-Key` de 8 a 128 caracteres alfanuméricos, guiones o guiones bajos.
2. El servicio crea un identificador de solicitud estable combinando el comprador y la clave, y solicita a MS2 una reserva de inventario y una cotización validada. MS2 debe hacer la reserva atómica e idempotente.
3. La reserva, los artículos cotizados, el comprador y los datos de entrega se envían a la RPC `ms4_create_order`. La lectura posterior devuelve el pedido con sus artículos y entregas.
4. Los cambios de estado se procesan mediante `ms4_transition_order`, que valida la transición. El comprador solo puede solicitar la cancelación mientras el pedido siga en `PENDING_PAYMENT`; los cambios del comercio se limitan a los estados aceptados por el esquema.
5. Si falla la escritura del pedido, el servicio intenta liberar la reserva en MS2; si también falla la liberación, registra el error para su seguimiento. La conciliación interna procesa los trabajos pendientes de inventario.

Los pedidos aceptan `PICKUP` o `DELIVERY`; este último exige dirección. Cada pedido admite de 1 a 30 artículos, con cantidad entera positiva de hasta 100 por artículo. Los importes y cotizaciones son responsabilidad de MS2.

### Pagos y conciliación

- `POST /api/internal/payments/events` valida identificadores UUID, estado `PAID` o `FAILED`, importe decimal y moneda `BOB`; la RPC `ms4_apply_payment_event` aplica el evento.
- `POST /api/internal/reconcile` procesa hasta 30 elementos pendientes de `inventory_outbox`. Según la acción, llama a MS2 para confirmar o liberar la reserva. Si hay un error, incrementa los intentos y programa un reintento con espera exponencial, limitada a una hora.
- `POST /api/internal/expire` llama a `ms4_expire_orders`, que expira pedidos pendientes y encola la liberación de inventario de forma atómica en PostgreSQL.
- Estos endpoints internos deben ser invocados por sistemas autorizados. El archivo `wrangler.jsonc` no configura un cron para ejecutarlos.

### Envíos y conductores

- Un comercio puede crear un envío solo para un pedido de su tienda que esté `READY`, pagado (`PAID`) y tenga tipo `DELIVERY`.
- Al crear el envío se genera un código de vinculación de seis dígitos, válido por 10 minutos. Se almacena un HMAC del código y del identificador del envío; el código en texto claro se devuelve una sola vez al comercio.
- Un conductor autenticado puede vincular el envío con el código, actualizar su ubicación y cambiar el estado a `IN_TRANSIT` o `DELIVERED`. Estas operaciones delegan las transiciones en RPCs de PostgreSQL.
- Al cambiar un envío a `DELIVERED`, se notifica a MS6 Escrow para iniciar un temporizador de 5 minutos. Si el comprador abre una disputa, se notifica a MS6 para congelar la retención del saldo y se envía el motivo.
- Las notificaciones de escrow se envían a `POST /api/internal/escrow/delivered` y `POST /api/internal/escrow/dispute` con `X-Internal-Key: PAYMENTS_INTERNAL_KEY`. Son de mejor esfuerzo: los errores de conexión se registran y no impiden completar la operación del envío.
- El comprador propietario puede confirmar la entrega o abrir una disputa con un motivo. La consulta individual oculta el hash del código de vinculación.
- La lista de un conductor devuelve hasta 100 envíos asignados a su identificador.

## API HTTP

Salvo `/health`, los endpoints bajo `/api/orders`, `/api/deliveries` y `/api/drivers` requieren `Authorization: Bearer <JWT>`. Las rutas de `/api/internal` requieren `X-Internal-Key` y tienen las claves descritas en **Autenticación y acceso**. Las respuestas satisfactorias usan `{ "success": true, "data": ... }`; los errores de API incluyen `success: false` y un objeto `error`.

| Método | Ruta | Acceso y propósito |
|---|---|---|
| `GET` | `/health` | Estado del servicio; no requiere autenticación. |
| `POST` | `/api/orders` | `B2C`; crea un pedido. Requiere `Idempotency-Key`. |
| `GET` | `/api/orders` | `B2C` (pedidos propios) o `B2B` (pedidos de su tienda). |
| `GET` | `/api/orders/:id` | Comprador propietario o comercio de la tienda del pedido. |
| `PATCH` | `/api/orders/:id/status` | Actor autorizado según la regla de cambio/cancelación del pedido. |
| `POST` | `/api/deliveries` | Crea envío para un pedido listo, pagado y de entrega. |
| `GET` | `/api/deliveries/:id` | Comprador, comercio relacionado o conductor asignado. |
| `POST` | `/api/deliveries/:id/pair` | `DRIVER`; vincula conductor mediante código. |
| `PATCH` | `/api/deliveries/:id/location` | `DRIVER`; guarda latitud y longitud. |
| `PATCH` | `/api/deliveries/:id/status` | `DRIVER`; actualiza estado de envío. |
| `POST` | `/api/deliveries/:id/confirm` | Comprador propietario; confirma recepción. |
| `POST` | `/api/deliveries/:id/disputes` | Comprador propietario; registra disputa. |
| `GET` | `/api/drivers/deliveries` | `DRIVER`; lista sus envíos. |
| `POST` | `/api/internal/payments/events` | Sistema de pagos; procesa un evento autenticado. |
| `POST` | `/api/internal/reconcile` | Sistema interno; reconcilia reservas pendientes. |
| `POST` | `/api/internal/expire` | Sistema interno; expira pedidos y encola liberaciones. |

## Configuración

Define estas variables en el entorno local o en la configuración segura del entorno de despliegue. No guardes claves reales en el repositorio.

| Variable | Requerida | Uso |
|---|---|---|
| `SUPABASE_URL` | Sí | URL del proyecto Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | Sí | Credencial privilegiada para acceder a la base de datos. |
| `JWT_JWKS_URL` | Sí | URL del conjunto de claves públicas para verificar JWT. |
| `JWT_ISSUER` | Sí | Emisor esperado del JWT. |
| `JWT_AUDIENCE` | Sí | Audiencia esperada del JWT. |
| `MS2_URL` | Sí | URL base del servicio de inventario MS2. |
| `MS2_INTERNAL_KEY` | Sí | Clave para invocar endpoints internos de MS2. |
| `PAYMENTS_INTERNAL_KEY` | Sí | Clave para recibir eventos de pagos. |
| `MS4_INTERNAL_KEY` | Sí | Clave para las demás rutas internas y el HMAC de vinculación. |
| `MS6_URL` | No | URL base de MS6 Escrow; por defecto `http://localhost:8788`. |
| `PORT` | No | Puerto del servidor local; por defecto `8787`. |
| `CORS_ORIGIN` | No | Origen permitido por CORS; por defecto `http://localhost:4321`. |

El esquema de base de datos debe proporcionar las tablas y funciones RPC utilizadas por el código, entre ellas `orders`, `order_items`, `deliveries`, `inventory_outbox`, `ms4_create_order`, `ms4_transition_order`, `ms4_apply_payment_event`, `ms4_expire_orders`, `ms4_pair_delivery`, `ms4_set_location`, `ms4_delivery_status`, `ms4_delivery_confirm` y `ms4_delivery_dispute`.
