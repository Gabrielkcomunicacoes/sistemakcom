# Deploy no Easypanel, backup e rollback

Domínio do painel: `https://www.agenciakcom.com.br` (o apex `agenciakcom.com.br` também responde, mas o OAuth usa **um único endereço**: use sempre o `www`).

## Variáveis de ambiente (aba Ambiente do serviço)
| Variável | Valor |
|---|---|
| `PUBLIC_URL` | `https://www.agenciakcom.com.br` (sem barra final) |
| `MCP_ALLOWED_EMAILS` | e-mail do seu usuário do painel (mais de um: separados por vírgula). Vazio = ninguém acessa o MCP |
| `COOKIE_SECURE` / `TRUST_PROXY` | `1` / `1` (como já está em produção) |
| `MASTER_KEY` | **a mesma de hoje. Não troque, não regenere** |

## Antes de publicar: backup
1. Console do serviço no Easypanel: `npm run backup` (gera `/app/data/backups/kcom-AAAAMMDD-HHMMSS.db`, com verificação de integridade).
2. Baixe esse arquivo para fora do servidor (e confirme o tamanho). Ele contém as chaves **cifradas**.
3. Guarde a `MASTER_KEY` em local separado (gerenciador de senhas). Sem ela o backup não abre.
4. Anote o commit em produção e a tag/ID da imagem atual (para o rollback).
Se o Easypanel tiver backup/snapshot do volume, faça também.

## Publicar
1. Garanta que o volume persistente está montado em `/app/data` (não recriar o volume).
2. Defina as variáveis acima e faça o deploy do commit novo.
3. Confira:
   - `https://www.agenciakcom.com.br/login` abre e você entra normalmente;
   - `https://www.agenciakcom.com.br/.well-known/oauth-protected-resource/mcp` retorna JSON com `"resource":"https://www.agenciakcom.com.br/mcp"`;
   - `POST /mcp` sem token retorna **401**;
   - Configurações → "Conexão com o Claude" mostra a URL e "Liberado somente para: seu e-mail".
4. Só então cadastre o conector no Claude: URL `https://www.agenciakcom.com.br/mcp` e login com o usuário liberado.

## Rollback
As mudanças no banco são **apenas aditivas** (colunas novas em `clients` e tabelas `oauth_*`). A versão anterior ignora o que não conhece, então não é preciso restaurar o banco para voltar o código.
1. Redeploy do commit/imagem anterior (o volume e a `MASTER_KEY` ficam como estão).
2. Valide login e dashboard. Foi testado: a versão anterior (`12046d1`) sobe e lê normalmente um banco já migrado, com as chaves decifrando com a mesma `MASTER_KEY`.
3. Restaurar o backup só é necessário se o **banco** for danificado:
   - pare o serviço;
   - copie o arquivo de backup para `/app/data/kcom.db` e apague `kcom.db-wal` e `kcom.db-shm` (se existirem);
   - suba o serviço com a **mesma** `MASTER_KEY`.
4. Para desligar só o MCP sem voltar a versão: esvazie `MCP_ALLOWED_EMAILS` (bloqueia todos na hora) e/ou revogue os aplicativos em Configurações.
