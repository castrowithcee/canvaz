# Spike: Excalidraw-Integration und Kollaborationskern

Technischer Nachweis fuer Issue 1. Der Spike beantwortet, ob Excalidraw als Editorbasis mit eigener
Kollaboration, eigener Persistenz und serverseitigen Schreibrechten tragfaehig ist. Er ist bewusst kein
Produktgeruest: Auth, Workspaces, Datenbank und Deployment folgen in den Issues 2 bis 8.

## Aufbau

| Pfad | Rolle |
| --- | --- |
| `shared/scene.ts` | Serialisierbarer Boardzustand, Validierung, Snapshot-Roundtrip |
| `shared/reconcile.ts` | Element-Reconciliation ueber `version` und `versionNonce` |
| `shared/protocol.ts` | Nachrichtenvertrag und Parser fuer untrusted Eingaben |
| `client/board-editor-port.ts` | Port, den der Kollaborationscode allein kennt |
| `client/excalidraw-adapter.ts` | Einzige Datei mit Excalidraw-Typen |
| `client/collab-client.ts` | WebSocket-Client mit Buendelung, Backoff und Resync |
| `server/main.ts` | HTTP-Snapshot, WebSocket-Sync, Presence, Rechte, Rate-Limit |
| `server/board-store.ts` | Massgeblicher Zustand mit atomarer JSON-Persistenz |
| `server/auth.ts` | Rollenaufloesung; spaeter durch die OIDC-Serversession ersetzt |

Die Trennung ist die eigentliche Aussage des Spikes: Excalidraw erscheint ausschliesslich in
`client/excalidraw-adapter.ts`. Server, Persistenz, Protokoll und Tests kennen nur `shared/`.

## Starten

```sh
npm install
npm run start:server   # Kollaborationsserver auf Port 3001
npm run dev            # Editor auf Port 5173
```

Danach zwei Browserfenster oeffnen:

- Editor: `http://localhost:5173/?board=demo&token=spike-editor`
- Zweiter Editor: `http://localhost:5173/?board=demo&token=spike-editor-2`
- Nur Lesen: `http://localhost:5173/?board=demo&token=spike-viewer`

Die Marken in `server/auth.ts` sind Demo-Werte fuer den lokalen Spike und keine Zugangsdaten.

## Pruefungen

```sh
npm run lint
npm run typecheck
npm run test       # Roundtrip, Reconciliation, Server: 17 Tests
npm run build
npm run test:e2e   # Zwei Browserkontexte gegen den echten Editor: 4 Tests
```

`test:e2e` baut den Client, startet Server und Preview, leert das Testdatenverzeichnis und zeichnet ueber
die echte Excalidraw-Oberflaeche. Ein einmaliges `npx playwright install chromium` ist Voraussetzung.

## Testhaken

`window.__canvazSpike` stellt dem Mehrbrowser-Test den Editorzustand sowie zwei bewusst unsichere Aktionen
bereit: `sendUncheckedElements` stellt einen manipulierten Client nach, `dropConnection` einen
Netzwerkabbruch. Beide laufen ueber den normalen Client- und Serverweg; der Haken umgeht keine Pruefung des
Servers. Im Produkt entfaellt er.
