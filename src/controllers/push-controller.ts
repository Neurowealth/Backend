import { z } from 'zod'
import db from '../db'
import { logger } from '../utils/logger'
import { pushRegistry } from '../push/pushProvider'

const registerPushSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(['IOS', 'ANDROID', 'WEB']),
})

export async function registerPushDevice(
  userId: string,
  body: unknown
): Promise<{ success: boolean; message?: string; error?: string }> {
  try {
    const parsed = registerPushSchema.parse(body)

    const existing = await db.pushDeviceToken.findUnique({
      where: {
        userId_token: {
          userId,
          token: parsed.token,
        },
      },
    })

    if (existing) {
      await db.pushDeviceToken.update({
        where: { id: existing.id },
        data: {
          isActive: true,
          lastSeenAt: new Date(),
          platform: parsed.platform,
        },
      })
      logger.info(`Reactivated push device token for user ${userId}`)
    } else {
      await db.pushDeviceToken.create({
        data: {
          userId,
          token: parsed.token,
          platform: parsed.platform.toUpperCase() as any,
          isActive: true,
        },
      })
      logger.info(`Registered new push device token for user ${userId}`)
    }

    return { success: true, message: 'Device token registered successfully' }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: 'Invalid request body',
      }
    }
    logger.error('Failed to register push device token', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      success: false,
      error: 'Failed to register device token',
    }
  }
}

export async function deregisterPushDevice(
  userId: string,
  token: string
): Promise<{ success: boolean; message?: string; error?: string }> {
  try {
    const existing = await db.pushDeviceToken.findUnique({
      where: {
        userId_token: {
          userId,
          token,
        },
      },
    })

    if (!existing) {
      return {
        success: false,
        error: 'Device token not found',
      }
    }

    await db.pushDeviceToken.update({
      where: { id: existing.id },
      data: { isActive: false },
    })

    logger.info(`Deregistered push device token for user ${userId}`)
    return { success: true, message: 'Device token deregistered successfully' }
  } catch (error) {
    logger.error('Failed to deregister push device token', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      success: false,
      error: 'Failed to deregister device token',
    }
  }
}

export async function sendPushNotification(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<void> {
  try {
    const activeTokens = await db.pushDeviceToken.findMany({
      where: {
        userId,
        isActive: true,
      },
    })

    if (activeTokens.length === 0) {
      logger.info(`No active push tokens for user ${userId}, skipping push notification`)
      return
    }

    for (const deviceToken of activeTokens) {
      const platform = deviceToken.platform.toLowerCase()
      const result = await pushRegistry.send(platform, {
        deviceToken: deviceToken.token,
        title,
        body,
        data,
      })

      if (!result.success) {
        logger.warn(`Failed to send push to ${deviceToken.token}`, {
          error: result.error,
        })

        if (result.error?.includes('InvalidRegistration') || result.error?.includes('Unregistered')) {
          await db.pushDeviceToken.update({
            where: { id: deviceToken.id },
            data: { isActive: false },
          })
          logger.info(`Deactivated invalid push token ${deviceToken.token}`)
        }
      }
    }
  } catch (error) {
    logger.error('Failed to send push notification', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
