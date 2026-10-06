# Deploy no Easypanel, backup e rollback

Endereço do painel: `https://www.agenciakcom.com.br`. O endereço sem `www` também responde, mas o OAuth usa **um único endereço**: use sempre o `www`.

## Variáveis de ambiente (aba Ambiente do serviço)
| Variável | Valor |
|---|---|
| `PUBLIC_URL` | `https://www.agenciakcom.com.br` (sem barra final) |
| `MCP_ALLOWED_EMAILS` | `contato.kcomunicacao@gmail.com` (vários: separados por vírgula). Vazio = ninguém acessa o MCP |
| `COOKIE_SECURE` / `TRUST_PROXY` | `1` / `1` (como já está em produção) |
| `MASTER_KEY` | **a mesma de hoje. Não troque, não regenere** |

## 1. Backup antes de qualquer migração (funciona na versão atual)
O backup é feito **antes** do deploy, no container da versão antiga, que não tem `npm run backup`. O comando abaixo usa só o Node que já está no container (`node:sqlite`, o mesmo que o sistema usa) e `VACUUM INTO`, que gera uma cópia consistente mesmo com o sistema rodando. **Não copie `kcom.db` com `cp`**: o banco usa modo WAL e a cópia direta pode sair incompleta.

No console (terminal) do serviço no Easypanel, cole numa linha só:

```
node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');const fs=require('fs');const D=process.env.DATA||'/app/data';fs.mkdirSync(D+'/backups',{recursive:true});const f=D+'/backups/kcom-'+new Date().toISOString().replace(/[-:]/g,'').replace(/\..*/,'')+'.db';const db=new DatabaseSync(D+'/kcom.db');db.exec('PRAGMA busy_timeout=10000');db.exec(\"VACUUM INTO '\"+f+\"'\");db.close();const c=new DatabaseSync(f,{readOnly:true});console.log(f,'| integridade:',c.prepare('PRAGMA integrity_check').get().integrity_check,'|',c.prepare('SELECT COUNT(*) n FROM clients').get().n,'clientes |',c.prepare('SELECT COUNT(*) n FROM settings').get().n,'chaves')"
```

A saída esperada é algo como `/app/data/backups/kcom-20261006T121914.db | integridade: ok | 40 clientes | 6 chaves`. Confira três coisas:
- diz `integridade: ok`;
- o número de clientes e de chaves bate com o que você vê no painel;
- o arquivo foi criado dentro do volume (`/app/data/backups/`), que sobrevive ao redeploy.

Depois:
1. **Copie o arquivo para fora do servidor.** No SSH da VPS: `docker cp <container>:/app/data/backups/. ./backup-kcom/` (descubra o nome com `docker ps | grep kcom`). Guarde em outro lugar além da VPS.
2. Guarde a `MASTER_KEY` num gerenciador de senhas, **separada** do arquivo. O backup só abre com ela.
3. Se o Easypanel/VPS tiver snapshot do volume ou do servidor, faça também.
4. Anote o commit em produção hoje: `12046d1` (para o rollback).

Se o comando falhar por qualquer motivo, **não publique**.

## 2. Código no repositório que o Easypanel usa
O Easypanel faz o deploy a partir do repositório remoto (`github.com/Gabrielkcomunicacoes/sistemakcom`, branch `main`). O commit da funcionalidade (`11cdedd`) só existe localmente até ser enviado com `git push origin main`.
- O push só deve ser feito quando você autorizar a publicação. Se o Easypanel estiver com deploy automático a cada push, **o push já dispara o deploy**: faça o backup (passo 1) antes.
- Depois do push, confira no GitHub que o commit aparece em `main`.

## 3. Publicar
1. Mantenha o volume persistente montado em `/app/data` (não recriar o volume).
2. Defina as variáveis da tabela acima.
3. Faça o deploy do commit novo.
4. Confira:
   - `https://www.agenciakcom.com.br/login` abre e você entra normalmente;
   - `https://www.agenciakcom.com.br/.well-known/oauth-protected-resource/mcp` retorna JSON com `"resource":"https://www.agenciakcom.com.br/mcp"`;
   - `POST https://www.agenciakcom.com.br/mcp` sem token retorna **401**;
   - Configurações → "Conexão com o Claude" mostra a URL e "Liberado somente para: contato.kcomunicacao@gmail.com".
5. A conexão com o Kcomzinho será validada em seguida, por fora deste guia (o caminho de instalação ainda está sendo conferido).

## 4. Rollback
As mudanças no banco são **apenas aditivas** (colunas novas em `clients` e tabelas `oauth_*`). A versão anterior ignora o que não conhece, então não é preciso restaurar o banco para voltar o código.
1. Redeploy do commit anterior (`12046d1`); o volume e a `MASTER_KEY` ficam como estão.
2. Valide login e dashboard. Testado: a versão anterior sobe e lê normalmente um banco já migrado, e as chaves decifram com a mesma `MASTER_KEY`.
3. Restaurar o backup só é necessário se o **banco** for danificado:
   - pare o serviço;
   - copie o arquivo de backup para `/app/data/kcom.db` e apague `kcom.db-wal` e `kcom.db-shm` (se existirem);
   - suba o serviço com a **mesma** `MASTER_KEY`.
4. Para desligar só o MCP sem voltar a versão: esvazie `MCP_ALLOWED_EMAILS` (bloqueia todos na hora) e/ou revogue os aplicativos em Configurações.

## Backups futuros
Depois do deploy, `npm run backup` passa a existir no container (mesma lógica, com verificação de integridade) e grava em `/app/data/backups/`.
