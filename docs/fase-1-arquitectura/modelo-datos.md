# Modelo de Datos (PostgreSQL)

Todas las tablas con datos de negocio incluyen `tenant_id` y quedan protegidas por Row Level Security (ver [ADR-004](./adrs/ADR-004-multi-tenancy-rls.md)). No se detalla DDL/SQL en esta fase — es diseño conceptual, la implementación llega en fases posteriores.

## Diagrama entidad-relación

```mermaid
erDiagram
    TENANTS ||--o{ CUSTOMERS : tiene
    TENANTS ||--o{ PRODUCTS : tiene
    TENANTS ||--o{ CONVERSATIONS : tiene
    TENANTS ||--o{ PROMOTIONS : tiene
    TENANTS ||--o{ HUMAN_AGENTS : tiene

    CUSTOMERS ||--o{ CONVERSATIONS : origina
    CONVERSATIONS ||--o{ MESSAGES : contiene
    CONVERSATIONS ||--o{ QUOTES : genera
    CONVERSATIONS ||--o{ HANDOFF_QUEUE : puede_escalar

    PRODUCTS ||--o{ INVENTORY : tiene_stock_en
    PRODUCTS ||--o{ QUOTE_ITEMS : referenciado_en
    PRODUCTS ||--o{ ORDER_ITEMS : referenciado_en

    QUOTES ||--o{ QUOTE_ITEMS : contiene
    QUOTES ||--o| ORDERS : puede_convertirse_en

    ORDERS ||--o{ ORDER_ITEMS : contiene
    HANDOFF_QUEUE }o--|| HUMAN_AGENTS : asignada_a

    TENANTS {
        uuid id PK
        text name
        text plan
        timestamptz created_at
    }
    CUSTOMERS {
        uuid id PK
        uuid tenant_id FK
        text phone_number
        text name
        timestamptz created_at
    }
    CONVERSATIONS {
        uuid id PK
        uuid tenant_id FK
        uuid customer_id FK
        text status
        jsonb state
        timestamptz started_at
        timestamptz closed_at
    }
    MESSAGES {
        uuid id PK
        uuid conversation_id FK
        text direction
        text sender_type
        text content
        jsonb tool_calls
        timestamptz created_at
    }
    PRODUCTS {
        uuid id PK
        uuid tenant_id FK
        text sku
        text name
        text category
        numeric price
        vector embedding
        timestamptz updated_at
    }
    INVENTORY {
        uuid id PK
        uuid product_id FK
        uuid tenant_id FK
        int stock_quantity
        text source
        timestamptz last_synced_at
    }
    PROMOTIONS {
        uuid id PK
        uuid tenant_id FK
        text type
        jsonb rules
        date valid_from
        date valid_to
        boolean active
    }
    QUOTES {
        uuid id PK
        uuid tenant_id FK
        uuid conversation_id FK
        uuid customer_id FK
        numeric subtotal
        numeric discount
        numeric total
        text status
        timestamptz created_at
    }
    QUOTE_ITEMS {
        uuid id PK
        uuid quote_id FK
        uuid product_id FK
        int quantity
        numeric unit_price
    }
    ORDERS {
        uuid id PK
        uuid tenant_id FK
        uuid quote_id FK
        uuid conversation_id FK
        uuid customer_id FK
        text status
        text payment_method
        text delivery_method
        text idempotency_key
        numeric total
        timestamptz created_at
    }
    ORDER_ITEMS {
        uuid id PK
        uuid order_id FK
        uuid product_id FK
        int quantity
        numeric unit_price
    }
    HANDOFF_QUEUE {
        uuid id PK
        uuid tenant_id FK
        uuid conversation_id FK
        text reason
        text status
        uuid assigned_to FK
        timestamptz created_at
        timestamptz resolved_at
    }
    HUMAN_AGENTS {
        uuid id PK
        uuid tenant_id FK
        text name
        text contact
        boolean active
    }
    AUDIT_LOG {
        uuid id PK
        uuid tenant_id FK
        uuid conversation_id FK
        text actor
        text action
        jsonb input
        jsonb output
        timestamptz created_at
    }
```

## Notas de diseño por tabla

- **`tenants`** — una fila por PyME cliente (ej. ForMotos). Toda tabla de negocio cuelga de aquí vía `tenant_id`.
- **`conversations.state`** — memoria conversacional estructurada (no solo texto crudo): qué productos se mencionaron, en qué paso del flujo va el cliente, etc. Es lo que el orquestador lee para no "olvidar" contexto entre turnos.
- **`messages.tool_calls`** — guarda qué tool se invocó y con qué parámetros en ese turno, para trazabilidad fina a nivel de mensaje (complementa `audit_log`, que es la vista de auditoría a nivel de decisión de negocio).
- **`products.embedding`** — vector `pgvector` para similitud semántica, usado por la tool `recomendar_producto` sin necesidad de una vector DB separada.
- **`inventory.source` / `last_synced_at`** — necesario porque ForMotos hoy lleva el inventario en Google Sheets; el diseño permite que `source` cambie (Sheets, API de un ERP, CSV) sin tocar el resto del modelo.
- **`promotions.rules` (jsonb)** — modela tanto promociones por temporada (fechas de vigencia + % descuento) como por volumen (tramos de cantidad + beneficio), que es exactamente el caso de ForMotos. Estructura propuesta:
  ```json
  { "kind": "volumen", "tiers": [{"min": 10, "max": 20, "discount_pct": 5}, {"min": 20, "max": 40, "discount_pct": 10}] }
  { "kind": "temporada", "label": "fin_de_año", "discount_pct": 15 }
  ```
- **`orders.idempotency_key`** — obligatorio y único por tenant; evita pedidos duplicados si el webhook de WhatsApp reintenta la entrega de un mensaje.
- **`handoff_queue`** — cola explícita de conversaciones escaladas; separada de `conversations.status` para poder tener una bandeja de trabajo del asesor humano.
- **`audit_log`** — inmutable (solo insert), registra cada decisión del agente para depuración y confianza; es el requisito de observabilidad más básico del sistema.

## Row Level Security

Política estándar aplicada a toda tabla con `tenant_id`:

```sql
-- Ejemplo conceptual, no DDL final
CREATE POLICY tenant_isolation ON <tabla>
    USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

La sesión de base de datos setea `app.tenant_id` al inicio de cada request/turno de conversación, según el tenant resuelto desde el número de WhatsApp entrante.
