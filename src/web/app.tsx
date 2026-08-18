/**
 * Anwendungshuelle der SPA.
 *
 * Bewusst nur das Geruest: Anmeldung, Navigation und Boardansicht folgen in den naechsten Paketen. Die
 * Datei existiert, damit Build, Preview und Auslieferung durch den Anwendungsserver jetzt schon nachweisbar
 * funktionieren.
 */

export function App() {
  return (
    <main className="shell">
      <h1>Canvaz</h1>
      <p>Die Anwendungsgrundlage steht. Die Anmeldung ueber den Identity Provider folgt.</p>
    </main>
  )
}
