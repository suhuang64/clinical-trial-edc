import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function luminance(hex: string) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}

function contrast(foreground: string, background: string) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0]! + 0.05) / (values[1]! + 0.05)
}

function tokens(block: string) {
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [match[1], match[2]]),
  )
}

describe('设计系统颜色对比度', () => {
  const css = readFileSync(resolve(import.meta.dirname, 'index.css'), 'utf8')
  const light = tokens(css.match(/:root\s*{([^}]+)}/s)![1]!)
  const dark = tokens(css.match(/:root\[data-theme='dark'\]\s*{([^}]+)}/s)![1]!)

  for (const [name, palette] of [
    ['浅色', light],
    ['深色', dark],
  ] as const) {
    it(`${name}主题正文和语义状态达到 WCAG AA`, () => {
      for (const surface of ['--color-background', '--color-surface'] as const) {
        expect(contrast(palette['--color-text']!, palette[surface]!)).toBeGreaterThanOrEqual(4.5)
        expect(
          contrast(palette['--color-text-secondary']!, palette[surface]!),
        ).toBeGreaterThanOrEqual(4.5)
      }
      for (const token of [
        '--color-primary',
        '--color-success',
        '--color-warning',
        '--color-danger',
        '--color-info',
      ] as const)
        expect(contrast(palette[token]!, palette['--color-surface']!)).toBeGreaterThanOrEqual(4.5)
    })
  }
})
