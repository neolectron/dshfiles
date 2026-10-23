import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { JsonText } from '../src/api/index.js'

const failureMessage = 'JSON text did not match the required schema.'

describe('JsonText public validated boundary', () => {
  it('decodes text only through the required schema and returns its domain value', () => {
    const schema = z.object({ count: z.number().int() }).strict()
    expect(JsonText.parse('{"count":3}', schema)).toEqual({ count: 3 })
    expect(JsonText.parse('null', z.null())).toBeNull()
  })

  it('preserves schema transform output and inference', () => {
    const schema = z.object({ count: z.string().transform(value => Number(value)) }).strict()
    const result = JsonText.parse('{"count":"7"}', schema)
    expect(result).toEqual({ count: 7 })
    expectTypeOf(result).toEqualTypeOf<{ count: number }>()
  })

  it('rejects malformed JSON with one fixed error and no payload or cause', () => {
    const secret = 'SYNTHETIC_PRIVATE_TEXT_NOT_A_SECRET'
    try {
      JsonText.parse(`{"value":"${secret}"`, z.object({ value: z.string() }))
      throw new Error('Expected decoding to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(error).toMatchObject({ message: failureMessage })
      expect(String(error)).not.toContain(secret)
      expect(error).not.toHaveProperty('cause')
      expect(error).not.toHaveProperty('issues')
    }
  })

  it('redacts schema failures rather than leaking received values or custom diagnostics', () => {
    const secret = 'SYNTHETIC_PRIVATE_SCHEMA_DETAIL'
    const schema = z.object({ value: z.string().refine(() => false, { message: secret }) })
    expect(() => JsonText.parse(JSON.stringify({ value: secret }), schema)).toThrow(failureMessage)
    try {
      JsonText.parse(JSON.stringify({ value: secret }), schema)
    } catch (error) {
      expect(String(error)).not.toContain(secret)
      expect(error).not.toHaveProperty('cause')
      expect(error).not.toHaveProperty('issues')
    }
  })

  it('redacts thrown schema transform errors and disallows a missing runtime schema', () => {
    const secret = 'SYNTHETIC_TRANSFORM_DETAIL'
    const schema = z.string().transform(() => {
      throw new Error(secret)
    })
    expect(() => JsonText.parse('"value"', schema)).toThrow(failureMessage)
    // @ts-expect-error A schema is mandatory in the public TypeScript contract and at runtime.
    expect(() => JsonText.parse('{}')).toThrow(failureMessage)
  })
})
