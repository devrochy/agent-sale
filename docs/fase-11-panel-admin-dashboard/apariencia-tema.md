# Apariencia del panel — tema claro / oscuro

Switch de apariencia en el menú de cuenta del riel: **Claro** y
**Oscuro**.

## Lo que ya existía

La paleta oscura estaba escrita desde el rediseño del panel, dentro de un
`@media (prefers-color-scheme: dark)`: el panel ya se veía en oscuro si el
sistema operativo lo estaba, con sus propios tonos de canal (WhatsApp,
Instagram, Messenger), sombras y colores de estado.

Lo que faltaba era poder **elegir**. Un admin con el sistema en claro no
tenía forma de trabajar en oscuro, y al revés.

## Decisiones

**Dos estados, no tres.** La primera versión tenía además una opción
"Sistema", para no perder el seguimiento automático del sistema operativo.
Se retiró a pedido: la consecuencia es que **el panel deja de seguir al
sistema en cuanto alguien toca el switch**, y volver a ese comportamiento
exige borrar la clave de `localStorage`. En la primera visita todavía
arranca por `prefers-color-scheme`, y de ahí en más manda lo elegido.

Sol y luna a los lados en vez de las palabras "Claro"/"Oscuro": el par es
universal, no necesita traducción, y el icono apagado se atenúa — así el
estado se lee sin mirar la perilla.

**La preferencia vive en `localStorage`, no en el perfil del admin.** Es una
elección del dispositivo y no de la cuenta: el mismo admin puede querer claro
en el escritorio y oscuro en el celular. Guardarla en `admins` habría exigido
una migración y habría impuesto la misma apariencia en todos sus dispositivos.
Sigue el patrón que el riel ya usaba para su ancho y su estado colapsado.

**Una sola definición de la paleta oscura.** Los mismos valores se aplican por
dos caminos —`prefers-color-scheme` y `[data-theme="dark"]`—, así que viven en
la constante `DARK_PALETTE` de `adminPanel.ts` y se interpolan en ambos
bloques. Duplicarlos a mano era garantía de que un día se tocara un color en
un sitio y no en el otro.

## Cómo funciona

| Situación | `data-theme` en `<html>` |
| --- | --- |
| Primera visita | el que diga `prefers-color-scheme` |
| Switch en Claro | `light` |
| Switch en Oscuro | `dark` |

**El atributo siempre está puesto.** `THEME_BOOT_SCRIPT` lo resuelve por
`prefers-color-scheme` cuando no hay nada guardado, en vez de dejar el
elemento sin atributo: con dos estados, el switch tiene que reflejar algo
real desde el primer render, y arrancar siempre en "claro" mentiría sobre lo
que se está viendo en un equipo configurado en oscuro.

El CSS lo resuelve con dos selectores:

```css
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* paleta oscura */ }
}
:root[data-theme="dark"] { /* la misma paleta oscura */ }
```

El `:not([data-theme="light"])` es lo que permite que "Claro" gane sobre un
sistema operativo en oscuro; sin él, la media query pisaría la elección.

### El parpadeo, y por qué hay un script en el `<head>`

`THEME_BOOT_SCRIPT` se sirve inline en el `<head>`, antes del `<style>`, y lo
único que hace es leer `localStorage` y poner el atributo. Es la única parte
del cliente que no vive en `CLIENT_SCRIPT`, y la razón es visible: ese script
va al final del `<body>`, así que un usuario con "Oscuro" vería el panel
pintado en claro durante un instante en **cada carga de página** antes de
saltar a oscuro.

Si `localStorage` no está disponible (modo privado restrictivo, permisos), el
script no rompe nada: cae en su `catch` y manda la preferencia del sistema.

## El caso que el tema forzado destapó

Un `<dialog>` vive en el **top layer** del navegador, y ahí el UA le asigna
`color: CanvasText` — que **no hereda del `body`**. `dialog.modal` declaraba
su `background` pero no su `color`.

Mientras el tema salía solo de `prefers-color-scheme`, los dos coincidían por
casualidad: sistema en oscuro, `CanvasText` blanco. Al poder **forzar**
"Oscuro" con el sistema en claro, `CanvasText` siguió siendo negro y los
títulos de los modales quedaron negros sobre el panel oscuro.

El arreglo es una declaración: `dialog.modal { color: var(--ink); }`. Hay un
test que lo verifica, porque es la clase de regresión que solo se ve
abriendo un modal con el tema forzado — no aparece revisando la paleta.

**Al agregar un elemento que viva en el top layer** (otro `dialog`, un
`popover`) hay que declararle el color igual: no lo hereda.

## Dónde tocar

Todo en `src/admin/adminPanel.ts`:

| Qué | Constante / clase |
| --- | --- |
| Paleta oscura | `DARK_PALETTE` |
| Script anti-parpadeo | `THEME_BOOT_SCRIPT` |
| Switch en el menú de cuenta | `.themetoggle` (dentro de `railProfile`) |
| Lógica del cambio | bloque "apariencia" de `CLIENT_SCRIPT` |

Al añadir un color nuevo hay que darle su valor en las dos paletas: la clara
en `:root` y la oscura en `DARK_PALETTE`. Un color definido solo en `:root`
se verá igual en ambos temas — que a veces es lo correcto (los tonos de marca
de cada canal, por ejemplo, se mantienen reconocibles), pero conviene que sea
una decisión y no un olvido.

## Cobertura

`tests/integration/gateway/admin.test.ts`, bloque "apariencia (tema
claro/oscuro)": que el menú ofrece las tres opciones, que el script del tema
va en el `<head>` **antes** del `<style>` (la regresión que traería de vuelta
el parpadeo), y que existen los dos caminos de la paleta oscura.
