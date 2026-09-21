---
name: depurar
description: Delega una corrección menor de Moodboard en el subagente "depurador" (Sonnet). Uso: /depurar <qué falla o qué arreglar>. Para bugs pequeños, tests que fallan, errores de tipos, textos o estilos entre PRs.
---

Lanza el subagente `depurador` con la tarea que viene en los argumentos.

1. Si no hay argumentos, pregunta en una línea qué hay que arreglar.
2. Llama a la herramienta `Agent` con `subagent_type: "depurador"` y un
   `prompt` que incluya: la tarea literal del usuario, la rama actual
   (`git branch --show-current`) y la instrucción de no comprometer ni subir
   salvo que el usuario lo haya pedido en la misma orden.
3. Espera el informe del subagente y transmítelo al usuario en español, sin
   resumir de más: qué fallaba, qué cambió, cómo lo verificó y qué queda
   fuera.
4. Si el subagente dice que la tarea excede un arreglo menor, no insistas:
   presenta su propuesta al usuario y espera su decisión.
