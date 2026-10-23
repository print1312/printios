# Niimbot Druckstudio V15 – einfaches neues GitHub-Repository

**Nur 9 technische Dateien, alle im Hauptverzeichnis. Kein `vendor`-Ordner.**

## Installation auf GitHub (Mac/PC)

1. Das ZIP **entpacken**.
2. Auf GitHub „New repository“ wählen, z. B. `niimbot-druckstudio-v15-neu`; **Public** einstellen und erstellen.
3. Das neue Repository öffnen. Bei einem leeren Repository den Link „uploading an existing file“ wählen; sonst `Add file` → `Upload files`.
4. Den **entpackten Ordner öffnen**. **Nur die darin enthaltenen Dateien** (nicht den Ordner und nicht das ZIP!) auswählen und in die GitHub-Uploadfläche ziehen. Es sind 13 Dateien inklusive Anleitungen und Lizenzen. Alle müssen direkt in der obersten Ebene liegen.
5. `Commit changes` wählen.
6. `Settings` → `Pages` → `Build and deployment` → `Deploy from a branch`; Branch `main`, Ordner `/(root)` und `Save`.
7. Nach erfolgreicher Veröffentlichung lautet die Adresse normalerweise: `https://DEINNAME.github.io/niimbot-druckstudio-v15-neu/`.
8. Auf dem iPhone diese Adresse in **Bluefy** öffnen und dort den Drucker verbinden.

### So muss die GitHub-Dateiliste aussehen

```
index.html
addon.js
niimbot-demo.html
niimbot.js
label-memory.js
label-size.js
registry.json
pdf.min.js
pdf.worker.min.js
README.md
LIZENZEN.md
NIIMBOT-LICENSE.txt
PDFJS-LICENSE.txt
```

**Keine Unterordner!** Wenn stattdessen ein Ordner mit einem Namen wie `niimbot-v15-...` angezeigt wird, wurde versehentlich der äußere Ordner hochgeladen.

### Hinweise

- Die originalen Niimbot-Bluetooth-Treiber, Modellliste, RFID-Rollenverwaltung und die V15-Bearbeitung sind in diesem Paket enthalten.
- PDF.js und dessen Worker liegen lokal. Zusätzliche PDF-CMaps und PDF-Standardschriften werden **nur bei Bedarf** über `cdn.jsdelivr.net` geladen. Dafür ist eine Internetverbindung erforderlich. Die PDF-Dateiinhalte selbst werden lokal im Browser verarbeitet, nicht auf den CDN hochgeladen.
- Die gespeicherten Vorlagen und benutzerdefinierten Schriftarten sind browserprofil- und originabhängig. Wenn du eine neue GitHub-Pages-Adresse unter demselben `username.github.io` verwendest, kann sich die Speicher-Umgebung mit alten Repositories teilen; das ist keine automatische Cloud-Synchronisierung. Sicherheitshalber vorher Vorlagen als JSON exportieren.
- GitHub verarbeitet eine hochgeladene ZIP-Datei **nicht** automatisch. Unbedingt entpacken und die Dateien hochladen.
- Die Verbindung mit einem echten Bluetooth-Niimbot erfordert HTTPS und einen Web-Bluetooth-fähigen Browser (auf iOS z. B. Bluefy).

## Rückweg und Probleme

Das bisherige Repository wird nicht angefasst. Es bleibt als Sicherung bestehen.

**Die Demo startet nicht?** Kontrolliere zunächst, ob `niimbot-demo.html`, `niimbot.js` und `registry.json` direkt neben `index.html` liegen. Dann Browserseite neu laden.

**PDF-Zeichen fehlen?** Prüfe, ob `cdn.jsdelivr.net` in deinem Netzwerk erreichbar ist. Sonst ggf. PDFs vorher zu PNG umwandeln.
