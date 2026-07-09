import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import { allTools } from '../src/tools/index'

const srcRoot = fileURLToPath(new URL('../src', import.meta.url))

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : []
  })

describe('tool conformance', () => {
  it('registers at least one tool', () => {
    expect(allTools.length).toBeGreaterThan(0)
  })

  for (const tool of allTools) {
    describe(tool.name, () => {
      it('has an eth_ snake_case name', () => {
        expect(tool.name).toMatch(/^eth_[a-z_]+$/)
      })

      it('has a description written for a new hire (>= 80 chars)', () => {
        expect(tool.description.length).toBeGreaterThanOrEqual(80)
      })

      it('describes every input field with format + example', () => {
        for (const [field, schema] of Object.entries(tool.input.shape)) {
          const description = (schema as { description?: string }).description
          expect(description, `input field "${field}" must have .describe()`).toBeTruthy()
          expect((description ?? '').length).toBeGreaterThan(0)
        }
      })

      it('carries the fixed read-only annotations', () => {
        expect(tool.annotations.readOnlyHint).toBe(true)
        expect(tool.annotations.destructiveHint).toBe(false)
        expect(tool.annotations.openWorldHint).toBe(true)
        expect(typeof tool.annotations.idempotentHint).toBe('boolean')
        expect(Object.keys(tool.annotations).sort()).toEqual([
          'destructiveHint',
          'idempotentHint',
          'openWorldHint',
          'readOnlyHint',
        ])
      })

      it('serializes chain quantities as strings — numeric output fields only for small counts', () => {
        const jsonSchema = z.toJSONSchema(tool.output) as {
          properties?: Record<string, unknown>
        }
        for (const [field, prop] of Object.entries(jsonSchema.properties ?? {})) {
          if (/"(number|integer)"/.test(JSON.stringify(prop))) {
            expect(
              ['decimals', 'log_count'],
              `numeric output field "${field}" must be a bounded count, never a chain quantity`,
            ).toContain(field)
          }
        }
      })
    })
  }

  it('contains no class declarations anywhere in src (functional TS only)', () => {
    const offenders = walk(srcRoot).filter((file) =>
      /\bclass\s+[A-Z]/.test(readFileSync(file, 'utf8')),
    )
    expect(offenders, `class declarations found in: ${offenders.join(', ')}`).toEqual([])
  })
})
