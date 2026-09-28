# Laufzeitimage der Instanz.
#
# Zwei Stufen: die erste baut mit den vollstaendigen Abhaengigkeiten SPA und Serverdateien, die zweite
# enthaelt nur noch die Laufzeit. Damit liegen weder Quelltext noch Werkzeugkette im ausgelieferten Image.
#
# Der Anwendungsserver migriert nicht von selbst. Migrationen laufen als eigener Aufruf desselben Images
# (`node dist/persistence/migrate-cli.js`), damit ein Neustart nie unbeabsichtigt das Schema aendert.

FROM node:22-alpine AS build
WORKDIR /app
# Erst das Manifest: die Abhaengigkeitsschicht bleibt im Cache, solange sich nur Quelltext aendert.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# Ohne Entwicklungsabhaengigkeiten: das Image fuehrt gebautes JavaScript aus, kein TypeScript.
# qatlas-dev: die Bibliotheken der SPA (Excalidraw, React) stehen als Laufzeitabhaengigkeiten im Manifest
# und liegen deshalb auch im Laufzeitimage, obwohl sie dort nur im gebauten Bundle gebraucht werden - rund
# 240 MB, die der Serverprozess nie laedt. Sie herauszunehmen heisst, sie im Manifest zu verschieben; das
# ist eine Aenderung am Abhaengigkeitsvertrag des Pakets und gehoert in einen eigenen Schritt, sobald
# Imagegroesse oder ein Scan-Befund es verlangen.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Einhaengepunkt des Assetvolumes im Modus `filesystem`. Ein benanntes Volume uebernimmt beim Anlegen die
# Rechte dieses Verzeichnisses - ohne das koennte der unprivilegierte Nutzer dort nicht schreiben.
RUN mkdir -p /var/lib/canvaz/assets && chown node:node /var/lib/canvaz/assets
USER node
EXPOSE 3000
# Lebendigkeit, nicht Bereitschaft: ob diese Instanz Verkehr bekommt, entscheidet der Reverse Proxy an
# `/api/ready`. Ein fehlender Assetspeicher soll den Prozess nicht als tot ausweisen.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD wget --quiet --spider http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/server/main.js"]
