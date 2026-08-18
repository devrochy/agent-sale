# Colaboradores — la tabla que faltaba alinear

Colaboradores era **la única tabla del panel sin `data-table`**: sin
búsqueda, sin filtros, sin orden por columna y sin paginado. Por eso se
sentía distinta aunque usara los mismos colores y la misma tipografía que
las demás.

Este cambio no diseña nada nuevo: aplica el sistema que ya existe, y de paso
corrige dos cosas que la pantalla decía mal.

## Lo que se alinea

| Antes | Ahora |
| --- | --- |
| Botón `+` sin etiqueta, en un `blockhead--end` | `+ Nuevo colaborador`, mismo `btn--add` que Productos y Aliados |
| Sin búsqueda | Busca por usuario, correo, teléfono y rol |
| Sin filtros | Filtro por **Rol** y por **Estado** |
| Sin orden | Usuario, Correo, Rol y Estado ordenables |
| Sin paginado | El mismo `pager` que el resto |
| `Guardar` como botón de texto | Icono `btn--ghost btn--icon`, igual que "Guardar cambios" en Aliados |

Los dos filtros no son una elección de catálogo: **Rol y Estado son los
únicos dos ejes por los que esta tabla se corta de verdad**. Teléfono no es
ordenable a propósito — ordenar personas por número no responde ninguna
pregunta.

`ICON_PLUS` quedó sin uso y se borró: esta página era su último consumidor.

## El switch reemplaza al par chip + botón

La fila decía el estado dos veces: un chip `Activo` en su columna y un botón
`Desactivar` en Acciones. Ahora hay un solo control —el mismo
`statusToggleHtml` de Aliados, Categorías y Promociones— que **muestra y
cambia**.

Con él llega lo que acá faltaba: **`data-confirm` pregunta antes de sacarle
el acceso a una persona.** Hasta ahora desactivar a un colaborador era un
clic sin red, mientras que desactivar un aliado sí preguntaba. La asimetría
estaba al revés.

Nadie se desactiva a sí mismo: en la fila propia va el estado sin control, y
el `Vos` se movió al nombre, que es donde se lee como identidad y no como
acción.

### El mensaje de confirmación se volvió parametrizable

`toggleSwitchHtml` traía un texto fijo: *"Deja de estar disponible para el
asistente"*. Es correcto para un producto o un aliado —ahí nació el
control— y **falso para una persona**: lo que pierde un colaborador
desactivado es el acceso al panel.

Antes de duplicar el componente, se le agregó un parámetro opcional
`confirmMessages`. Los cinco usos anteriores no cambian; Colaboradores dice
la consecuencia real:

> ¿Desactivar a bombi? Pierde el acceso al panel y deja de recibir
> notificaciones. Sus tickets y mensajes quedan como están.

Esa última frase existe porque es la primera pregunta que se hace quien está
por desactivar a alguien.

## El teléfono se muestra como un teléfono

La columna imprimía `whatsapp:+573184935933` — el identificador tal como lo
guarda la base. El prefijo `whatsapp:` es de Twilio, nadie reconoce su
número escrito así, y era tan largo que se partía en dos líneas.

`formatWhatsappPhoneDisplay` lo muestra como `+57 318 493 5933`. Agrupa de a
tres desde la izquierda **salvo que el último grupo quede con uno o dos
dígitos**, en cuyo caso se pega al anterior: sin esa regla, un celular
colombiano terminaba en `+57 318 493 593 3`, con un dígito suelto que se lee
como error de tipeo. Es una regla de legibilidad, no un formato por país —
el proyecto acepta cualquier prefijo y no vale la pena arrastrar una tabla de
formatos nacionales para una columna.

El índice de búsqueda lleva el teléfono **dos veces**: formateado, para que
copiar y pegar un pedazo funcione, y en dígitos corridos, que es como lo
escribe quien lo tiene a mano. Lo que no lleva es `whatsapp:`: nadie lo va a
teclear y solo genera coincidencias falsas — buscar "what" devolvería a todo
el que tenga teléfono cargado.

## Un master no tiene permisos que marcar

Sus tres checkbox salían tildados y deshabilitados, porque un master recibe
todas las notificaciones por definición (ver `resolveEffectivePermissions`).
Eran controles que parecían controles y no lo eran. Ahora esa celda lo dice
con palabras —"Todas — un master las recibe siempre"— y su columna de
Acciones queda vacía, porque efectivamente no hay ninguna.

`permisoCheckbox` perdió los dos parámetros que eso volvió muertos
(`adminId`, que nunca se usó, y `disabled`, que ya solo podía ser `false`).

## Cobertura

`tests/integration/gateway/admin.test.ts`, bloque "colaboradores": que la
barra de herramientas existe **y que las filas traen contra qué comparar**
(un filtro sin `data-filter-*` en las filas se dibuja y no hace nada), que el
texto de confirmación habla de acceso y **no** del catálogo, y que el
teléfono sale como número — sin el dígito suelto y sin el prefijo de Twilio.
