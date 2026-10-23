# Niimbot Druckstudio V18

Web-App zum Gestalten und Drucken von Etiketten auf Niimbot-Druckern über Web Bluetooth – für iPhone (in der App **Bluefy**) und Laptop (Chrome oder Edge).

## Installation auf GitHub Pages

1. Das ZIP **entpacken**.
2. Auf GitHub ein Repository öffnen bzw. neu anlegen (**Public**).
3. `Add file` → `Upload files`. **Nur die Dateien aus dem entpackten Ordner** in die Uploadfläche ziehen – nicht den Ordner selbst und nicht das ZIP. Vorhandene Dateien mit gleichem Namen werden dabei ersetzt.
4. `Commit changes`.
5. Einmalig: `Settings` → `Pages` → `Deploy from a branch` → Branch `main`, Ordner `/(root)` → `Save`.
6. Nach 1–2 Minuten ist die App unter `https://DEINNAME.github.io/REPOSITORY/` erreichbar.
7. iPhone: Adresse in **Bluefy** öffnen (Safari/Chrome auf iOS können kein Bluetooth). Laptop: Chrome oder Edge.

Alle Dateien müssen direkt in der obersten Ebene liegen:

```
index.html          addon.js            niimbot-demo.html
niimbot.js          label-memory.js     label-size.js
registry.json       pdf.min.js          pdf.worker.min.js
README.md           PRUEFBERICHT.md     LIZENZEN.md
NIIMBOT-LICENSE.txt PDFJS-LICENSE.txt
```

Wenn das Update nicht sofort erscheint: Seite einmal neu laden (in Bluefy ggf. Tab schließen und neu öffnen).

## Bedienung in Kürze

- **Oben – Drucker:** `🔗 Verbinden` öffnet die Bluetooth-Auswahl. Modell wird automatisch erkannt. Über `⚙ Drucker` lassen sich Modell, Etikettgröße und Dichte ändern. Auf dem iPhone klappt die Leiste nach dem Verbinden zusammen, damit die Vorschau größer ist.
- **Mitte – Vorschau:** Der rote Rahmen ist der Druckbereich. Elemente antippen und ziehen; mit zwei Fingern zoomen und drehen. `− 100% +` ändert nur die Ansichtsgröße (auf die Prozentzahl tippen = 100 %).
  - **◐ Druckansicht** zeigt genau, was gedruckt wird (der Drucker kennt nur Schwarz und Weiß). Mit `🎨 Original` siehst du die Farben der Vorlage.
  - **⬚ Außen** zeigt Teile außerhalb des Druckbereichs blass an.
  - `↶` / `↷` = Rückgängig / Wiederholen.
- **Unten – Werkzeuge** (Tabs): Dateien, Text, Rundtext, Bild, Ebenen, Position, Vorlagen. Auf dem iPhone lässt sich die Höhe am Griff ziehen oder mit Klein/Mittel/Groß wählen. Auf dem Laptop stehen die Werkzeuge rechts neben der Vorschau.
- **Leiste ganz unten:** `💾 Speichern` (als Vorlage), `🖨️ Drucken`, `🏷 Rollen` (Rollen-Chip lesen, eigene Etikettgrößen anlegen), `⋯` (Druckerstatus, Protokoll).

### Bilder richtig drucken

Im Tab **Bild** pro Bild den **Druckmodus** wählen:

- **Schwarzweiß:** für Logos, Text, Grafiken. Die Grenze zwischen Schwarz und Weiß stellst du mit **Schwelle** oben in der Vorschau-Kopfzeile ein (zwischen Etikettname und „Druckansicht/Original“): höher = mehr Schwarz, niedriger = mehr Weiß. Die Schwelle gilt für das ausgewählte Bild; Standard ist 128.
- **Foto – Rasterung:** stellt Graustufen durch feine Punkte dar. JPG-Fotos verwenden diesen Modus automatisch. Die Schwelle ist dann ausgegraut.

### Etikettgröße wechseln

Beim Wechsel der Etikettgröße werden alle Texte und Bilder proportional angepasst und bleiben bearbeitbar. Jede Größe merkt sich ihre eigene Anordnung – beim Zurückwechseln ist alles wieder genau wie vorher. Rückgängig funktioniert auch hier.

### Vorlagen

Vorlagen werden nur im Browser auf diesem Gerät gespeichert. Für Sicherung oder Gerätewechsel `↓ Als Datei` exportieren und auf dem anderen Gerät `↑ Datei öffnen`. Eine Vorlage, die bei einer anderen Etikettgröße geöffnet wird, wird angepasst; das gespeicherte Original bleibt unverändert.

## Was in V18 geändert wurde

Siehe `PRUEFBERICHT.md` für die vollständige Liste der gefundenen Fehler, der Änderungen und der Tests.

## Probleme

- **„App-Dateien konnten nicht geladen werden“:** Liegen alle Dateien direkt im Hauptverzeichnis (keine Unterordner)? Ist GitHub Pages aktiviert?
- **Kein Bluetooth:** iPhone → Bluefy verwenden. Laptop → Chrome/Edge, Seite über `https://` öffnen.
- **PDF-Schrift fehlt:** Für manche PDFs lädt PDF.js Zusatzschriften von `cdn.jsdelivr.net`; dafür ist Internet nötig. Die PDF-Inhalte selbst bleiben auf dem Gerät.
