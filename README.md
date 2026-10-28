<div align="center">

<img src="clinq-logo.png" alt="ClinQ logo" width="120">

# ClinQ

**Banco de preguntas médicas personal · Personal medical question bank**

[**Abrir la app / Open the app →**](https://parphelyos.github.io/ClinQ/)

![Status](https://img.shields.io/badge/status-active-13845b) ![Single file](https://img.shields.io/badge/app-single%20HTML%20file-335eea) ![Languages](https://img.shields.io/badge/UI-ES%20%7C%20EN-a96b10) ![Privacy](https://img.shields.io/badge/data-stays%20in%20your%20browser-13845b)

</div>

---

## Español

ClinQ convierte tus materiales de estudio en sesiones de práctica estilo USMLE. Importa un PDF, Word, Excel o texto, practica en modo práctica o examen y revisa qué necesitas repasar. Todo funciona en el navegador; no hay cuenta obligatoria.

### Funciones

- **Importar** PDF, DOCX, XLSX, TXT, CSV, Markdown y JSON (con bloques y variantes). Detección automática de preguntas, opciones y claves.
- **Crear casos con IA** desde un PDF (opcional), con revisión antes de guardar.
- **Sesiones** de práctica y examen guardadas automáticamente; varias a la vez.
- **Subrayados con notas**, notas por pregunta, imágenes del caso y de la explicación.
- **Modo tutor**: al seleccionar un término muestra Wikipedia, enfoque clínico (cuadro clínico, diagnóstico, tratamiento…), MedlinePlus, Europe PMC e imágenes, y permite buscar el caso completo en Google.
- **Valores normales** de laboratorio a un clic.
- **Progreso** por documento, especialidad y disciplina.
- **Carpetas** de preguntas marcadas, modo noche y atajos de teclado.
- **Sincronización opcional** con una carpeta oculta de tu propio Google Drive.
- **Móvil**: barra inferior de navegación y botones anterior/siguiente sobre el caso.
- **Español e inglés** desde el menú ⚙ Opciones.

### Uso

1. Abre <https://parphelyos.github.io/ClinQ/>.
2. Ve a **Importar archivos** y sube tu documento, o pega el texto.
3. Revisa la vista previa y guarda las preguntas.
4. Entra a **Practicar**, elige filtros y empieza.

> Exporta un respaldo de vez en cuando (⚙ Opciones → Exportar respaldo). Si borras los datos del navegador, se pierden.

### Ejecutar en local

```bash
git clone https://github.com/Parphelyos/ClinQ.git
cd ClinQ
python -m http.server 8080
# abre http://localhost:8080/
```

El inicio de sesión con Google no funciona desde `file://`; usa un servidor local o GitHub Pages.

### Configuración opcional

| Qué | Dónde |
|---|---|
| ID de cliente OAuth de Google (sincronización con Drive) | `window.CLINQ_GOOGLE_CLIENT_ID` en `app.html` |
| URL de la función de IA (crear casos desde PDF) | `window.CLINQ_API_URL` en `app.html`; la función está en `api/` y se despliega en Vercel |

### Estructura

| Archivo | Descripción |
|---|---|
| `app.html` | La aplicación completa (HTML, CSS y JS en un solo archivo) |
| `api/`, `generate.js`, `vercel.json` | Función serverless para generar casos con IA |
| `terms.html`, `privacy.html` | Condiciones del servicio (incluye derechos de autor) y política de privacidad |
| `clinq-logo.png` | Logotipo |

### Privacidad y derechos de autor

Tus preguntas se guardan en tu navegador y, si inicias sesión, en un archivo oculto de tu Drive. Lee la [política de privacidad](https://parphelyos.github.io/ClinQ/privacy.html) y las [condiciones](https://parphelyos.github.io/ClinQ/terms.html).
Importa solo material que tengas derecho a usar. Wikipedia (CC BY-SA 4.0), Wikimedia Commons, Openverse, MedlinePlus y Europe PMC conservan sus licencias.
ClinQ es una herramienta educativa, **no ofrece consejo médico**, y no está afiliada a USMLE, NBME ni Google.

© 2026 Parphelyos. Todos los derechos reservados salvo que se añada una licencia al repositorio.

---

## English

ClinQ turns your study materials into USMLE-style practice sessions. Import a PDF, Word, Excel file or text, practice in practice or exam mode, and see what to review. Everything runs in the browser; no account is required.

### Features

- **Import** PDF, DOCX, XLSX, TXT, CSV, Markdown and JSON (blocks and variants). Automatic detection of questions, options and keys.
- **AI case creation** from a PDF (optional), reviewed before saving.
- **Sessions** for practice and exam, auto-saved; several at once.
- **Highlights with notes**, per-question notes, case and explanation images.
- **Tutor mode**: select a term to see Wikipedia, a clinical overview (presentation, diagnosis, treatment…), MedlinePlus, Europe PMC and images, plus a button to search the whole case on Google.
- **Normal lab values** one click away.
- **Progress** by document, specialty and discipline.
- **Folders** for flagged questions, night mode and keyboard shortcuts.
- **Optional sync** to a hidden folder in your own Google Drive.
- **Mobile**: bottom navigation bar and previous/next buttons above the case.
- **Spanish and English** from the ⚙ Options menu.

### Usage

1. Open <https://parphelyos.github.io/ClinQ/>.
2. Go to **Import files** and upload your document, or paste text.
3. Check the preview and save the questions.
4. Open **Practice**, pick filters and start.

> Export a backup now and then (⚙ Options → Export backup). Clearing browser data deletes your bank.

### Run locally

```bash
git clone https://github.com/Parphelyos/ClinQ.git
cd ClinQ
python -m http.server 8080
# open http://localhost:8080/
```

Google sign-in does not work from `file://`; use a local server or GitHub Pages.

### Privacy and copyright

Your questions live in your browser and, if you sign in, in a hidden file in your Drive. See the [privacy policy](https://parphelyos.github.io/ClinQ/privacy.html) and [terms](https://parphelyos.github.io/ClinQ/terms.html).
Only import material you have the right to use. Wikipedia (CC BY-SA 4.0), Wikimedia Commons, Openverse, MedlinePlus and Europe PMC keep their own licenses.
ClinQ is an educational tool, **not medical advice**, and is not affiliated with USMLE, NBME or Google.

© 2026 Parphelyos. All rights reserved unless a license is added to the repository.
