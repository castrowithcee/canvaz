/*
 * Zuletzt bekanntes Erscheinungsbild vor der ersten Darstellung.
 *
 * Ein klassisches, blockierendes Skript aus eigener Herkunft: die Content-Security-Policy verbietet Inline-
 * Skripte, und ein Modul liefe erst nach der ersten Darstellung - ein Neuladen im Dunkelmodus blitzte dann
 * hell auf. Es setzt nur die beiden Attribute, die `src/web/appearance.ts` sonst setzt; die massgebliche Wahl
 * kommt danach mit dem Profil vom Server und ersetzt diesen Komfortwert.
 *
 * Die Gastansicht (`GUEST_APP_PATH`) folgt immer der Systemvorgabe: ein Gast hat keine Wahl.
 */
;(function () {
  try {
    if (window.location.pathname === '/gast') {
      return
    }
    var gemerkt = JSON.parse(window.localStorage.getItem('canvaz:erscheinungsbild') || 'null')
    if (gemerkt === null || typeof gemerkt !== 'object') {
      return
    }
    var root = document.documentElement
    if (gemerkt.colorScheme === 'light' || gemerkt.colorScheme === 'dark') {
      root.setAttribute('data-theme', gemerkt.colorScheme)
    }
    // Ein unbekannter Name hat in `styles.css` keine Regel und bleibt damit wirkungslos.
    if (typeof gemerkt.accent === 'string' && /^[a-z]{1,20}$/.test(gemerkt.accent) && gemerkt.accent !== 'violett') {
      root.setAttribute('data-accent', gemerkt.accent)
    }
  } catch {
    // Ohne lesbaren Speicher beginnt die Seite mit der Standardwahl.
  }
})()
