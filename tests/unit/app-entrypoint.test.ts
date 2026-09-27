import fs from 'fs'
import path from 'path'
import request from 'supertest'
import defaultApp, { createApp } from '../../src/app'

describe('Entrypoint and CORS Demo Isolation', () => {
  const originalEnv = process.env.NODE_ENV

  afterEach(() => {
    process.env.NODE_ENV = originalEnv
  })

  describe('package.json configuration', () => {
    it('should configure main and start scripts to point to dist/index.js', () => {
      const packageJsonPath = path.resolve(__dirname, '../../package.json')
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))

      expect(packageJson.main).toBe('dist/index.js')
      expect(packageJson.scripts.start).toBe('node dist/index.js')
    })

    it('should match the entrypoint used in Dockerfile CMD', () => {
      const dockerfilePath = path.resolve(__dirname, '../../Dockerfile')
      const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8')

      expect(dockerfileContent).toContain('node dist/index.js')
    })
  })

  describe('app demo route isolation', () => {
    it('should export a configured default express app instance', () => {
      expect(defaultApp).toBeDefined()
      expect(typeof defaultApp.listen).toBe('function')
    })

    it('should isolate demo routes when running in production mode', async () => {
      process.env.NODE_ENV = 'production'
      const app = createApp()

      const healthRes = await request(app).get('/health')
      expect(healthRes.status).toBe(200)

      const getRes = await request(app).get('/api/data')
      expect(getRes.status).toBe(404)

      const postRes = await request(app)
        .post('/api/data')
        .send({ test: 'payload' })
      expect(postRes.status).toBe(404)

      const putRes = await request(app)
        .put('/api/data/123')
        .send({ test: 'update' })
      expect(putRes.status).toBe(404)

      const deleteRes = await request(app).delete('/api/data/123')
      expect(deleteRes.status).toBe(404)
    })

    it('should expose demo routes when running in non-production mode', async () => {
      process.env.NODE_ENV = 'development'
      const app = createApp()

      const getRes = await request(app).get('/api/data')
      expect(getRes.status).toBe(200)
      expect(getRes.body).toHaveProperty(
        'message',
        'This endpoint is protected by CORS'
      )

      const postRes = await request(app)
        .post('/api/data')
        .send({ title: 'New Item' })
      expect(postRes.status).toBe(201)
      expect(postRes.body.data).toEqual({ title: 'New Item' })

      const putRes = await request(app)
        .put('/api/data/123')
        .send({ title: 'Updated Item' })
      expect(putRes.status).toBe(200)
      expect(putRes.body.id).toBe('123')

      const deleteRes = await request(app).delete('/api/data/123')
      expect(deleteRes.status).toBe(200)
      expect(deleteRes.body.id).toBe('123')
    })
  })
})
