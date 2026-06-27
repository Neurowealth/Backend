import cors from 'cors';
import express from 'express';

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '').split(',').filter(Boolean);

export function validateCorsConfig(): void {
  if (process.env.NODE_ENV === 'production') {
    if (allowedOrigins.length === 0) {
      throw new Error(
        'CORS_ALLOWED_ORIGINS must be set and non-empty in production mode. ' +
        'Example: CORS_ALLOWED_ORIGINS=https://app.neurowealth.io,https://admin.neurowealth.io'
      );
    }
    console.log(`✓ CORS configuration validated. Allowed origins: ${allowedOrigins.join(', ')}`);
  }
}

const corsOptions: cors.CorsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) {
      callback(null, true);
      return;
    }

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`CORS rejection: origin not allowed - ${origin}`);     callback(new Error('Not allowed by CORS policy'), false);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Idempotency-Key',
    'X-Correlation-ID',
    'X-Request-ID'
  ],
  credentials: true,
  optionsSuccessStatus: 200,
  maxAge: 3600,
};

export const corsMiddleware = cors(corsOptions);

export function setupCors(app: express.Application): void {
  validateCorsConfig();
  app.use(corsMiddleware);
}
