/**
 * Method registry (#317) — a whitelist lookup, so the report/service layer
 * never string-switches on a raw user-supplied method value (closes the
 * injection concern the issue calls out).
 */
import { AccountingMethod } from '@prisma/client'
import { CostBasisMethod } from './types'
import { fifoMethod } from './fifo'
import { lifoMethod } from './lifo'
import { hifoMethod } from './hifo'
import { specificIdMethod } from './specificId'

const METHODS: Record<AccountingMethod, CostBasisMethod> = {
  FIFO: fifoMethod,
  LIFO: lifoMethod,
  HIFO: hifoMethod,
  SPECIFIC_ID: specificIdMethod,
}

export function resolveMethod(method: AccountingMethod): CostBasisMethod {
  const resolved = METHODS[method]
  if (!resolved) {
    throw new Error(`Unknown accounting method: ${method}`)
  }
  return resolved
}

export * from './types'
export { SpecificIdSelectionError } from './specificId'
