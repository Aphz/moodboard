/**
 * Variables de entorno que inyecta Vite en la build (`import.meta.env`).
 *
 * `VITE_GOOGLE_CLIENT_ID` es el ID de cliente OAuth de tipo "Aplicación web"
 * que el desarrollador crea una sola vez en Google Cloud. Es **público** por
 * diseño (viaja dentro del JavaScript de la app): lo que protege los datos es
 * el consentimiento del usuario y el ámbito `drive.file`, que sólo da acceso a
 * los archivos que crea esta misma app.
 */
interface ImportMetaEnv {
  /** ID de cliente OAuth de Google, terminado en `.apps.googleusercontent.com`. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
