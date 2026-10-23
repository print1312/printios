# Prüfbericht V18 – 23. Oktober 2026

Grundlage: V17 („Mehrbild, Ebenen, Rahmen“). Der gesamte Code (`index.html`, `addon.js`, `niimbot-demo.html`, Treiber-Schnittstelle in `niimbot.js`) wurde durchgesehen und alle Funktionen wurden im Browser durchgetestet – mit iPhone-Größe (390 × 664 und 375 × 553, Touch) und Laptop-Größe (1366 × 768 und 1280 × 720).

## Gefundene Fehler und Korrekturen

| # | Problem in V17 | Korrektur in V18 |
|---|---|---|
| 1 | **Vorschau ≠ Druck.** Der Treiber druckt jeden Pixel mit Helligkeit < 50 % schwarz, alles andere weiß. Die Vorschau zeigte aber Farben/Graustufen. Ein farbiges Foto wurde z. B. als schwarze Fläche gedruckt, Text darauf verschwand. | Neue **Druckansicht** (Standard): zeigt exakt das Druckbild in Schwarz/Weiß. Pro Bild wählbarer Druckmodus, neu **Foto – Rasterung** (Floyd-Steinberg-Dithering, berechnet in Druckauflösung). JPG-Fotos nutzen ihn automatisch. Der Drucker bekommt dasselbe 1-Bit-Bild wie die Vorschau. |
| 2 | Bedienmodus „Graustufen“ / „Hartes Schwarzweiß“ wirkte nur auf die Vorschau bzw. falsch skaliert (Schwelle in Originalauflösung). Der Schwellen-Regler war immer aktiv, wirkte aber nur in einem Modus. | Schwelle wird in Druckauflösung angewendet; Regler ist nur bei „eigene Schwelle“ aktiv. Alte Vorlagen mit „Graustufen“ werden als „Foto – Rasterung“ gedruckt. |
| 3 | **Laptop:** Werkzeuge unter der Vorschau, sichtbar waren nur ~100 px – kaum bedienbar. | Ab 900 px Breite: Vorschau links, Werkzeuge rechts in voller Höhe. |
| 4 | **iPhone:** Werkzeugbereich nur ~70 px hoch, Auswahllisten abgeschnitten („Niimbot“, „3 (mode“), Statuszeile halb abgeschnitten, Zoom-Schieber senkrecht (auf älteren iOS-Versionen nicht verlässlich). | Druckerleiste klappt nach dem Verbinden auf eine Zeile zusammen (`⚙ Drucker` öffnet sie), Werkzeugbereich ca. halbe Höhe und verstellbar, Zoom als `− 100% +` in der Vorschau, Statuszeile einzeilig. |
| 5 | Zuschneide-Dialog auf dem iPhone: Knöpfe „Zurücksetzen/Übernehmen“ abgeschnitten. | Dialog passt in den Bildschirm, Knöpfe in einer Zeile. |
| 6 | **Größenwechsel:** Texte blieben an alten Pixelpositionen (z. B. außerhalb des neuen Etiketts), Bilder wurden neu eingepasst; Vorlagen wurden in ein nicht mehr bearbeitbares Gesamtbild umgewandelt. | Alles wird proportional angepasst und bleibt bearbeitbar. Jede Etikettgröße merkt sich ihre Anordnung, Hin- und Herwechseln ist verlustfrei. |
| 7 | Beim Import fehlerhafter Dateien wurde der Dateiname von der Zusammenfassung überschrieben. | Meldung nennt jede übersprungene Datei mit Grund. WebP/GIF/HEIC (falls vom Browser lesbar) werden als PNG übernommen. |
| 8 | Import-Pixeldichte „201 dpi“ (Niimbot-Geräte haben 203 dpi). | 203 dpi; alte Werte werden weiter korrekt gelesen. |
| 9 | Prüffehler vor dem Druck (nicht verbunden, falsches Modell) zeigten „Bitte Papier prüfen; ein Etikett kann bereits ausgegeben worden sein“. | Klare Meldung ohne Papier-Hinweis. |
| 10 | „💾 Speichern“ unten öffnete nur den Vorlagen-Tab. | Speichert direkt als Vorlage. |
| 11 | Ebenenliste zeigte nach Textänderung noch den alten Text. | Wird sofort aktualisiert. |
| 12 | Rundtext erzeugte einen Kreis größer als das Etikett. | Startgröße passt ins Etikett. |
| 13 | Tab „Bild“ mit ausgewähltem Text zeigte „Aktiv: Textfeld“, Tab „Rundtext“ war ohne Auswahl komplett gesperrt. | Tabs wählen automatisch das passende Element. |
| 14 | Teile der Original-Demo englisch (Rollen, Protokoll, Statusmeldungen, „model default“, „cable flag“). | Auf Deutsch übersetzt. |
| 15 | Warteschlange zeigte nur „IMG/PDF“. | Kleine Druckbild-Vorschau, Anzahl Bilder/Texte, Zeile antippen = auswählen. |

## Automatisierte Tests (Chromium, Playwright, simulierter Drucker)

Alle Tests bestanden: **96 von 96** Prüfungen in 5 Durchläufen (iPhone 390 px, iPhone SE 375 px, Laptop 1366 px).

Geprüft u. a.: Verbinden, Mehrbild-Import als Ebenen, PDF als einzelne Etiketten, defekte Datei, Text/Fett/Rundtext, Bildkorrekturen, Ausrichten/Drehen, 90°-Druckbereich (physisches Druckbild 576 × 354), Rückgängig/Wiederholen (auch beim Größenwechsel), Vorlage speichern/exportieren/importieren/in anderer Größe öffnen, eigene Schrift hochladen, Pfeiltasten (Laptop), Touch-Ziehen und Zwei-Finger-Zoom/Drehen (iPhone), Kopien, Dichte-Übergabe, Stopp während Stapeldruck, falsches Modell, Druckbild ist reines Schwarz/Weiß bzw. gerastert, keine horizontale Überbreite, keine JavaScript-Fehler.

## Nicht geprüft / Einschränkungen

- **Kein echter Druck:** Die Bluetooth-Übertragung wurde mit einem simulierten Drucker getestet. Der Treiber `niimbot.js` wurde **nicht verändert**. Bitte zuerst ein einzelnes Etikett drucken.
- **Kein echtes iPhone/Bluefy:** Getestet wurde in Chromium mit iPhone-Bildschirmgröße und Touch-Simulation, nicht in WebKit. Erforderlich ist iOS 15.4 oder neuer.
- Vorlagen aus V17 lassen sich öffnen; Vorlagen, die V17 bereits als „Gesamtbild“ umgewandelt hatte, bleiben ein Bild.
