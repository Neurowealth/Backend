/**
 * The payload itself can never be submitted (e.g. a payout with no valid
 * destination, #825), so retrying it is pointless. The dispatcher fails the
 * op terminally on the first attempt instead of burning its retry budget.
 */
export class InvalidOutboxPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidOutboxPayloadError'
  }
}
