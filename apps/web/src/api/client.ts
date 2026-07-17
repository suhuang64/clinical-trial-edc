import type { ApiError } from '@edc/contracts'
import { localizedApiErrorMessage } from './api-error-messages'

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: ApiError,
  ) {
    super(localizedApiErrorMessage(payload))
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json')
  const csrfToken = sessionStorage.getItem('edc-csrf-token')
  if (csrfToken && !['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase()))
    headers.set('X-CSRF-Token', csrfToken)
  const response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin' })
  if (response.status === 204) return undefined as T
  const payload = await response.json()
  if (!response.ok) throw new ApiClientError(response.status, payload as ApiError)
  return payload as T
}
