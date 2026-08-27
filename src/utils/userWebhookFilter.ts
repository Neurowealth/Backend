/**
 * Server-side predicate grammar for User Webhook Event Filtering (#368).
 *
 * Filter schema example:
 * {
 *   "field": "transaction.type",
 *   "op": "eq",
 *   "value": "WITHDRAWAL"
 * }
 * Or combined with and / or:
 * {
 *   "and": [
 *     { "field": "amount", "op": "gt", "value": 100 },
 *     { "field": "type", "op": "eq", "value": "WITHDRAWAL" }
 *   ]
 * }
 */

export interface FilterCondition {
  field?: string
  op?: 'eq' | 'gt' | 'lt' | 'in'
  value?: any
  and?: FilterCondition[]
  or?: FilterCondition[]
}

const MAX_FILTER_DEPTH = 5

/**
 * Validates a filterJson predicate object. Throws if invalid or depth exceeds max allowed.
 */
export function validateFilterPredicate(filter: any, depth = 1): boolean {
  if (!filter || typeof filter !== 'object') {
    throw new Error('Filter must be a valid JSON object')
  }

  if (depth > MAX_FILTER_DEPTH) {
    throw new Error(
      `Filter predicate depth exceeds maximum allowed (${MAX_FILTER_DEPTH})`
    )
  }

  if (Array.isArray(filter.and)) {
    if (filter.and.length === 0) {
      throw new Error('Filter "and" array must not be empty')
    }
    for (const sub of filter.and) {
      validateFilterPredicate(sub, depth + 1)
    }
    return true
  }

  if (Array.isArray(filter.or)) {
    if (filter.or.length === 0) {
      throw new Error('Filter "or" array must not be empty')
    }
    for (const sub of filter.or) {
      validateFilterPredicate(sub, depth + 1)
    }
    return true
  }

  if (typeof filter.field !== 'string' || !filter.field.trim()) {
    throw new Error('Filter condition must contain a valid string "field"')
  }

  const validOps = ['eq', 'gt', 'lt', 'in']
  if (!filter.op || !validOps.includes(filter.op)) {
    throw new Error(
      `Filter condition "op" must be one of: ${validOps.join(', ')}`
    )
  }

  if (filter.op === 'in' && !Array.isArray(filter.value)) {
    throw new Error(
      'Filter condition with "in" op must provide an array "value"'
    )
  }

  if (filter.value === undefined) {
    throw new Error('Filter condition must specify a "value"')
  }

  return true
}

/**
 * Extracts a nested property from a payload using dot notation (e.g. "transaction.type").
 */
function getNestedValue(obj: any, path: string): any {
  if (!obj || typeof obj !== 'object') return undefined
  const parts = path.split('.')
  let curr = obj
  for (const part of parts) {
    if (curr === null || curr === undefined || typeof curr !== 'object') {
      return undefined
    }
    curr = curr[part]
  }
  return curr
}

/**
 * Evaluates a validated filter predicate against an event payload.
 */
export function evaluateFilterPredicate(
  filter: FilterCondition | null | undefined,
  payload: Record<string, any>
): boolean {
  if (!filter || Object.keys(filter).length === 0) {
    return true // No filter specified means match all events
  }

  if (Array.isArray(filter.and)) {
    return filter.and.every((cond) => evaluateFilterPredicate(cond, payload))
  }

  if (Array.isArray(filter.or)) {
    return filter.or.some((cond) => evaluateFilterPredicate(cond, payload))
  }

  if (!filter.field) return true

  const actualValue = getNestedValue(payload, filter.field)
  const expectedValue = filter.value

  switch (filter.op) {
    case 'eq':
      return actualValue === expectedValue
    case 'gt':
      return (
        typeof actualValue === 'number' &&
        typeof expectedValue === 'number' &&
        actualValue > expectedValue
      )
    case 'lt':
      return (
        typeof actualValue === 'number' &&
        typeof expectedValue === 'number' &&
        actualValue < expectedValue
      )
    case 'in':
      return Array.isArray(expectedValue) && expectedValue.includes(actualValue)
    default:
      return true
  }
}
