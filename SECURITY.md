# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please report it responsibly.

### How to Report

1. **Do NOT** open a public GitHub issue for security vulnerabilities
2. Email security concerns to the maintainers privately
3. Include as much detail as possible:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

### What to Expect

- Acknowledgment of your report within 48 hours
- Regular updates on the progress of addressing the issue
- Credit in the security advisory (unless you prefer to remain anonymous)

### Scope

The following are in scope:
- Backend API vulnerabilities
- Smart contract security issues (Soroban contracts)
- Authentication/authorization bypasses
- Stellar transaction security issues
- Wallet and key management vulnerabilities
- Cross-site scripting (XSS) and injection attacks
- Sensitive data exposure

### Out of Scope

- Issues in dependencies (report to the respective projects)
- Social engineering attacks
- Denial of service attacks
- Issues requiring physical access

## Security Best Practices for Contributors

1. Never commit secrets or private keys
2. Use environment variables for sensitive configuration
3. Follow the principle of least privilege
4. Validate and sanitize all user inputs
5. Use parameterized queries to prevent SQL injection
6. Keep dependencies updated
