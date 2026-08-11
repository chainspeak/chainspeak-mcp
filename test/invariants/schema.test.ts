/**
 * House rules every tool schema obeys, checked statically.
 *
 * Two of these are ratchets: SHAPE_DEBT records what the schemas cost TODAY, so
 * nothing may get worse while the redesign lowers the numbers. Shrink the entries
 * as shapes improve; never raise one to make a test pass.
 */

import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import { createTools } from '../../src/core/tools/index'
import { testRegistry } from '../fakes/chain-reader'

const tools = createTools(testRegistry())

interface Field {
  path: string
  nullable: boolean
  type: string
}

const fieldsOf = (schema: z.ZodObject): Field[] => {
  const found: Field[] = []
  const walk = (node: unknown, path: string): void => {
    if (typeof node !== 'object' || node === null) return
    const s = node as {
      type?: unknown
      properties?: Record<string, unknown>
      items?: unknown
      anyOf?: unknown[]
    }
    if (s.properties) {
      for (const [key, child] of Object.entries(s.properties)) {
        walk(child, path ? `${path}.${key}` : key)
      }
      return
    }
    if (s.anyOf) {
      const nullable = s.anyOf.some((a) => (a as { type?: string }).type === 'null')
      const real = s.anyOf.find((a) => (a as { type?: string }).type !== 'null')
      if (path) found.push({ path, nullable, type: String((real as { type?: string })?.type) })
      if (real) walk(real, path)
      return
    }
    if (s.items) {
      walk(s.items, `${path}[]`)
      return
    }
    const types = Array.isArray(s.type) ? s.type : [s.type]
    if (path) found.push({ path, nullable: types.includes('null'), type: String(types[0]) })
  }
  walk(z.toJSONSchema(schema), '')
  // a nullable wrapper yields the same path twice; nullability is the OR of both
  const merged = new Map<string, Field>()
  for (const field of found) {
    const seen = merged.get(field.path)
    merged.set(
      field.path,
      seen === undefined
        ? field
        : { ...seen, nullable: seen.nullable || field.nullable, type: seen.type ?? field.type },
    )
  }
  return [...merged.values()]
}

/**
 * Ceilings on the TOP level of each response — the wall of fields a reader meets
 * first, which is what made these schemas hard to read. Leaf totals are not
 * ratcheted: grouping and the approved enrichment deliberately trade more nested
 * fields for a smaller surface, and a rule that forbade that would forbid the fix.
 */
const SHAPE_DEBT: Record<string, { top: number; topNullable: number }> = {
  chainspeak_get_chain_status: { top: 16, topNullable: 7 },
  chainspeak_get_account: { top: 12, topNullable: 3 },
  chainspeak_get_token: { top: 11, topNullable: 7 },
  chainspeak_get_transaction: { top: 27, topNullable: 21 },
  chainspeak_get_block: { top: 18, topNullable: 14 },
  chainspeak_get_events: { top: 8, topNullable: 1 },
  chainspeak_resolve_name: { top: 9, topNullable: 4 },
}

const topLevel = (schema: z.ZodObject): { top: number; topNullable: number } => {
  const js = z.toJSONSchema(schema) as {
    properties?: Record<string, { anyOf?: { type?: string }[]; type?: unknown }>
  }
  const props = Object.entries(js.properties ?? {})
  const topNullable = props.filter(
    ([, v]) =>
      (v.anyOf ?? []).some((a) => a.type === 'null') ||
      (Array.isArray(v.type) && v.type.includes('null')),
  ).length
  return { top: props.length, topNullable }
}

describe('tool schemas obey the house rules', () => {
  for (const tool of tools) {
    describe(tool.name, () => {
      const outputs = fieldsOf(tool.output)

      it('names no field after a specific chain asset', () => {
        const offenders = outputs.filter((f) => /(^|[._])eth([._]|$)/.test(f.path))
        expect(offenders.map((f) => f.path)).toEqual([])
      })

      it('says which chain it answered for', () => {
        expect(outputs.map((f) => f.path)).toContain('chain')
      })

      it('uses snake_case throughout', () => {
        const offenders = outputs.filter((f) =>
          f.path
            .split(/[.[\]]+/)
            .filter(Boolean)
            .some((seg) => !/^[a-z][a-z0-9_]*$/.test(seg)),
        )
        expect(offenders.map((f) => f.path)).toEqual([])
      })

      it('describes every input field', () => {
        for (const [field, schema] of Object.entries(tool.input.shape)) {
          const description = (schema as { description?: string }).description
          expect(description, `input field "${field}" must have .describe()`).toBeTruthy()
        }
      })

      it('serializes chain quantities as strings, leaving numbers for bounded counts', () => {
        const BOUNDED = [
          'decimals',
          'log_count',
          'log_index',
          'nonce',
          'tx_count',
          'total',
          'offset',
          'limit',
          'batch_cap',
          'returned',
        ]
        const numeric = outputs
          .filter((f) => f.type === 'number' || f.type === 'integer')
          .map((f) => f.path.split('.').pop() ?? f.path)
        for (const field of numeric) expect(BOUNDED).toContain(field)
      })

      it('does not grow past its recorded top-level shape debt', () => {
        const debt = SHAPE_DEBT[tool.name]
        expect(debt, `${tool.name} has no recorded debt — add one`).toBeDefined()
        if (debt === undefined) return
        const actual = topLevel(tool.output)
        expect(actual.top, 'top-level field count may only go down').toBeLessThanOrEqual(debt.top)
        expect(actual.topNullable, 'top-level nullable count may only go down').toBeLessThanOrEqual(
          debt.topNullable,
        )
      })
    })
  }

  it('covers every tool with a debt entry, so none escapes the ratchet', () => {
    expect(Object.keys(SHAPE_DEBT).sort()).toEqual(tools.map((t) => t.name).sort())
  })
})

describe('the rules can actually fail', () => {
  it('flags a chain-asset field name', () => {
    const fields = fieldsOf(z.object({ balance_eth: z.string() }))
    expect(fields.filter((f) => /(^|[._])eth([._]|$)/.test(f.path))).toHaveLength(1)
  })

  it('flags a nested chain-asset field name', () => {
    const fields = fieldsOf(z.object({ fees: z.object({ fee_eth: z.string() }) }))
    expect(fields.filter((f) => /(^|[._])eth([._]|$)/.test(f.path))).toHaveLength(1)
  })

  it('flags camelCase', () => {
    const fields = fieldsOf(z.object({ blockNumber: z.string() }))
    const bad = fields.filter((f) =>
      f.path
        .split(/[.[\]]+/)
        .filter(Boolean)
        .some((seg) => !/^[a-z][a-z0-9_]*$/.test(seg)),
    )
    expect(bad).toHaveLength(1)
  })

  it('sees an unbounded numeric field', () => {
    const fields = fieldsOf(z.object({ balance_wei: z.number() }))
    expect(fields.filter((f) => f.type === 'number')).toHaveLength(1)
  })

  it('sees through a nullable wrapper to the real type', () => {
    const fields = fieldsOf(z.object({ gas_used: z.string().nullable() }))
    expect(fields[0]).toMatchObject({ path: 'gas_used', nullable: true, type: 'string' })
  })
})
