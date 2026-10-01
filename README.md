# KCOM Monitor

Painel de saldos e performance de campanhas (Google Ads + Meta Ads) com alertas, login seguro e modo TV.

## Rodar
```
npm install
npm run setup        # cria .env (MASTER_KEY) e o admin com senha aleatória
npm run seed:demo    # opcional: 20 clientes fictícios para ver o painel
npm start            # http://localhost:3000
```
Depois entre em **Chaves e integrações** e cole os tokens (Meta, Google, Telegram/webhook).
Clientes com ID de conta real (ex.: `act_123456789`, `1234567890`) são sincronizados a cada 15 min; IDs "demo" não.

## Segurança
scrypt nas senhas · bloqueio após 5 erros · rate limit · sessões em cookie HttpOnly/SameSite=Strict (hash no banco) ·
CSRF + checagem de Origin · CSP estrita sem scripts inline · chaves de API cifradas com AES-256-GCM ·
2FA TOTP · perfis (admin/gestor/visualização/TV) · trilha de auditoria · troca de senha obrigatória no 1º acesso.

## Produção
Coloque atrás de HTTPS (nginx/Caddy) e defina `COOKIE_SECURE=1` e `TRUST_PROXY=1` no `.env`. Faça backup de `.env` e `data/`.
