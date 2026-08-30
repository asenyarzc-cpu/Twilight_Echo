export const MAX_JSON_NESTING_DEPTH = 64

const JSON_SERIALIZATION_REJECTED = Symbol('JSON serialization rejected')
const JSON_NESTING_TOO_DEEP = Symbol('JSON nesting too deep')
const JSON_VALUE_TOO_LARGE = Symbol('JSON value too large')
const JSON_QUOTE = 0x22
const JSON_BACKSLASH = 0x5c
const JSON_OBJECT_OPEN = 0x7b
const JSON_OBJECT_CLOSE = 0x7d
const JSON_ARRAY_OPEN = 0x5b
const JSON_ARRAY_CLOSE = 0x5d

/**
 * Serializes an untrusted JSON-compatible value with a bounded nesting depth.
 *
 * The replacer runs before JSON descends into each child, avoiding a separate
 * recursive walk and converting implementation-specific serialization errors
 * into stable field-level validation errors.
 */
export function stringifyJsonWithNestingLimit(value: unknown, field: string): string {
  const depths = new WeakMap<object, number>()
  let json: string | undefined

  try {
    json = JSON.stringify(
      value,
      function jsonDepthReplacer(this: object, _key: string, candidate: unknown): unknown {
        if (typeof candidate === 'bigint') throw JSON_SERIALIZATION_REJECTED
        if (
          candidate === null ||
          (typeof candidate !== 'object' && typeof candidate !== 'function')
        ) {
          return candidate
        }

        const depth = (depths.get(this) ?? 0) + 1
        if (depth > MAX_JSON_NESTING_DEPTH) throw JSON_NESTING_TOO_DEEP
        depths.set(candidate, depth)
        return candidate
      }
    )
  } catch (error) {
    if (error === JSON_NESTING_TOO_DEEP) throw new Error(`${field} is too deeply nested`)
    throw new Error(`${field} must be JSON serializable`)
  }

  if (json === undefined) throw new Error(`${field} must be JSON serializable`)
  return json
}

/**
 * Performs a linear nesting check on JSON text before JSON.parse allocates a
 * deeply recursive structure. Quotes and escaped quotes are skipped so braces
 * in string values never count as JSON containers.
 */
export type JsonNestingParseResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'too-deep' | 'invalid' }

/**
 * Validates an in-memory JSON-compatible value before it is retained or
 * forwarded across a process boundary. The traversal aborts before producing
 * an unbounded serialized string, while the final exact byte check catches
 * JSON escaping and punctuation that the early budget intentionally treats
 * conservatively.
 */
export type JsonValueLimitResult =
  | { ok: true }
  | { ok: false; reason: 'too-deep' | 'too-large' | 'invalid' }

export function inspectJsonValueWithLimits(value: unknown, maxBytes: number): JsonValueLimitResult {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer')
  }

  const depths = new WeakMap<object, number>()
  let estimatedBytes = 0
  let json: string | undefined

  const reserve = (bytes: number): void => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes - estimatedBytes) {
      throw JSON_VALUE_TOO_LARGE
    }
    estimatedBytes += bytes
  }

  try {
    json = JSON.stringify(
      value,
      function jsonValueLimitReplacer(this: object, key: string, candidate: unknown): unknown {
        if (key && !Array.isArray(this)) reserve(jsonEscapedUtf8ByteLength(key) + 4)

        if (candidate === null) {
          reserve(5)
          return candidate
        }

        switch (typeof candidate) {
          case 'string':
            reserve(jsonEscapedUtf8ByteLength(candidate) + 3)
            return candidate
          case 'number':
            // A finite JSON number needs at most 24 bytes; leave a little
            // structural slack without rejecting the largest visualization data.
            reserve(16)
            return candidate
          case 'boolean':
            reserve(6)
            return candidate
          case 'bigint':
            throw JSON_SERIALIZATION_REJECTED
          case 'undefined':
          case 'function':
          case 'symbol':
            // JSON omits these in objects and encodes them as null in arrays.
            if (Array.isArray(this)) reserve(5)
            return candidate
          case 'object': {
            const depth = (depths.get(this) ?? 0) + 1
            if (depth > MAX_JSON_NESTING_DEPTH) throw JSON_NESTING_TOO_DEEP
            depths.set(candidate, depth)
            reserve(2)
            return candidate
          }
          default:
            return candidate
        }
      }
    )
  } catch (error) {
    if (error === JSON_NESTING_TOO_DEEP) return { ok: false, reason: 'too-deep' }
    if (error === JSON_VALUE_TOO_LARGE) return { ok: false, reason: 'too-large' }
    return { ok: false, reason: 'invalid' }
  }

  if (json === undefined) return { ok: false, reason: 'invalid' }
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    return { ok: false, reason: 'too-large' }
  }
  return { ok: true }
}

function jsonEscapedUtf8ByteLength(value: string): number {
  let bytes = Buffer.byteLength(value, 'utf8')
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === JSON_QUOTE || code === JSON_BACKSLASH) {
      bytes += 1
    } else if (code <= 0x1f) {
      bytes +=
        code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 1 : 5
    }
  }
  return bytes
}

/**
 * Parses JSON only after the bounded-text check succeeds.  Callers receive a
 * small result union instead of engine-specific parser exceptions, allowing
 * each trust seam to retain its own error or fallback policy.
 */
export function tryParseJsonWithNestingLimit(json: string): JsonNestingParseResult {
  if (!isJsonNestingWithinLimit(json)) return { ok: false, reason: 'too-deep' }
  try {
    return { ok: true, value: JSON.parse(json) as unknown }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}

/**
 * Parses untrusted JSON after the shared nesting check, preserving the usual
 * throwing call-site contract for parsers that already surface malformed data
 * as errors.
 */
export function parseJsonWithNestingLimit(json: string): unknown {
  const parsed = tryParseJsonWithNestingLimit(json)
  if (parsed.ok) return parsed.value
  throw new Error(parsed.reason === 'too-deep' ? 'JSON is too deeply nested' : 'Invalid JSON')
}

export function isJsonNestingWithinLimit(json: string): boolean {
  let depth = 0
  let insideString = false
  let escaped = false

  for (let index = 0; index < json.length; index += 1) {
    const code = json.charCodeAt(index)
    if (insideString) {
      if (escaped) {
        escaped = false
      } else if (code === JSON_BACKSLASH) {
        escaped = true
      } else if (code === JSON_QUOTE) {
        insideString = false
      }
      continue
    }

    if (code === JSON_QUOTE) {
      insideString = true
      continue
    }
    if (code === JSON_OBJECT_OPEN || code === JSON_ARRAY_OPEN) {
      depth += 1
      if (depth > MAX_JSON_NESTING_DEPTH) return false
    } else if (code === JSON_OBJECT_CLOSE || code === JSON_ARRAY_CLOSE) {
      depth -= 1
    }
  }

  return true
}
