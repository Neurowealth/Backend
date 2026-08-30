import { z } from 'zod'

/** POST /api/v1/assistant/chat (#318). */
export const assistantChatSchema = z.object({
  body: z
    .object({
      message: z.string().trim().min(1).max(2000),
      /**
       * Sub-account delegation (mirrors src/middleware/subAccount.ts): the
       * child account the caller wants to act on. Omitted (or equal to the
       * caller's own id) means "act on my own account."
       */
      targetUserId: z.string().uuid().optional(),
    })
    .strict(),
})

export type AssistantChatInput = z.infer<typeof assistantChatSchema>['body']
