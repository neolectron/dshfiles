import type { ZodType } from 'zod'

/** Validated JSON text boundary shared by Host and browser consumers. */
export class JsonText {
  /** Native decoding and schema transforms are one operation; payloads and schema diagnostics never escape. */
  static parse<Output>(text: string, schema: ZodType<Output>): Output {
    try {
      const decoded: unknown = JSON.parse(text)
      return schema.parse(decoded)
    } catch {
      throw new Error('JSON text did not match the required schema.')
    }
  }
}
