# Botones de acción — el color aparece al pasar por encima

Los botones de acción de las tablas son iconos neutros en reposo y **toman el
color de lo que hacen cuando el puntero pasa por encima**.

## Por qué no siempre

En reposo los iconos son neutros a propósito: una columna de botones de
colores repetidos en cada fila es ruido, y a la tercera fila **deja de
significar nada** — un rojo que aparece veinte veces ya no dice "cuidado".

El color aparece cuando importa, que es el instante antes del clic. Ahí sí
hay una decisión que tomar, y el color es lo que la informa.

También responde a `:focus-visible`: quien navega con teclado necesita la
misma pista que quien usa el mouse.

## La convención

Las clases se nombran **por token y no por acción** (`act--go`, no
`act--guardar`), igual que `chip--go` o `banner--warn` en el resto del panel:
la clase dice qué tono usa, y esta tabla dice dónde va cada tono.

| Clase | Tono | Para acciones que… | Ejemplos |
| --- | --- | --- | --- |
| `act--go` | verde | confirman o completan | Guardar cambios, Marcar entregado, Marcar resuelto |
| `act--redline` | rojo | cancelan o destruyen | Cancelar pedido |
| `act--ignition` | naranja | modifican o toman control | Editar, Tomar ticket |
| `act--violet` | violeta | crean algo aparte | Crear promoción |
| `act--chrome` | celeste | llevan a otro lado | Reasignar al asistente, Ver conversación |

**Un botón sin clase queda neutro, y eso también es una decisión.** El
chevron de expandir no lleva color: abre y cierra la propia fila, no lleva a
ningún lado ni cambia nada.

"Ver conversación" sí lo lleva, en `act--chrome`. Por eso ese tono se define
como **"lleva a otro lado"** y no como "reencamina": abarca tanto mandar el
caso de vuelta al asistente como abrir la conversación en otra pantalla. Las
dos sacan el foco de esta fila.

## Se unificaron dos sistemas

Tickets ya tenía el suyo —`btn--icon-go`, `btn--icon-amber`,
`btn--icon-chrome`— que pintaba el icono **siempre** e intensificaba en
hover. Funcionaba, pero dejaba al panel con dos mecanismos para lo mismo y a
Tickets comportándose distinto del resto sin motivo.

Los tres se migraron conservando exactamente su color; lo único que cambia es
**cuándo** aparece. Las reglas viejas se borraron: hay un test que verifica
que no vuelvan.

## Dónde tocar

Las reglas viven junto a `.btn--ghost` en `STYLE_BLOCK`. Para un botón nuevo,
agregarle la clase del tono que le corresponda según la tabla de arriba —
no hace falta CSS nuevo.

Si un tono nuevo hiciera falta, necesita su par de tokens (`--x` y
`--x-soft`) en **las dos paletas**. `--ignition-soft` se agregó con este
cambio: existía `--go-soft`, `--redline-soft`, `--violet-soft` y
`--chrome-soft`, pero el naranja de marca no tenía su versión suave y se
venía resolviendo con `rgba()` a mano en cada sitio.

## Una sola línea, siempre

`.rowactions` es `flex-wrap: nowrap`. Con `wrap` y una columna angosta, los
tres botones de Productos caían **dos arriba y uno abajo**, y la fila entera
crecía de alto por eso.

Que entren depende de tres cosas que van juntas:

- **`gap: 6px`** entre botones (era 8).
- **`padding` lateral de 12px** en la celda que los contiene (era 16), vía
  `td:has(> .rowactions)`.
- **El ancho de la columna en píxeles, no en porcentaje.** Con
  `table-layout: fixed` el porcentaje manda estricto, así que una columna de
  botones necesita el ancho que los botones ocupan y no una fracción de la
  tabla, que cambia con cada pantalla. La cuenta: `n × 34px + (n−1) × 6px +
  24px` de padding — **130px para tres botones, 100px para dos**.

Al agregar un botón a una fila hay que subir el ancho de su columna. Si no,
con `nowrap` el icono nuevo no se envuelve: se corta.

### Apoyados a la derecha

Los iconos de la última columna se alinean al borde derecho de la celda, que
es el borde de la tabla: así quedan **alineados entre filas** por más que la
columna cambie de ancho, y el ojo los encuentra siempre en el mismo sitio al
recorrer hacia abajo.

El selector es `td:last-child > .rowactions` y no una clase, a propósito: la
celda "Asignado a" de Tickets **también** usa `.rowactions`, pero lleva el
nombre del asesor adelante y no es la última — ahí el texto tiene que empezar
a la izquierda como el resto de la tabla. La regla la excluye sola, sin una
excepción escrita a mano que alguien tenga que recordar.

El encabezado acompaña con `th--end`, que sí es una clase: hay tablas que
terminan en texto (Resumen, Descripción) y ahí un título a la derecha no
tendría sentido.

## Cobertura

`tests/integration/gateway/admin.test.ts`: que Cancelar lleva `act--redline`
y Guardar/Editar sus tonos, que **el color solo aparece bajo `:hover` /
`:focus-visible`** y nunca en la regla base de la clase, que no quedan
rastros del sistema viejo de Tickets, y que `.rowactions` no vuelve a
`flex-wrap: wrap`.
