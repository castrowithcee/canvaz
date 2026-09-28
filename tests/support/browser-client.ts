/**
 * Minimaler Cookie-tragender HTTP-Client fuer Integrationstests.
 *
 * `fetch` in Node speichert keine Cookies. Der Anmeldefluss besteht aber aus mehreren Weiterleitungen mit
 * genau den Cookies, um die es geht - deshalb dieser kleine Ersatz fuer einen Browser.
 */

export type Jar = {
  readonly cookies: Map<string, string>
  fetch(url: string, init?: RequestInit): Promise<Response>
  cookieHeader(): string
  set(name: string, value: string): void
}

export function createJar(): Jar {
  const cookies = new Map<string, string>()

  function absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair = ''] = raw.split(';')
      const separator = pair.indexOf('=')
      if (separator < 1) {
        continue
      }
      const name = pair.slice(0, separator).trim()
      const value = decodeURIComponent(pair.slice(separator + 1).trim())
      if (value === '' || /max-age=0/i.test(raw)) {
        cookies.delete(name)
      } else {
        cookies.set(name, value)
      }
    }
  }

  const jar: Jar = {
    cookies,
    cookieHeader(): string {
      return [...cookies].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ')
    },
    set(name: string, value: string): void {
      cookies.set(name, value)
    },
    async fetch(url: string, init: RequestInit = {}): Promise<Response> {
      const headers = new Headers(init.headers)
      if (cookies.size > 0) {
        headers.set('cookie', jar.cookieHeader())
      }
      const response = await fetch(url, { ...init, headers, redirect: 'manual' })
      absorb(response)
      return response
    },
  }
  return jar
}
