# Sincronizar tus tableros entre iPhone y iPad

Moodboard funciona sin conexión y sin servidor. Si además quieres que tus
tableros aparezcan en todos tus dispositivos, puedes conectar la app a un
proyecto **tuyo** de [Supabase](https://supabase.com) (plan gratuito).

Los datos quedan en tu proyecto: nosotros no vemos ni guardamos nada.

**No hace falta el correo electrónico en ningún momento**: la cuenta se crea
con correo y contraseña, sin códigos ni enlaces mágicos. Y el asistente de la
app comprueba cada paso por ti (✅ / ❌ / ⏳) y te dice exactamente qué falta.

Tiempo estimado: **5 minutos**, y sólo en el primer dispositivo.

---

## En Supabase: tres pasos

### 1. Crear el proyecto

1. Entra a <https://supabase.com> y crea una cuenta gratis.
2. **New project**. Ponle el nombre que quieras (por ejemplo `moodboard`),
   elige una contraseña para la base de datos y la región más cercana.
3. Espera a que aparezca *Project is ready*.

### 2. Ejecutar el SQL (un solo pegado)

1. Menú lateral → **SQL Editor** → **New query**.
2. Pega el contenido completo de [`supabase/schema.sql`](../supabase/schema.sql)
   y pulsa **Run**. Debería decir *Success*.

   En la app, el paso 3 del asistente trae el botón **Copiar SQL**: copia ese
   mismo archivo al portapapeles y el botón de al lado abre este editor.

El script es idempotente (puedes volver a ejecutarlo) y deja listo todo de una
vez:

- la tabla `scenes` (una fila por tablero, con el JSON de la escena),
- las políticas **RLS** para que cada usuario sólo vea sus propias filas,
- el bucket de Storage `blobs` (privado) y sus políticas por carpeta,
- la publicación de **Realtime** sobre `scenes`, que es lo que hace que los
  cambios aparezcan en vivo en el otro dispositivo.

### 3. Desactivar "Confirm email"

1. Menú lateral → **Authentication** → **Sign In / Providers** → **Email**.
2. Deja **Enable Email provider** activado.
3. Desactiva **Confirm email** → **Save**.

Así la cuenta queda creada y con sesión iniciada al instante, sin esperar
ningún correo. Es el paso clave: el correo de cortesía de Supabase sólo
permite unos pocos mensajes por hora y no sirve para esto.

En la app, el paso 2 del asistente comprueba esto solo y trae un botón que
abre esta misma página del panel.

---

## En la app: URL, clave y contraseña

### 4. Pegar la URL y la clave anon

1. En Supabase: **Project Settings** → **API** (o **Data API**). Copia:
   - **Project URL** — algo como `https://abcdefghijkl.supabase.co`
   - **anon public** — una cadena larga que empieza con `eyJ…`
2. En Moodboard, toca el icono de **nube** de la barra superior.
3. Pega las dos cosas en el **paso 1** y pulsa **Probar**.

Si la URL o la clave están mal, el asistente te lo dice en castellano ("La
clave anon no sirve…", "No pudimos conectar con esa URL…"). Si están bien, se
guardan solas y los pasos 2 y 3 se comprueban al tiro.

### 5. Crear la cuenta con contraseña

En el **paso 4**, escribe tu correo y una contraseña de **al menos 8
caracteres**, y pulsa **Entrar o crear cuenta**.

- La primera vez, la cuenta se crea y entras de inmediato.
- Las siguientes, entras con la misma contraseña.
- Si te equivocas de contraseña, la app avisa que esa cuenta ya existe y la
  contraseña no coincide.

### 6. Pasar la configuración al otro dispositivo

En el dispositivo que ya quedó funcionando, abre el diálogo de la nube y pulsa
**Enviar configuración al otro dispositivo**. La app arma un enlace como:

```
https://aphz.github.io/moodboard/#setup=eyJ1cmwiOi…
```

y lo comparte (hoja de compartir de iOS) o lo copia al portapapeles. Ábrelo en
el otro dispositivo: Moodboard guarda la URL y la clave solas, limpia el
enlace y abre el diálogo de cuenta. Ahí sólo tienes que escribir **el mismo
correo y la misma contraseña**.

> El enlace lleva la clave anon, que es **pública por diseño**: lo que protege
> tus datos son las políticas RLS y tu contraseña, no el secreto de esa clave.

En unos segundos verás los mismos tableros en los dos dispositivos.

---

## Cómo funciona

- Cada tablero (escena) se guarda como una fila en `scenes`, con su JSON
  completo en la columna `data`.
- Las imágenes no viajan en el JSON: cada bitmap se sube una sola vez a
  Storage con un identificador aleatorio y las escenas sólo lo referencian.
  Como los identificadores son únicos, **nunca hay conflictos de imágenes**.
- Cuando dos dispositivos editan el mismo tablero sin conexión, al reconectar
  se **fusionan**: para cada ítem gana la edición más reciente (`mtime`), y los
  borrados se propagan con "lápidas" para que un ítem borrado no reaparezca.
  El encuadre (zoom y desplazamiento) nunca se sincroniza: es de cada
  dispositivo.
- Borrar un tablero en un dispositivo lo marca como `deleted = true` en el
  servidor, y el otro dispositivo lo borra de su copia local.
- Los cambios locales se suben 3 segundos después de la última edición.

## Limitaciones y seguridad

- **Plan gratuito de Supabase** (valores de referencia, revisa los actuales en
  su web): ~500 MB de base de datos, ~1 GB de Storage y ~5 GB de transferencia
  al mes. Para tableros de referencias con imágenes, lo que primero se llena es
  el Storage. Puedes bajar el tamaño de las imágenes en *Ajustes → Optimizar al
  importar*.
- Los proyectos gratuitos se **pausan** tras un período de inactividad; basta
  con reactivarlos desde el panel de Supabase.
- La contraseña la valida Supabase (mínimo 8 caracteres, que es lo que exige
  también la app). Si la olvidas, crea otra cuenta con otro correo o cambia la
  contraseña desde **Authentication** → **Users** en el panel.
- La **clave anon es pública por diseño**: va dentro de la app y cualquiera que
  inspeccione el tráfico puede verla. No es un secreto. Lo que protege tus
  datos son las **políticas RLS** del paso 2, que sólo dejan leer y escribir las
  filas y los archivos cuyo `user_id` coincide con el de la sesión iniciada.
  Nunca pegues aquí la clave `service_role`: esa sí es secreta y se salta RLS.
- La sincronización es opcional. Si no configuras nada, la app sigue
  funcionando completamente sin conexión y no carga ni una línea del SDK de
  Supabase.

## Problemas frecuentes

| Síntoma | Causa probable |
| --- | --- |
| Paso 1 ❌ "No pudimos conectar con esa URL" | La URL no es la del proyecto (`https://<ref>.supabase.co`) o no hay red. |
| Paso 1 ❌ "La clave anon no sirve" | Copiaste otra clave: usa **anon public**, no `service_role` ni la contraseña de la base de datos. |
| Paso 2 ❌ | Falta desactivar **Confirm email** (paso 3 de esta guía) y pulsar **Save**. |
| Paso 3 ❌ "Falta la tabla scenes" / "Falta el bucket blobs" | Todavía no ejecutaste el SQL: usa **Copiar SQL** → **Abrir el editor SQL** → pega → **Run**. |
| "Esa cuenta ya existe y la contraseña no coincide" | El correo ya tiene cuenta: escribe la contraseña con la que la creaste. |
| "Tu proyecto todavía exige confirmar el correo" | Quedó activo **Confirm email**: desactívalo y pulsa **Volver a comprobar**. |
| Las imágenes no aparecen en el otro dispositivo | El bucket `blobs` no existe o le faltan las políticas: vuelve a ejecutar el SQL. |
| Los cambios no llegan en vivo | Falta el `alter publication supabase_realtime add table public.scenes` del SQL. |
| Estado "Error" en el icono de nube | Abre el diálogo de la nube: el paso 4 muestra el detalle traducido. |
