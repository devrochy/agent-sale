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

## Editar una cuenta

Hasta acá el panel solo sabía **crear** una cuenta y **prenderla o
apagarla**. Corregir un correo mal escrito, o cargarle el teléfono a
alguien, exigía un `UPDATE` contra la base — y el Perfil solo sirve para
uno mismo.

El teléfono es la razón concreta por la que esto no podía esperar: **sin él
una cuenta no puede recuperar su contraseña** (ver
[contrasena.md](./contrasena.md)), y el único que podía cargarlo era su
propio dueño desde el Perfil, que es exactamente lo que no puede hacer quien
ya se quedó afuera.

El lápiz de cada fila abre un diálogo con los mismos campos del alta —
usuario, correo, teléfono, rol— y el mismo tratamiento visual, porque es el
mismo formulario respondiendo las mismas preguntas.

### Lo que no se puede hacer desde acá

**La contraseña.** Que un master pueda fijar la de otro convierte
Colaboradores en una puerta trasera a cualquier cuenta. El diálogo lo dice y
señala el camino que sí existe: el enlace de recuperación.

**Bajarse a uno mismo el rol master.** Se perdería el acceso a esta pantalla
en el mismo submit, sin forma de volver a subirse — y si es el único master,
el panel se queda sin nadie que pueda gestionar cuentas. En vez de dejar el
control disponible y rebotar el submit, el rol se muestra como dato y viaja
en un `hidden`: **un control que siempre falla es peor que no tener
control.** La regla igual se valida en el servidor, porque el `hidden` es del
lado del cliente.

**El avatar.** Es algo que cada uno se pone en su Perfil. Pero hay que
reenviarlo igual en el `UPDATE`: `updateAdminProfile` reemplaza los cuatro
campos, y omitirlo le borraba la foto a la persona editada. Hay un test para
esa regresión.

### Tres formularios, una sola regla

Usuario, correo y teléfono son los mismos tres campos con las mismas reglas
en el alta, en la edición y en el Perfil. Vivían copiados en dos de ellos;
el tercero habría hecho tres copias, y con ellas la garantía de que un día
se ajustara el largo del usuario en un sitio y no en los otros. Ahora es
`validarDatosDeCuenta`, que además **normaliza** —minúsculas, teléfono
armado con su prefijo— porque normalizar también es parte de la regla:
`Ana.Perez` y `ana.perez` no pueden ser dos cuentas distintas.

### El chequeo de usuario en vivo aprendió un tercer caso

`GET /admin/username-disponible` sabía excluir al admin logueado
(`excludeSelf=1`, del Perfil). Editando a **otra** cuenta hacía falta
excluir a la editada: sin eso, abrir el diálogo de alguien y salir del campo
reportaba su propio usuario actual como "en uso". `excludeAdminId` solo se
honra para un master, que es el único que puede abrir esa pantalla.

## Cobertura

`tests/integration/gateway/admin.test.ts`, bloque "colaboradores": que la
barra de herramientas existe **y que las filas traen contra qué comparar**
(un filtro sin `data-filter-*` en las filas se dibuja y no hace nada), que el
texto de confirmación habla de acceso y **no** del catálogo, y que el
teléfono sale como número — sin el dígito suelto y sin el prefijo de Twilio.

De la edición: que un master puede cambiarle el correo y **cargarle el
teléfono** a otra cuenta, que puede cambiarle el rol pero **no quitarse el
suyo**, que guardar **no le borra el avatar** a la persona editada, y que el
chequeo en vivo no reporta como ocupado el usuario de la cuenta que se está
editando.
