/**
 * HTTP-Zugang der SPA.
 *
 * Duenne Schicht ueber `fetch`: gemeinsame Fehlerform, CSRF-Header fuer zustandsaendernde Anfragen und die
 * geteilten Vertragstypen. Tokenmaterial des Identity Providers kennt der Browser nicht; die Sitzung lebt
 * ausschliesslich im HttpOnly-Cookie und wird nie in `localStorage` oder `sessionStorage` abgelegt.
 */

import type { AdminUsersResponse, LogoutResponse, MeResponse, SetUserStatusRequest, UserView } from '../contracts/api.js'
import {
  ADMIN_USER_STATUS_PATH,
  ADMIN_USERS_PATH,
  AUTH_LOGOUT_PATH,
  CSRF_HEADER,
  ME_PATH,
} from '../contracts/api.js'

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin' })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const message =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Anfrage fehlgeschlagen (${String(response.status)})`
    throw new ApiError(response.status, message)
  }
  return (await response.json()) as T
}

/** `null` bedeutet: nicht angemeldet. Alles andere ist ein echter Fehler. */
export async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await request<MeResponse>(ME_PATH)
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null
    }
    throw error
  }
}

function mutation(csrfToken: string, body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { [CSRF_HEADER]: csrfToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

export async function logout(csrfToken: string): Promise<LogoutResponse> {
  return request<LogoutResponse>(AUTH_LOGOUT_PATH, mutation(csrfToken))
}

export async function fetchAdminUsers(): Promise<AdminUsersResponse> {
  return request<AdminUsersResponse>(ADMIN_USERS_PATH)
}

export async function setUserStatus(csrfToken: string, change: SetUserStatusRequest): Promise<UserView> {
  return request<UserView>(ADMIN_USER_STATUS_PATH, mutation(csrfToken, change))
}
