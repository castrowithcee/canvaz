/*
 * Zuletzt bekanntes Erscheinungsbild vor der ersten Darstellung.
 *
 * Ein klassisches, blockierendes Skript aus eigener Herkunft: die Content-Security-Policy verbietet Inline-
 * Skripte, und ein Modul liefe erst nach der ersten Darstellung - ein Neuladen im Dunkelmodus blitzte dann
 * hell auf. Es setzt nur die beiden Attribute und die `theme-color`, die `src/web/appearance.ts` sonst
 * setzt; die massgebliche Wahl kommt danach mit dem Profil vom Server und ersetzt diesen Komfortwert.
 */
;(function () {
  try {
    if (window.location.pathname === '/gast') {
      // Guests always get the light scheme and never read the remembered choice (it belongs to an account).
      document.documentElement.setAttribute('data-theme', 'light')
      document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
        meta.setAttribute('content', '#f4f4f6')
      })
      return
    }
    var gemerkt = JSON.parse(window.localStorage.getItem('canvaz:erscheinungsbild') || 'null')
    if (gemerkt === null || typeof gemerkt !== 'object') {
      return
    }
    var root = document.documentElement
    if (gemerkt.colorScheme === 'light' || gemerkt.colorScheme === 'dark') {
      root.setAttribute('data-theme', gemerkt.colorScheme)
      // Die Browserleiste folgt der Wahl; dieselben Farben stehen in `index.html` und `appearance.ts`.
      var farbe = gemerkt.colorScheme === 'dark' ? '#121212' : '#f4f4f6'
      document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
        meta.setAttribute('content', farbe)
      })
    }
    // Ein unbekannter Name hat in `styles.css` keine Regel und bleibt damit wirkungslos.
    if (typeof gemerkt.accent === 'string' && /^[a-z]{1,20}$/.test(gemerkt.accent) && gemerkt.accent !== 'violett') {
      root.setAttribute('data-accent', gemerkt.accent)
    }
  } catch {
    // Ohne lesbaren Speicher beginnt die Seite mit der Standardwahl.
  }
})()
