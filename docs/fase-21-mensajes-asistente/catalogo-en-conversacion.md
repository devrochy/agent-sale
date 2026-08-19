# Cómo el asistente habla del catálogo

Cuatro cambios sobre lo que el cliente recibe por WhatsApp: sin cantidades de
stock, con salida cuando algo está agotado, con fotos solo cuando las pide, y
con listas que se puedan recorrer.

## El stock deja de existir para el cliente

`consultar_inventario` devolvía `stock: 12`. Mientras el número estuvo
disponible, el agente lo escribía en casi cada respuesta ("Quedan 12", "quedan
4, 5 y 3 respectivamente"), y **el prompt lo autorizaba explícitamente** con
una regla que pedía el formato exacto `"Quedan N"`.

Ese número no le cambia la decisión a nadie: quien quiere un casco lo quiere
igual si hay 3 que si hay 40.

Ahora la tool devuelve **`disponible: boolean`**. No es una regla de prompt
sino un cambio de contrato: **el dato no llega al modelo, así que no puede
filtrarlo**. Mismo criterio que con los datos bancarios de transferencia.

El caso que sí necesita el número —pedir más unidades de las que hay— ya
estaba cubierto: `generar_cotizacion` valida la cantidad real contra la base y
falla con "pediste 5, hay 3 disponibles". Ahí el número es relevante porque el
cliente está intentando comprar.

### El guardrail cambió de propósito

Existía un guardrail (Fase 12.1) que verificaba que cada `"Quedan N"` de la
respuesta coincidiera con un stock real devuelto por una tool. Con el contrato
nuevo, **la lista de cantidades conocidas queda vacía siempre**, así que
cualquier cantidad que el modelo escriba falla la verificación y escala.

Pasó de "que el número sea el correcto" a **"que no se mencione ningún
número"** — sin tocar su mecánica, y haciendo cumplir la regla desde el código
en vez del prompt.

## Cuando algo está agotado

Antes el agente decía que no hay y ahí terminaba. Ahora el prompt fija una
secuencia, en este orden:

1. Decir que ese producto no está disponible.
2. Ofrecer que un asesor lo contacte para conseguirlo o avisarle cuando
   llegue — si acepta, `escalar_a_humano`.
3. Mostrar alternativas que sí estén disponibles.

**El producto agotado no va en esa lista.** La primera versión de la regla no
lo decía y el modelo lo incluía y después se corregía solo en el mismo
mensaje ("Esa no porque está agotada, perdón"), que se lee como un error.

Un producto sin unidades **sigue apareciendo** en la búsqueda, marcado como no
disponible: el agente necesita saber que existe para poder ofrecer el aviso,
en vez de responder "no lo tenemos" sobre algo que sí está en el catálogo.

## La foto, solo si la piden

La regla era "hay foto si `consultar_inventario` devolvió exactamente un
match". Con eso, una búsqueda que casualmente devolvía un solo resultado
mandaba una foto que nadie había pedido.

Ahora la condición es **haber consultado por `sku`**. El prompt ya indicaba
consultar así cuando el cliente pide detalle de un producto puntual, así que
una búsqueda por texto es una exploración y no merece foto — aunque devuelva
un único resultado.

Se lee del input de la tool y no de una señal del modelo: una regla
determinística no se puede desobedecer.

## Listas que se pueden recorrer

Formato obligatorio, una línea por producto:

```
- *Nombre del producto* — $precio
```

Nada más en esa línea: sin descripción, sin tallas, sin emojis, sin sku, sin
cantidades. Máximo 5 productos; si hay más, se dice y se pregunta qué busca
para afinar. La lista cierra con una sola pregunta para elegir, y el detalle
—descripción, tallas, foto— va cuando el cliente elige uno.

### Dos reglas competían

La regla de listas estaba en el bloque "Formato de los mensajes", al final del
prompt, mientras que arriba había otra que decía: *"si viene `description`,
úsala para dar detalle real en vez de responder solo con el precio"*. Sin
distinguir entre hablar de un producto y enumerar varios, esa regla ganaba: el
agente listaba siete cascos con descripción cada uno.

Se arregló acotando la de `description` ("esto aplica cuando hablás de UN
producto") y **moviendo las de lista junto a las reglas de catálogo**, que es
donde el modelo decide qué mostrar — no al bloque de formato tipográfico.

## Un aviso sobre cómo probar esto

Las respuestas del agente **no se pueden verificar contra la cola** si hay más
de un proceso de la app corriendo contra el mismo Redis: todos compiten por el
mensaje y contesta cualquiera, incluido uno con código viejo. Durante este
cambio había 19 procesos acumulados y dos pruebas seguidas dieron resultados
contradictorios por eso.

Para probar el orquestador sin ambigüedad, llamar a `runTurn` directo desde un
script en vez de encolar con `manual:seed-test-message`.

## Cobertura

- `tests/unit/orchestrator/systemPrompt.test.ts` — que el prompt prohíbe decir
  cantidades y ya no trae el formato `"Quedan N"`, que manda ofrecer asesor y
  alternativas ante un agotado, que ata la foto al `sku`, y que fija la forma
  de las listas.
- `tests/unit/orchestrator/loop.test.ts` — que una búsqueda por texto **no**
  manda foto y una por `sku` sí; y que mencionar una cantidad escala, porque
  ya no hay ninguna contra qué verificarla.
- `tests/integration/domains/consultarInventario.test.ts` — que la tool
  devuelve `disponible` y **no** expone `stock`, y que un producto sin
  unidades sale marcado como no disponible en vez de desaparecer.
