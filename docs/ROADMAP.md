# Roadmap

Die Reihenfolge ist ein Vorschlag. Nach den ersten Runden soll sie anhand des [Feedbacks](FEEDBACK.md) neu sortiert werden.

## ✅ Erledigt (PRs #1–#4)
- Komplettes Spiel: Grundregeln, Seefahrt, 6 Spielfelder, Bots, Editor, Speichern/Laden
- Härtung für den Internetbetrieb:
  - Passwort mit Sperre nach Fehlversuchen
  - Ratenbegrenzung, Origin-Prüfung, Content-Security-Policy
  - Strenge Prüfung geladener Spielstände, gehärteter Docker-Container
- Code-Review: Absturz durch kaputte URLs und durch Bot-Ausnahmen behoben, Plätze lassen sich nicht mehr kapern, weniger Datenverkehr
- Offline-Version für GitHub Pages: Bots und mehrere Menschen an einem Gerät
- Vorlagen für GitHub Actions (Tests, Pages), Feedback-Formular

## 🎯 Phase 1: Erste Runden mit Freunden (nächste Schritte)
| Aufgabe | Wer | Aufwand |
|---|---|---|
| Offene PRs der Reihe nach mergen, `main` als Standard-Branch | du | 5 min |
| GitHub Pages aktivieren: Vorlagen aus `docs/github-workflows/` nach `.github/workflows/` kopieren (siehe README) | du | 5 min |
| Tailscale auf dem Homeserver einrichten, `docker compose up -d --build` | du | 30 min |
| Erste Runden spielen, [Feedback-Bogen](FEEDBACK.md) ausfüllen | alle | – |
| Docker-Build und Tailscale-Anleitung an echter Hardware prüfen, Lücken in der Doku schließen | gemeinsam | klein |
| **„Du bist dran“-Signal:** Tab-Titel blinkt, optional Ton bzw. Browser-Benachrichtigung | Code | klein |
| **Bau-Bestätigung bzw. Rückgängig** für den letzten Bau, solange noch nichts anderes passiert ist | Code | klein |
| **Zoom und Verschieben** des Bretts auf dem Handy | Code | mittel |

## 🧩 Phase 2: Spielgefühl
- Handel:
  - Gegenangebote
  - Schnellhandel-Vorschläge
  - Angebot gezielt an einzelne Spieler
- Sonderbauphase bei 5–6 Spielern
- Statistiken am Spielende: Würfelverteilung, erhaltene Rohstoffe, Zeit pro Zug
- Stärkere Bots: Handel anbieten, Ziel-Strategie, Schwierigkeitsstufen
- Optionaler Zug-Timer und Abwesenheitsmodus, bei dem ein Bot nach X Minuten übernimmt
- Spielverlauf als Wiederholung (Replay) aus dem Log

## 🗺️ Phase 3: Inhalte
- Karteneditor im Browser: neue Karten zeichnen, als Datei teilen
- Neue Szenarien:
  - Nebelinseln (verdeckte Felder werden durch Schiffe entdeckt)
  - Wüstenwanderung
  - eigene Ideen
- Varianten:
  - „freundlicher Räuber“ (keine Spieler mit ≤ 2 Punkten)
  - Würfel-Stapel statt Zufallswürfel (gleichmäßigere Verteilung)

## 🛠️ Technik und Betrieb
- **Online ohne eigenen Server (P2P):**
  - Die Offline-Version kann um WebRTC erweitert werden. Der Browser des Gastgebers ist dann der Server, die anderen verbinden sich direkt mit ihm.
  - Nachteile: Für den Verbindungsaufbau ist ein öffentlicher Vermittlungsdienst nötig (z. B. PeerJS), wodurch dieser Dienst und die Mitspieler die IP-Adressen sehen. Manche Netze (strenge NATs) verbinden sich ohne TURN-Server nicht. Und das Spiel endet, wenn der Gastgeber den Tab schließt.
  - Sinnvoll als Übergangslösung, solange der Homeserver noch nicht läuft.
- Playwright-Browsertests in der CI
- Automatische Backups der Räume, z. B. tägliche Kopie von `/data` mit Rotation
- Kleine Admin-Seite für den Server: Räume sehen, löschen, exportieren
- Dependabot hält Abhängigkeiten und Actions aktuell (bereits eingerichtet)

## Bekannte Grenzen (bewusst so)
- Der **Gastgeber** sieht im Editor und beim Export alle Karten. Er ist Spielleiter, also braucht es Vertrauen.
- **Wer Zugang zum Server hat**, kann jeden Raum per Code betreten oder zuschauen. Mit Tailscale ist das nur dein Freundeskreis.
- Der **Platz** hängt an einem Zufalls-Token im Browser. Wer an deinem Browser sitzt, sitzt auch auf deinem Platz.
- In der **Offline-Version** sehen alle am Gerät den Bildschirm. Der Übergabe-Hinweis hilft dabei, ist aber kein echter Sichtschutz.
- Ein einzelner Node-Prozess mit allem im Speicher ist für Freundesrunden mehr als genug, aber nicht für Hunderte gleichzeitige Spiele gedacht.
