# Contraseña — cambio y recuperación

Dos caminos para cambiar la contraseña de un admin: **desde el Perfil**, con
sesión iniciada y sabiendo la actual, y **desde el login**, para quien no la
recuerda.

Hasta ahora no existía ninguno. La contraseña se fijaba al crear la cuenta
(alta de colaborador, o `INSERT` a mano en el arranque en frío) y no había
forma de cambiarla desde el panel: olvidarla significaba pedirle a alguien
con acceso a la base que reescribiera `admins.password_hash`. Eso dejó de ser
aceptable cuando el panel salió a Internet (ver
[despliegue-coolify.md](../despliegue-coolify.md)).

## El canal, que es la decisión que ordena todo lo demás

Una recuperación necesita mandarle algo a alguien por un camino que ya
controle. El proyecto **no tiene correo**: no hay SMTP, ni proveedor de
envío, ni una sola llamada a `sendMail` en el repo. Lo que sí tiene, y usa
todos los días, es WhatsApp hacia el teléfono de cada admin — por ahí sale el
Reporte del asistente (`jobs/dailyReport.ts`), la notificación de
escalamiento (`escalarHumano.ts`) y el aviso de pago.

Así que el enlace va por WhatsApp, y no se introduce SMTP. Agregar correo
solo para esto significaba una dependencia nueva, un proveedor que
configurar, credenciales que rotar y un canal más que puede fallar en
silencio, para llegar al mismo teléfono al que ya le hablamos.

**La consecuencia hay que mirarla de frente: una cuenta sin teléfono cargado
no se puede recuperar sola.** `admins.phone` es opcional (migración 0034) y
hay cuentas reales sin él. Por eso el bloque de contraseña del Perfil avisa,
en la cuenta que no tiene teléfono, que no va a poder recuperarla — ahí, que
es donde está el campo para arreglarlo, y no en el login, donde ya sería
tarde. Si la cuenta ya quedó afuera, la salida sigue siendo escribir el hash
contra la base, como hasta ahora.

## Los tres pasos del enlace

| Paso | Ruta | Qué pasa |
| --- | --- | --- |
| Pedirlo | `POST /recuperar-contrasena` | Emite el token e intenta mandarlo por WhatsApp |
| Abrirlo | `GET /restablecer-contrasena?token=…` | Valida el token y dibuja el formulario |
| Usarlo | `POST /restablecer-contrasena` | Consume el token y reescribe la contraseña |

Viven fuera de `/admin`, igual que `/login`: son justamente las rutas para
quien no puede autenticarse, así que el hook de sesión no las toca.

### El acuse es siempre el mismo

Que el identificador no exista, que la cuenta esté desactivada o que no tenga
teléfono terminan en el mismo redirect y el mismo texto que el caso exitoso.
Un formulario público que respondiera distinto sería un buscador de nombres
de usuario válidos para cualquiera que pase. La diferencia sí queda en el log
del servidor (`event: admin.recuperar_contrasena`), que es donde un admin
puede mirarla sin ser el atacante.

Por lo mismo `solicitarRecuperacionContrasena` no devuelve nada y atrapa sus
propios errores: si WhatsApp falla, el formulario responde igual.

### Qué guarda la tabla

`admin_password_resets` (migración 0055) guarda el **SHA-256** del token, no
el token. Los otros dos tokens del repo —`handoff_tokens`, `review_tokens`—
lo guardan en claro, y para ellos alcanza: abren una conversación concreta.
Éste reescribe una credencial, así que un volcado de la base o un backup
viejo no puede alcanzar para entrar con él.

El token en claro existe una sola vez, en el mensaje de WhatsApp. Después no
está en ninguna parte.

Dos columnas más que ningún token anterior tenía:

- **`expires_at`** — 30 minutos. El enlace llega a un celular que a esa
  altura está en la mano de quien lo pidió; no hace falta la ventana larga de
  un correo que se lee al día siguiente.
- **`used_at`** — un solo uso. Se marca en la misma sentencia que lo lee
  (`UPDATE … WHERE used_at IS NULL … RETURNING`), que es lo que impide que
  dos envíos simultáneos del formulario ganen los dos.

Emitir un token borra los anteriores de esa cuenta: pedir el enlace tres
veces no puede dejar tres enlaces vivos.

**Validar y consumir están separados a propósito.** `GET` solo valida: si
consumiera, el enlace moriría con solo mirarlo, y los previsualizadores de
enlaces lo abren solos.

### El origen del enlace no sale del pedido

`buildPasswordResetLink` arma la URL sobre el origen de `PUBLIC_WEBHOOK_URL`
—mismo criterio que `buildAdvisorLink` en `escalarHumano.ts`, y una variable
de entorno menos—, nunca sobre el header `Host`. Quien dispara el envío es un
anónimo desde un formulario público: con el `Host` bajo su control podría
hacer que al admin le llegue un enlace a un dominio suyo, con el token
adentro.

## Cambiar la contraseña desde el Perfil

Pide la actual. La cookie sola no alcanza para reescribir la credencial de la
cuenta: un navegador prestado, o uno que quedó abierto, es exactamente el
caso contra el que sirve pedirla.

## Cambiar la contraseña cierra todas las sesiones

`updateAdminPassword` reescribe el hash y borra las filas de
`admin_sessions` de ese admin **en la misma transacción**. Vale para los dos
caminos: quien perdió la contraseña bien puede haberla perdido porque alguien
más la tiene, y dejarle viva la cookie al intruso vaciaría de sentido el
cambio.

Por eso los dos caminos terminan en `/login?contrasena=cambiada` y limpian la
cookie: incluido el navegador desde el que se hizo el cambio hay que volver a
entrar. Es la única función de `adminSessionDirectory.ts` que no usa el pool
crudo, justamente para poder compartir esa transacción.

## Techos por ruta

| Ruta | Techo | Por qué ése |
| --- | --- | --- |
| `POST /recuperar-contrasena` | 3/min | Cada pedido válido gasta un WhatsApp al teléfono de un admin: sin techo, el formulario público es un botón para inundar de mensajes a alguien que no pidió nada |
| `POST /restablecer-contrasena` | 10/min | El token es de 256 bits, adivinarlo no es la amenaza; el techo es contra el ruido |
| `POST /admin/perfil/contrasena` | 10/min | Prueba de la contraseña actual, mismo criterio que `POST /login` |

## Dónde tocar

| Qué | Dónde |
| --- | --- |
| Emitir / validar / consumir el token | `src/admin/auth/passwordReset.ts` |
| Reescribir la contraseña y cerrar sesiones | `updateAdminPassword` en `adminsDirectory.ts` |
| Reglas de la contraseña aceptada | `validarContrasenaNueva` en `adminPanel.ts` |
| Las tres páginas | `renderRecuperarContrasenaPage`, `renderRestablecerContrasenaPage`, bloque "Contraseña" de `renderPerfilPage` |
| Rutas | `src/gateway/server.ts` |

El mínimo de 8 caracteres vive en un solo lugar y lo comparten los tres
caminos que fijan una contraseña (alta de colaborador, cambio desde el Perfil
y restablecimiento por enlace). Subirlo se hace ahí y aplica a todos.

## Cobertura

`tests/integration/gateway/admin.test.ts`, bloque "contraseña — cambio y
recuperación": que el login ofrece el camino, que un identificador
inexistente recibe el mismo acuse **y no dispara ningún mensaje**, que el
enlace llega al teléfono de la cuenta y sirve una sola vez, que después del
cambio entra la contraseña nueva y no la vieja, que el Perfil exige la actual
sin cerrar la sesión al fallar, y que un cambio exitoso sí la cierra.

Esos tests usan una cuenta propia: cambiar la contraseña cierra las sesiones,
así que hacerlo sobre el admin master del archivo voltearía todo lo demás.
