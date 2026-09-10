# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.x     | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability within NeuroWealth, please send an email to the maintainers. All security vulnerabilities will be promptly addressed.

**Please do NOT report security vulnerabilities through public GitHub issues.**

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 5 business days
- **Resolution**: Depends on severity, but typically within 30 days

## Security Measures

This project implements the following security measures:

- **Authentication**: JWT-based authentication with refresh tokens
- **Authorization**: Role-based access control with API key scope enforcement
- **Data Protection**: Environment-based configuration, no secrets in code
- **Input Validation**: Zod schema validation on all inputs
- **Rate Limiting**: Express rate limiter on all endpoints
- **Security Headers**: Helmet.js for HTTP security headers
- **CORS**: Hardened CORS configuration
- **Dependencies**: Automated dependency updates via Dependabot
- **Secrets Scanning**: Gitignore prevents committing sensitive files

## Best Practices for Contributors

- Never commit API keys, secret keys, or passwords
- Use environment variables for all sensitive configuration
- Run `npm run lint` and `npm run typecheck` before submitting PRs
- Follow the principle of least privilege
- Validate all inputs at the API boundary
