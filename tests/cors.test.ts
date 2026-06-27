import request from 'supertest';
import express from 'express';
import { corsMiddleware } from '../src/middleware/corsandbody';

describe('CORS Middleware', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(corsMiddleware);
    app.get('/test', (req, res) => res.json({ message: 'success' }));
    app.post('/test', (req, res) => res.status(201).json({ created: true }));
    app.put('/test/:id', (req, res) => res.json({ updated: true }));
    app.delete('/test/:id', (req, res) => res.json({ deleted: true }));
  });

  describe('Allowed Origins', () => {
    it('should allow requests from localhost:3000', async () => {
      const response = await request(app)
        .get('/test')
        .set('Origin', 'http://localhost:3000');
      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    });

    it('should allow requests from localhost:3001', async () => {
      const response = await request(app)
        .get('/test')
        .set('Origin', 'http://localhost:3001');
      expect(response.status).toBe(200);
    });
  });

  describe('Disallowed Origins', () => {
    it('should reject requests from unauthorized origins', async () => {
      const response = await request(app)
        .get('/test')
        .set('Origin', 'https://malicious.com');
      expect(response.status).toBe(403);
    });
  });

  describe('HTTP Methods', () => {
    it('should allow GET requests', async () => {
      const response = await request(app)
        .get('/test')
        .set('Origin', 'http://localhost:3000');
      expect(response.status).toBe(200);
    });

    it('should allow POST requests', async () => {
      const response = await request(app)
        .post('/test')
        .set('Origin', 'http://localhost:3000');
      expect(response.status).toBe(201);
    });

    it('should allow PUT requests', async () => {
      const response = await request(app)
        .put('/test/123')
        .set('Origin', 'http://localhost:3000');
      expect(response.status).toBe(200);
    });

    it('should allow DELETE requests', async () => {
      const response = await request(app)
        .delete('/test/123')
        .set('Origin', 'http://localhost:3000');
      expect(response.status).toBe(200);
    });
  });

  describe('Preflight Requests', () => {
    it('should handle OPTIONS preflight requests', async () => {
      const response = await request(app)
        .options('/test')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type');
      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-methods']).toContain('POST');
    });
  });

  describe('Required Headers', () => {
    it('should allow Content-Type header', async () => {
      const response = await request(app)
        .get('/test')
        .set('Origin', 'http://localhost:3000')
        .set('Content-Type', 'application/json');
      expect(response.status).toBe(200);
    });

    it('should allow Authorization header', async () => {
      const response = await request(app)
        .get('/test')
        .set('Origin', 'http://localhost:3000')
        .set('Authorization', 'Bearer token123');
      expect(response.status).toBe(200);
    });

    it('should allow Idempotency-Key header', async () => {
      const response = await request(app)
        .get('/test')
        .set('Origin', 'http://localhost:3000')
        .set('Idempotency-Key', 'unique-key-123');
      expect(response.status).toBe(200);
    });

    it('should allow X-Correlation-ID header', async () => {
      const response = await request(app)
        .get('/test')
        .set('Origin', 'http://localhost:3000')
        .set('X-Correlation-ID', 'correlation-123');
      expect(response.status).toBe(200);
    });
  });

  describe('Credentials', () => {
    it('should allow credentials for allowed origins', async () => {
      const response = await request(app)
        .get('/test')
        .set('Origin', 'http://localhost:3000');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });
  });
});
