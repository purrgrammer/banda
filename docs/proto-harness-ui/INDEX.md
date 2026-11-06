# Prototipo de UI de harness — Velázquez

Pantallazos del specimen (`#/specimen`), secciones de harness. Cada imagen muestra
**claro y oscuro lado a lado** (el modo "Both" del specimen). `-desktop-` usa marcos
de ancho escritorio; `-phone-` marcos de 390px (ancho teléfono).

- Rama: `proto/velazquez-harness-ui` en `~/code/banda-velazquez-proto` (NO fusionar).
- `antes/`: main (`d9249fe`), servido desde un worktree aparte con home desechable.
- `despues/`: el prototipo, mismo método.

## antes/ (main)

| Archivo | Qué muestra |
|---|---|
| `harness-header-*` | Actividad delegada en la cabecera del chat |
| `harness-*` (sin sufijo de sección) | El flujo entero en un chat (conectar → trabajar → ask → fin) |
| `harness-states-*` | La tarjeta en cada estado + tiles de conexión |
| `harness-panel-*` | Los pasos en el panel: todo desplegado, crudo |

## despues/ (prototipo)

| Archivo | Qué muestra |
|---|---|
| `harness-header-*` | Igual que antes (sin cambios aquí) |
| `harness-*` | El flujo entero; la línea de la tarjeta ahora habla en palabras del owner |
| `harness-states-*` | Estados: working, waiting, done, stopped, interrupted y **failed** (nuevo) |
| `harness-headlines-*` | **Nuevo**: la línea de la tarjeta con un run largo con `cd … &&` (prefijo fuera, truncado por el medio) y con una lectura |
| `harness-asks-*` | **Nuevo**: 1 ask de comando; ask de edición con diff largo (ventana acotada + "Show all"); 3 asks (la más vieja entera, el resto plegado en una línea; sin approve-all) |
| `harness-panel-*` | Los pasos plegados a una línea cada uno; filas-botón que abren el detalle; «asked» a 3 líneas con «Show all» |
| `harness-sheet-*` | **Nuevo**: la hoja plegada por defecto; con un run y un diff abiertos; acotada y siguiendo lo último (con «Simulate streaming») |
| `harness-sheet-streaming-*` | **Nuevo**: la hoja a media transmisión, pegada al último paso mientras llegan más |
| `harness-sheet-scrolled-up-*` | **Nuevo**: tras subir, deja de seguir y aparece «Jump to latest» |
| `harness-sheet-row-closeup` | **Nuevo**: recorte ampliado de filas, para ver el icono centrado sobre la primera línea |

## Qué cambia (resumen)

1. **Titulares humanizados** (`headlineOf`): sin `cd <ruta> &&`, rutas relativas al
   proyecto, frases para rg/grep (`Searching for "…"`), cat/head/sed (`Reading …`),
   ls (`Listing …`), tests (`Running tests`), git (`Checking git`); pasado una vez corrido
   (`Ran tests`, `Searched for`). Truncado por el medio, nunca al final.
2. **Hoja de pasos plegada**: cada paso es una fila de una línea (botón real,
   `aria-expanded`, ≥44px en táctil por un halo invisible, sin mover el texto) que abre el
   comando crudo, el diff o el texto entero; «asked» a 3 líneas con «Show all» (la medida,
   no una cuenta de caracteres, decide si hay corte); «said»/«thought» pliegan a una línea.
   La expansión se guarda por paso con una clave absoluta (`stepKey` + `dropped`): no se
   mueve cuando el daemon descarta pasos viejos y un paso nuevo jamás llega desplegado.
   La hoja abre en el último paso y lo sigue (el stick-to-bottom del chat); al subir deja
   de seguir y aparece «Jump to latest»; sin scroll suave con `prefers-reduced-motion`.
   El icono de cada fila queda centrado sobre la primera línea del texto.
3. **Asks de una en una**: la más vieja entera; comando o diff largos en ventana acotada
   con «Show all» (hoja a pantalla completa); el resto plegado («2 more waiting · …»).
   Sin approve-all. Botones con verbo propio («Run / Don't run», «Allow / Don't change»).
4. **Notificaciones tranquilas**: el aviso del dispositivo dice el harness, el tipo de
   cosa y el proyecto («pi asks to run a command in banda»), nunca el comando ni la ruta.
5. **Foco al abrir la hoja**: va al título, no al primer botón Copy de un Terminal.
