import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/app/i18n'
import { localizedApiErrorMessage } from './api-error-messages'

afterEach(() => {
  i18n.global.locale.value = 'zh-CN'
})

describe('localizedApiErrorMessage', () => {
  it('keeps the precise server message in Chinese', () => {
    expect(
      localizedApiErrorMessage({
        code: 'ROW_VERSION_CONFLICT',
        message: '记录已被其他用户修改',
        requestId: 'request-1',
      }),
    ).toBe('记录已被其他用户修改')
  })

  it('maps stable API error codes in English', () => {
    i18n.global.locale.value = 'en-US'
    expect(
      localizedApiErrorMessage({
        code: 'ROW_VERSION_CONFLICT',
        message: '记录已被其他用户修改',
        requestId: 'request-2',
      }),
    ).toBe('This record was changed by another user. Reload it before editing again.')
  })

  it('retains the server message for unknown codes', () => {
    i18n.global.locale.value = 'en-US'
    expect(
      localizedApiErrorMessage({
        code: 'UNKNOWN_CODE',
        message: 'Fallback message',
        requestId: 'request-3',
      }),
    ).toBe('Fallback message')
  })
})
