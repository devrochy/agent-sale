# Apariencia del panel — tema claro / oscuro

Selector de apariencia en el menú de cuenta del riel, con tres opciones:
**Sistema**, **Claro** y **Oscuro**.

## Lo que ya existía

La paleta oscura estaba escrita desde el rediseño del panel, dentro de un
`@media (prefers-color-scheme: dark)`: el panel ya se veía en oscuro si el
sistema operativo lo estaba, con sus propios tonos de canal (WhatsApp,
Instagram, Messenger), sombras y colores de estado.

Lo que faltaba era poder **elegir**. Un admin con el sistema en claro no
tenía forma de trabajar en oscuro, y al revés.

## Decisiones

**Tres opciones y no un interruptor.** Un toggle de dos posiciones obliga a
abandonar para siempre el seguimiento del sistema en cuanto se toca una vez:
no hay forma de volver a "lo que diga el sistema operativo" salvo borrando
los datos del navegador. Con "Sistema" como opción explícita, el
comportamiento anterior sigue siendo alcanzable.

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

| Preferencia | `data-theme` en `<html>` | Qué manda |
| --- | --- | --- |
| Sistema (por defecto) | sin atributo | `prefers-color-scheme` |
| Claro | `light` | fuerza claro aunque el sistema esté en oscuro |
| Oscuro | `dark` | fuerza oscuro aunque el sistema esté en claro |

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

## Dónde tocar

Todo en `src/admin/adminPanel.ts`:

| Qué | Constante / clase |
| --- | --- |
| Paleta oscura | `DARK_PALETTE` |
| Script anti-parpadeo | `THEME_BOOT_SCRIPT` |
| Selector en el menú de cuenta | `.themepick` (dentro de `railProfile`) |
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
