# Mitspieler einladen – sicher und datensparsam

Diese Anleitung erklärt, wie andere auf deinen Inselreich-Server kommen, ohne dass du dein Heimnetz unnötig öffnest oder mehr Daten sammelst als nötig.

## Kurzfassung: Welche Variante passt?

| Situation | Empfehlung | Mitspieler brauchen | Offene Ports im Router |
|---|---|---|---|
| Alle im selben WLAN | **Heimnetz (LAN)** | nur Browser | keine |
| Feste Freundesgruppe | **A: Tailscale** ⭐ | Tailscale-App + Konto | keine |
| Wechselnde Gäste, niemand soll etwas installieren | **B: Eigene Domain + HTTPS + Passwort** | nur Browser | 80/443 (nur zum Proxy) |
| Wie B, aber Portfreigabe geht nicht (CGNAT, DS-Lite, Mobilfunk) | **C: Cloudflare Tunnel** | nur Browser | keine |

**Meine Empfehlung:** Für einen festen Freundeskreis nimm **Tailscale**. Der Server ist dann im Internet unsichtbar, und nur eingeladene Geräte erreichen genau diesen einen Rechner.

---

## Welche Daten speichert Inselreich?

Bewusst sehr wenig:

| Daten | Wo | Wie lange |
|---|---|---|
| Selbst gewählter Spielername (kein echter Name nötig) | Server, `data/rooms/*.json` | bis der Raum gelöscht wird |
| Chatnachrichten (max. 100 pro Raum) | Server, im Raum | bis der Raum gelöscht wird |
| Spielstand | Server, im Raum | bis der Raum gelöscht wird |
| Platz-Token (Zufallszahl, damit man nach einem Reload wieder auf seinem Platz landet) | Browser des Spielers (localStorage) | bis man den Raum verlässt |
| IP-Adresse (für Ratenbegrenzung und Sperre nach Fehlversuchen) | **nur im Arbeitsspeicher**, nie auf Platte | höchstens 1 Stunde nach der letzten Verbindung |

Außerdem gilt:

- **Keine Konten, keine E-Mail-Adressen, keine Cookies, keine Tracker, keine Analytik.**
- **Keine externen Inhalte:** keine CDNs, keine Google Fonts, keine eingebetteten Dienste. Der Browser spricht nur mit deinem Server.
- **Keine Zugriffsprotokolle:** Der Server protokolliert weder IP-Adressen noch Namen.
- **Löschen:** Der Gastgeber kann einen Raum jederzeit im Warteraum löschen, dabei werden Chat und Spielstand mitgelöscht. Räume ohne Aktivität löscht der Server automatisch nach `ROOM_TTL_DAYS` Tagen (Standard 30).
- **Achtung:** Ein vorgeschalteter Reverse Proxy (nginx), ein Tunnel-Anbieter (Cloudflare) oder dein Router können **eigene** Protokolle mit IP-Adressen führen. Siehe die jeweilige Variante.

---

## Variante A: Tailscale (empfohlen)

[Tailscale](https://tailscale.com) baut ein privates, verschlüsseltes Netz (WireGuard) zwischen ausgewählten Geräten auf. Du öffnest **keinen Port** im Router. Für Fremde ist dein Server im Internet nicht auffindbar.

**Auf dem Homeserver:**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# Optional: HTTPS mit gültigem Zertifikat unter https://<rechnername>.<tailnet>.ts.net
sudo tailscale serve --bg 3000
```

**Freunde einladen:**

1. In der [Tailscale-Admin-Konsole](https://login.tailscale.com/admin/machines) beim Homeserver auf **„…“ → „Share…“** klicken und einen Einladungslink erzeugen.
2. Die Freunde installieren die Tailscale-App (Windows, macOS, Linux, Android, iOS), melden sich an (z. B. mit Google, Microsoft oder GitHub) und nehmen die Einladung an.
3. Sie sehen dann **nur diesen einen Rechner**, nicht dein restliches Heimnetz, und öffnen `http://<tailscale-ip>:3000` bzw. die `ts.net`-Adresse.

**Noch strenger:** In den Tailscale-Zugriffsregeln (ACLs) erlaubst du geteilten Nutzern nur Port 3000 bzw. 443. Dann kommen Gäste auch nicht an SSH oder andere Dienste des Servers.

**Datenschutz-Abwägung:** Der Spielverkehr ist Ende-zu-Ende verschlüsselt, Tailscale sieht keine Inhalte. Der Koordinationsserver von Tailscale (US-Firma) kennt aber Metadaten wie Gerätenamen und IP-Adressen. Wer das nicht möchte, kann mit [Headscale](https://github.com/juanfont/headscale) einen eigenen Koordinationsserver betreiben.

> ⚠️ Nicht **„Tailscale Funnel“** verwenden. Damit wird der Dienst öffentlich ins Internet gestellt.

---

## Variante B: Eigene Domain + HTTPS + Passwort

Mitspieler brauchen nur einen Browser. Dafür ist dein Server öffentlich erreichbar und muss abgesichert werden.

1. **Adresse besorgen:** Eigene Domain oder kostenlose DynDNS-Adresse (z. B. DuckDNS), die auf deine Heim-IP zeigt.
2. **Router:** Nur die Ports **80 und 443** an den Homeserver weiterleiten. **Port 3000 niemals direkt freigeben**, denn ohne HTTPS ginge das Passwort im Klartext durchs Netz.
3. **Caddy als Reverse Proxy** (holt automatisch ein HTTPS-Zertifikat). Caddy schreibt standardmäßig **keine** Zugriffsprotokolle.
   ```
   spiel.example.de {
       reverse_proxy 127.0.0.1:3000
   }
   ```
   Bei nginx solltest du mit `access_log off;` die Protokollierung abschalten oder deren Aufbewahrung kurz halten.
4. **Inselreich so einstellen**, in `docker-compose.yml`:
   ```yaml
   ports:
     - "127.0.0.1:3000:3000"     # nur über den Proxy erreichbar
   environment:
     SERVER_PASSWORD: "ein-langes-zufälliges-passwort"
     ROOM_LIST: "false"           # Raumliste und Spielernamen nicht öffentlich zeigen
     TRUST_PROXY: "true"          # echte Client-IPs für Ratenbegrenzung
   ```
5. **Link und Passwort getrennt weitergeben**, z. B. über Signal. Das Passwort musst du nur einmal eintippen. Danach verbindet der Browser per Platz-Token automatisch wieder.

**Restrisiko:** Jeder Dienst im Internet wird automatisiert abgeklopft. Halte deshalb Server, Docker-Image (`docker compose pull && docker compose up -d --build`) und Caddy aktuell. Lass das Spiel im gehärteten Container laufen, wie in `docker-compose.yml` vorgegeben. Wenn möglich, stell den Server in ein eigenes Netzsegment (Gast-VLAN/DMZ).

---

## Variante C: Cloudflare Tunnel

Diese Variante ist praktisch, wenn du **keine Ports freigeben kannst**, z. B. bei CGNAT, DS-Lite oder Mobilfunk. Ein kleines Programm (`cloudflared`) baut von innen eine Verbindung zu Cloudflare auf. Deine Heim-IP bleibt verborgen.

**Datenschutz-Abwägung:** Cloudflare (US-Firma) entschlüsselt den Verkehr an seinen Servern, könnte also Chat und Spielzüge sehen. Für ein Brettspiel ist das meist vertretbar, du solltest es aber wissen.

Empfehlenswert ist **Cloudflare Access** (kostenlos für kleine Gruppen): Dann kommen nur Personen mit einer von dir freigegebenen E-Mail-Adresse überhaupt bis zur Startseite. Zusätzlich setzt du `SERVER_PASSWORD`, `ROOM_LIST=false` und `TRUST_PROXY=true`.

---

## Was der Server selbst zum Schutz tut

- **Server-Passwort** (`SERVER_PASSWORD`):
  - Ohne Passwort kann niemand Räume erstellen, betreten oder die Raumliste sehen.
  - Der Vergleich ist zeitkonstant.
  - Das Passwort wird nie in der URL übertragen, also landet es auch nicht in Proxy-Protokollen.
- **Sperre nach Fehlversuchen:** 10 falsche Passwörter von einer IP sperren diese für 10 Minuten.
- **Ratenbegrenzung:**
  - max. ~15 Nachrichten pro Sekunde und Verbindung
  - max. 20 gleichzeitige Verbindungen pro IP (`MAX_CONN_PER_IP`)
  - höchstens 5 neue Räume auf einmal, danach etwa einer pro Minute und IP
  - Obergrenze für die Anzahl der Räume (`MAX_ROOMS`)
- **Origin-Prüfung:** Fremde Webseiten können im Browser deiner Mitspieler keine Verbindung zu deinem Server aufbauen. Andere erlaubte Adressen trägst du über `ALLOWED_ORIGINS` ein.
- **Sicherheits-Header:**
  - strenge Content-Security-Policy (nur eigene Skripte, keine externen Quellen)
  - Schutz vor Einbettung in fremde Seiten (Clickjacking)
  - kein Referrer
  - keine Kamera-, Mikrofon- oder Standortrechte
- **Geladene Spielstände werden streng geprüft:** Nur bekannte Felder mit gültigen Werten werden übernommen. Eine manipulierte Datei kann kein HTML oder Skript einschleusen.
- **Wiederverbinden** funktioniert über ein zufälliges 128-Bit-Token pro Platz. Ein Name allein reicht im laufenden Spiel nur, solange dieser Platz gerade **nicht** verbunden ist.
- **Gehärteter Docker-Container:**
  - läuft ohne Root
  - schreibgeschütztes Dateisystem außer `/data`
  - keine Linux-Capabilities, `no-new-privileges`
  - Speicher- und Prozesslimit

## Checkliste für den Internet-Betrieb

- [ ] HTTPS über Caddy, nginx, Tailscale Serve oder Cloudflare, **nie** Port 3000 direkt öffnen
- [ ] `SERVER_PASSWORD` lang und zufällig gesetzt, getrennt vom Link weitergegeben
- [ ] `ROOM_LIST=false`
- [ ] Hinter einem Proxy: `TRUST_PROXY=true` und Port nur an `127.0.0.1` gebunden
- [ ] Proxy-Zugriffsprotokolle aus oder mit kurzer Aufbewahrung
- [ ] Server und Container regelmäßig aktualisieren
- [ ] Alte Räume löschen oder `ROOM_TTL_DAYS` niedrig wählen

## Rechtliches (kein Rechtsrat)

Betreibst du den Server nur für **Freunde und Familie**, fällt das in der Regel unter die „persönliche oder familiäre Tätigkeit“ (Art. 2 Abs. 2 lit. c DSGVO), auf die die DSGVO nicht anwendbar ist. Machst du den Server **öffentlich für Unbekannte** zugänglich, können ein Impressum und eine Datenschutzerklärung nötig werden. Im Zweifel solltest du dich beraten lassen. Die sparsame Datenhaltung von Inselreich (siehe oben) macht eine solche Erklärung kurz.
