# Notificaciones flotantes

Las confirmaciones y los errores del panel dejan de ser un bloque que empuja
el contenido y pasan a ser **notificaciones flotantes en la esquina inferior
derecha**.

## Qué es notificación y qué no

Ésta es la decisión que ordena todo lo demás, porque no todos los `.banner`
del panel eran lo mismo:

| | Ejemplo | Tratamiento |
| --- | --- | --- |
| **Resultado de una acción** | "Cambios guardados.", "Ya existe un aliado con ese nombre." | Toast flotante |
| **Estado de la pantalla** | "Esta cuenta no tiene teléfono cargado…", el candado de Configuración | Sigue siendo `.banner` |

Un estado no puede irse solo a los cinco segundos ni esconderse detrás de un
botón de cerrar: **sigue siendo verdad después**. Convertirlo en toast era
perder información permanente para ganar consistencia visual, que es un mal
negocio. Por eso `.banner` no se borró — quedó con el trabajo que sí le
corresponde, y hay un test que lo protege.

Las pantallas de autenticación (login, recuperar y restablecer contraseña)
también conservan su banner: son un formulario solo en el medio de la
pantalla, ahí el mensaje pertenece al formulario y no hay panel del que
flotar.

## Comportamiento

**Las confirmaciones se van solas a los 5 segundos. Los errores no.** Varios
errores son largos —"Nombre de usuario inválido: 5 a 32 caracteres,
minúsculas, números, puntos o guiones."— y quien los provocó está mirando el
formulario, no la esquina. Se cierran a mano, con la × o volviendo a
intentar.

Con el puntero encima no corre el reloj: si alguien fue a leer el mensaje, no
se le escapa a mitad de frase.

**La URL se limpia sola.** Después del `POST → 303 → GET` la dirección
quedaba con `?guardado=1`, así que recargar repetía la notificación de algo
hecho hacía rato. Se borran solo las claves de notificación (`guardado`,
`error`, `errorContrasena`, `creados`, `actualizados`, `errores`) — los
filtros reales de la página (`?allyId`, `?categoryId`) y el hash de la
pestaña activa de Configuración se conservan.

### El respaldo que hace falta al cerrar

La salida se anima con CSS y el nodo se quita en `animationend`. Eso solo no
alcanza: **las animaciones CSS se pausan mientras la pestaña no se está
pintando**, así que con el panel en una pestaña de fondo el evento no llegaba
nunca y el toast se quedaba en el DOM, ya invisible, con la clase de salida
puesta. Un `setTimeout` de respaldo lo remueve igual. Se descubrió probando
en el navegador, no leyendo el código.

## Un solo stack por página

`.toaststack` es `position: fixed`, así que dónde se interpole en el `body`
da igual — pero **tiene que haber uno solo**: dos se superpondrían en la
misma esquina. El Perfil es la única página con dos orígenes de notificación
(los datos y la contraseña postean a rutas distintas) y los junta en el mismo
stack. Hay un test para eso.

El stack no recibe clicks (`pointer-events: none`) para no tapar lo que haya
debajo en esa esquina; cada toast sí, para poder cerrarlo.

## Accesibilidad y detalle

- `role="alert"` en los errores y `role="status"` en las confirmaciones: los
  dos se anuncian al cargar la página —que es cuando existen, porque los
  pinta el servidor tras el redirect— pero el error interrumpe al lector de
  pantalla y la confirmación espera su turno.
- `prefers-reduced-motion` quita las dos animaciones; el toast aparece y
  desaparece sin transición.
- Bajo 640 px el stack ocupa el ancho y se apoya abajo, donde está el pulgar.
- **El color vive en el borde izquierdo, no en el fondo**, para que un error
  largo se lea sobre el fondo neutro del panel.

## Dónde tocar

| Qué | Dónde (`src/admin/adminPanel.ts`) |
| --- | --- |
| Markup de un stack | `toastStackHtml()` |
| El caso `?error` / `?guardado` | `queryToastsHtml()` |
| Estilos | `.toaststack`, `.toast`, `@keyframes toast-in` / `toast-out` |
| Cerrar, auto-descartar, limpiar URL | bloque "notificaciones flotantes" de `CLIENT_SCRIPT` |

`queryToastsHtml` reemplazó el mismo ternario copiado en diez `render*Page`,
cuya única variación era el texto de éxito. Para una página nueva alcanza con
`const banner = queryToastsHtml(query)` y dejar `${banner}` en el body.

## Cobertura

`tests/integration/gateway/admin.test.ts`, bloque "notificaciones
flotantes": que una confirmación sale como toast **y ya no como banner en el
flujo**, que un error sale como toast con `role="alert"`, que lo que describe
un estado de la pantalla **sigue siendo banner**, y que el Perfil junta sus
dos notificaciones en un solo stack.

Los tests apuntan al markup (`<div class="toaststack"`) y no a la palabra
suelta: `toaststack` también aparece en el CSS y en el script de cada página,
así que un `toContain("toaststack")` pasa siempre y no prueba nada.
