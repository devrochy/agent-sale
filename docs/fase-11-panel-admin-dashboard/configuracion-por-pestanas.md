# Configuración por pestañas

Las siete secciones de Configuración pasan de una columna apilada a **cinco
pestañas**, y cada una lleva debajo del nombre el estado real de su área.

## El problema

La página tenía siete bloques uno debajo de otro en una columna de 640 px:
Estado del bot, Modelo de IA, Voz y estilo, Voz de marca, Reporte del
asistente, Encuestas y reseñas, Cobros en línea. Tres consecuencias:

- **Cobros quedaba a un scroll largo del principio.** Lo que menos se toca no
  tiene por qué estar lejos, pero lo que se busca puntualmente sí necesita ser
  alcanzable.
- **No había forma de saber qué faltaba configurar** sin recorrer la página
  entera leyendo cada bloque.
- En pantallas anchas, más de la mitad del ancho quedaba vacío.

## Las pestañas

| Pestaña | Contiene | Estado que muestra |
| --- | --- | --- |
| Agente | Estado del bot · Voz y estilo | `Activo` / `Pausado` |
| Voz de marca | Identidad institucional | `Sin definir` / `3 de 5` / `Completa` |
| Modelo de IA | Proveedor, modelo, API key | Nombre del proveedor o `Automático` |
| Reportes y reseñas | Reporte del asistente · Encuestas | `Diario` / `Cada N días` / `Sin destinatario` |
| Cobros | Wompi | `Conectado` / `Sin configurar` |

El agrupamiento es por pregunta del usuario, no por formulario: "cómo se
comporta el agente" junta el interruptor con el tono, y "qué avisos salen"
junta el reporte que recibe el admin con la encuesta que recibe el cliente.

**El estado en la barra es la decisión de diseño que sostiene el cambio.** Sin
él, unas pestañas solo esconden contenido y obligan a abrir las cinco para
saber qué falta; con él, la barra funciona como un tablero: se ve de un
vistazo que Cobros lleva vacío desde el primer día.

## Persistencia de la pestaña

Cada formulario de Configuración postea a su propia ruta y el servidor
redirige a `/admin/configuracion`. Sin más, guardar Cobros devolvía al usuario
a la primera pestaña, que es donde no estaba trabajando.

La pestaña activa se guarda en `sessionStorage` y se restaura al cargar; el
hash de la URL (`#cobros`) tiene prioridad, para que un enlace directo siga
funcionando. No se guarda en el servidor porque no es un dato del negocio: es
dónde estaba mirando alguien hace diez segundos.

## Voz de marca

Era la pantalla que peor se veía, y por una razón concreta: **`textarea` no
tenía ningún estilo en todo el panel**. Sus cinco campos se renderizaban con
el aspecto por defecto del navegador —fuente monoespaciada, ancho fijo por el
atributo `cols`— en medio de un panel cuidado. Ahora comparten el tratamiento
de los `input`, con altura redimensionable.

Además:

- **Los cinco campos se agrupan en tres preguntas**: cómo se presenta (nombre
  del asistente), qué representa el negocio (misión, visión, valores) y cómo
  se nombran las cosas acá (nomenclatura). Cinco campos seguidos se leen como
  una lista de trámites; tres grupos se leen como tres preguntas.
- **El tope de 500 caracteres por campo se hizo visible.** Existía desde la
  Fase 20 y se validaba al guardar, así que solo se descubría cuando el
  formulario rebotaba. Ahora hay `maxlength` y un contador que aparece al
  escribir — y desaparece con el campo vacío, donde no informa de nada.
- **Un panel de contexto al lado** explica dónde se nota lo que se escribe, y
  dice explícitamente que no hace falta llenarlo todo: un campo vacío no se le
  cuenta al agente, y eso es mejor que rellenarlo con frases de folleto.

## Dónde tocar

Todo en `src/admin/adminPanel.ts`:

| Qué | Dónde |
| --- | --- |
| Botón de pestaña con su estado | `cfgTab()` |
| Cálculo de los estados | `renderConfiguracionPage()`, antes del `body` |
| Estilos | `.cfgtabs`, `.cfgpanel`, `.cfggrid`, `.cfgaside`, `.fieldset` |
| Cambio de pestaña y contador | bloques "configuración" de `CLIENT_SCRIPT` |

Para agregar una sección nueva: colocarla dentro del `cfgpanel` que le
corresponda y, si estrena pestaña, añadir su `cfgTab` **con un estado real**.
Una pestaña con estado inventado o fijo rompe justamente lo que hace útil a la
barra.

## Cobertura

`tests/integration/gateway/admin.test.ts`, bloque "configuración — pestañas":
que las cinco pestañas y sus paneles existen con solo uno visible (sin JS no
deben verse los cinco apilados), que el estado sale de la configuración real y
no de un texto fijo, y que los campos de Voz de marca declaran el tope de 500.
