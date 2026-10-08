import { z } from 'zod'

const encoded = z
  .string()
  .min(1)
  .max(200000)
  .regex(/^[A-Za-z0-9_-]+$/)
const credential = {
  id: encoded,
  rawId: encoded,
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
}
export const registerOptionsSchema = z.object({
  deviceLabel: z.string().trim().min(1).max(100).optional(),
})
export const registerVerifySchema = z.object({
  challengeId: encoded,
  deviceLabel: z.string().trim().min(1).max(100).optional(),
  response: z.object({
    ...credential,
    response: z.object({
      clientDataJSON: encoded,
      attestationObject: encoded,
      transports: z
        .array(
          z.enum([
            'ble',
            'cable',
            'hybrid',
            'internal',
            'nfc',
            'smart-card',
            'usb',
          ])
        )
        .optional(),
    }),
  }),
})
export const loginOptionsSchema = z.object({
  userId: z.string().uuid().optional(),
})
export const loginVerifySchema = z.object({
  challengeId: encoded,
  userId: z.string().uuid().optional(),
  response: z.object({
    ...credential,
    response: z.object({
      clientDataJSON: encoded,
      authenticatorData: encoded,
      signature: encoded,
      userHandle: encoded.optional(),
    }),
  }),
})
export const credentialIdParamSchema = z.object({
  id: z.string().uuid('Invalid credential ID'),
})
