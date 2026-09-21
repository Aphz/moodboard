# Sincronizar tus tableros entre iPhone y iPad

Moodboard funciona sin conexión y sin servidor. Si además quieres que tus
tableros aparezcan en todos tus dispositivos, puedes conectar la app a un
proyecto **tuyo** de [Supabase](https://supabase.com) (plan gratuito).

Los datos quedan en tu proyecto: nosotros no vemos ni guardamos nada.

Tiempo estimado: **5 minutos**.

---

## 1. Crear el proyecto (1 min)

1. Entra a <https://supabase.com> y crea una cuenta gratis.
2. **New project**. Ponle el nombre que quieras (por ejemplo `moodboard`),
   elige una contraseña para la base de datos y la región más cercana.
3. Espera a que termine de aprovisionarse (aparece "Project is ready").

## 2. Ejecutar el esquema SQL (1 min)

1. En el menú lateral, abre **SQL Editor** → **New query**.
2. Copia el contenido completo de [`supabase/schema.sql`](../supabase/schema.sql)
   y pégalo en el editor.
3. Pulsa **Run**. Debería decir *Success*.

Eso crea:

- la tabla `scenes` (una fila por tablero, con el JSON de la escena),
- las políticas **RLS** para que cada usuario sólo vea sus propias filas,
- el bucket de Storage `blobs` (privado) y sus políticas por carpeta,
- la publicación de **Realtime** sobre `scenes`, que es lo que hace que los
  cambios aparezcan en vivo en el otro dispositivo.

## 3. Verificar el bucket `blobs` (30 s)

El script ya lo crea, pero conviene revisarlo:

1. Menú lateral → **Storage**.
2. Debe existir un bucket llamado `blobs` y **no** debe decir *Public*.
   Si no existe, créalo con **New bucket** → nombre `blobs` → deja
   *Public bucket* **desactivado** → **Create**.

Dentro del bucket, cada imagen se guarda en `blobs/<tu-user-id>/<blobId>`.
Las políticas RLS impiden que alguien entre a la carpeta de otro usuario.

## 4. Activar el inicio de sesión con código por correo (1 min)

Moodboard entra con un **código de un solo uso** (OTP) enviado a tu correo,
no con contraseña ni con enlace mágico.

1. Menú lateral → **Authentication** → **Sign In / Providers** → **Email**.
2. Deja **Enable Email provider** activado.
3. Desactiva **Confirm email** (así el primer inicio de sesión no exige
   confirmar antes de entrar).

   Si prefieres dejar esa opción activada, entonces edita la plantilla del
   correo: **Authentication** → **Emails** → **Magic Link** (y también
   *Confirm signup*), y asegúrate de que el cuerpo incluya el token:

   ```html
   <p>Tu código para Moodboard es: <b>{{ .Token }}</b></p>
   ```

   Si la plantilla sólo trae `{{ .ConfirmationURL }}`, recibirás un enlace en
   vez de un código y la app no podrá completar el inicio de sesión.

4. (Opcional) En **Authentication** → **URL Configuration** no hace falta
   tocar nada: la app no usa redirecciones.

## 5. Copiar URL y clave anon a la app (1 min)

1. Menú lateral → **Project Settings** → **API** (o **Data API**).
2. Copia:
   - **Project URL** — algo como `https://abcdefghijkl.supabase.co`
   - **anon public** — una cadena larga que empieza con `eyJ…`
3. En Moodboard, toca el icono de **nube** en la barra superior.
4. Pega la URL y la clave anon → **Guardar configuración**.
5. Escribe tu correo → **Enviar código** → revisa tu bandeja → escribe el
   código de 6 dígitos → **Entrar**.

Repite el paso 5 en el otro dispositivo **con el mismo correo**. En unos
segundos verás los mismos tableros en los dos.

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
- El correo de cortesía de Supabase tiene un límite bajo de mensajes por hora.
  Si vas a iniciar sesión seguido, configura tu propio SMTP en
  **Authentication → Emails → SMTP Settings**.
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
| "Revisa la URL…" al guardar | La URL debe empezar con `https://` y no llevar `/` final. |
| No llega el correo | Límite de envío del correo de cortesía, o el mensaje cayó en spam. |
| Llega un enlace en vez de un código | Falta `{{ .Token }}` en la plantilla (paso 4). |
| Las imágenes no aparecen en el otro dispositivo | El bucket `blobs` no existe o le faltan las políticas del paso 2. |
| Los cambios no llegan en vivo | Falta el `alter publication supabase_realtime add table public.scenes` del paso 2. |
| Estado "Error" en el icono de nube | Abre el diálogo de la nube: muestra el mensaje exacto del servidor. |
