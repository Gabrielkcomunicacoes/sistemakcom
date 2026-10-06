import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { provider, consentRouter, publicBase, resourceUrl, SCOPES } from './oauth.js';
import { buildServer } from './tools.js';

const rpcError = (res, status, message) => res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

/** Monta OAuth (/authorize, /token, /register, /.well-known/*) e o endpoint /mcp (Streamable HTTP, somente leitura). */
export function mountMcp(app) {
  const base = publicBase();
  const resource = resourceUrl();

  app.use(mcpAuthRouter({
    provider, issuerUrl: base, baseUrl: base, resourceServerUrl: resource, scopesSupported: SCOPES, resourceName: 'KCOM Ads (somente leitura)',
  }));
  app.use('/oauth', consentRouter);

  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas requisições.' } });
  const bearer = requireBearerAuth({
    verifier: provider, requiredScopes: SCOPES, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource), expectedResource: resource,
  });

  const r = Router();
  r.post('/', limiter, bearer, async (req, res) => {
    // modo sem estado: um servidor/transporte por requisição
    const server = buildServer(req.auth.extra, req.ip);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp]', e.message);
      if (!res.headersSent) rpcError(res, 500, 'Erro interno.');
    }
  });
  const notAllowed = (_req, res) => { res.setHeader('Allow', 'POST'); rpcError(res, 405, 'Método não permitido.'); };
  r.get('/', notAllowed);
  r.delete('/', notAllowed);
  app.use('/mcp', r);
}
