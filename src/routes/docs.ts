import { Router, Request, Response } from 'express'
import { AuthMiddleware } from '../middleware/authenticate'
import { openApiSpec } from '../openapi/spec'

const router = Router()

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function docsUnavailable(res: Response): Response {
  return res.status(404).send('Not found')
}

router.get('/openapi.json', (req: Request, res: Response) => {
  if (isProduction()) {
    return docsUnavailable(res)
  }

  return AuthMiddleware.validateJwt(req, res, () => {
    res.status(200).json(openApiSpec)
    return undefined
  })
})

router.get('/docs', (_req: Request, res: Response) => {
  if (isProduction()) {
    return docsUnavailable(res)
  }

  res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Neurowealth API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      :root { color-scheme: light; }
      body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f7fb; color: #111827; }
      header { padding: 16px 20px; background: #111827; color: #fff; }
      header h1 { margin: 0 0 6px; font-size: 20px; }
      header p { margin: 0; font-size: 14px; color: #d1d5db; }
      .toolbar { display: flex; gap: 12px; align-items: center; padding: 14px 20px; background: #fff; border-bottom: 1px solid #e5e7eb; flex-wrap: wrap; }
      .toolbar input { min-width: 360px; max-width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 6px; font: inherit; }
      .toolbar button { padding: 10px 14px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; font: inherit; cursor: pointer; }
      .toolbar small { color: #6b7280; }
      #swagger-ui { background: #fff; }
    </style>
  </head>
  <body>
    <header>
      <h1>Neurowealth API Docs</h1>
      <p>Load the OpenAPI reference with a valid bearer token, then browse the available /api routes.</p>
    </header>
    <div class="toolbar">
      <input id="token" type="password" placeholder="Bearer token" autocomplete="off" />
      <button id="load">Load docs</button>
      <small>Token is stored in this browser's localStorage.</small>
    </div>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      const tokenInput = document.getElementById('token')
      tokenInput.value = localStorage.getItem('openapi-token') || ''

      const mountDocs = () => {
        const token = tokenInput.value.trim()
        localStorage.setItem('openapi-token', token)

        window.ui = SwaggerUIBundle({
          url: '/openapi.json',
          dom_id: '#swagger-ui',
          deepLinking: true,
          displayRequestDuration: true,
          persistAuthorization: true,
          requestInterceptor: (request) => {
            if (token) {
              request.headers.Authorization = 'Bearer ' + token
            }
            return request
          },
        })
      }

      document.getElementById('load').addEventListener('click', mountDocs)
      if (tokenInput.value.trim()) {
        mountDocs()
      }
    </script>
  </body>
</html>`)
})

export default router
