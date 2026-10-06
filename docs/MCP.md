# KCOM Ads — servidor MCP (somente leitura)

Endpoint remoto **Streamable HTTP** com autenticação **OAuth 2.1** (PKCE, registro dinâmico de clientes).
As chaves da Meta e do Google ficam cifradas no servidor e nunca são expostas. Nenhuma ferramenta altera dados.

- **URL do MCP:** `https://SEU-DOMINIO/mcp`
- **Metadados OAuth:** `/.well-known/oauth-protected-resource/mcp` e `/.well-known/oauth-authorization-server`
- **Escopo:** `mcp:read`

## Segurança e acesso
- Quem conecta entra com um **usuário do painel** (e-mail, senha e 2FA, se ativo).
- **Primeira versão: acesso restrito.** Só os e-mails listados em `MCP_ALLOWED_EMAILS` podem conectar e consultar; vazio = ninguém. Os demais usuários continuam usando o painel normalmente (as permissões do painel não mudam), mas ficam bloqueados no MCP até existir acesso por cliente. A lista é revalidada a cada consulta: tirar um e-mail da lista, desativar o usuário ou revogar a conexão bloqueia o acesso imediatamente.
- As contas consultadas vêm **sempre do cadastro dos clientes** no painel. O chamador informa só o `client_id`; não existe parâmetro para consultar uma conta fora do cadastro.
- Tokens: acesso de 1 h e refresh de 30 dias com rotação; só o hash é guardado. Revogar o aplicativo (Configurações → Conexão com o Claude) ou chamar `/revoke` invalida na hora o token de acesso e o de renovação.
- Cada chamada fica na trilha de auditoria. Limite de 120 requisições/min por IP.

## Convenções
- Datas `AAAA-MM-DD`, fuso `America/Sao_Paulo`. Sem datas, usa os **7 últimos dias completos** (até ontem).
- Período máximo por consulta: 93 dias. Dados consultados ao vivo nas APIs (cache de até 5 min).
- Toda resposta traz `data_freshness.fetched_at` e `warnings` (dia incompleto, atribuição tardia, truncamento, erro de plataforma, métricas indisponíveis).
- Listas paginadas: `page` (1…) e `page_size` (até 200); a resposta traz `pagination`.
- **Erro ou indisponível nunca vira zero.** Um erro numa plataforma (ex.: permissão do Meta) aparece em `platforms[].error` e em `warnings`, sem totais nem linhas dessa plataforma; a outra plataforma segue normal. Se todas falharem, a chamada retorna `isError`. Métricas que a plataforma não fornece, ou que a conta não mede (ex.: alcance no Google, visitas/leads sem ação de conversão correspondente), vêm `null` com aviso. Dias sem entrega não aparecem na série diária. Um `0` significa que a métrica é medida e não houve eventos.

## Separação das métricas (não compare como se fossem o mesmo resultado)
| Coluna | Meta | Google |
|---|---|---|
| `landing_page_views` (visitas) | `landing_page_view` | conversões de categoria `PAGE_VIEW` |
| `conversations` | `onsite_conversion.messaging_conversation_started_7d` | categorias `PHONE_CALL_LEAD`, `CONTACT` |
| `leads` | `lead` / `onsite_conversion.lead_grouped` / pixel lead | `SUBMIT_LEAD_FORM`, `QUALIFIED_LEAD`, `CONVERTED_LEAD`, `REQUEST_QUOTE`, `BOOK_APPOINTMENT` |
| `purchases` / `purchase_value` | `purchase` / pixel purchase | categoria `PURCHASE` |
| `conversions` | **resultado configurado do canal** (leads e/ou conversas, compras, alcance…) | coluna *Conversões* do Google (ações marcadas para entrar) |

O detalhe bruto do Google vem em `conversions_by_category`. Vendas aqui são as **registradas pela plataforma**, não as do CRM.
`reach`/`frequency` são pessoas únicas: não somam entre campanhas, anúncios ou dias; o total da conta vem de uma consulta própria. O Google não fornece alcance (`null`).

**Atribuição.** Meta: janelas `7d_click` + `1d_view` (somadas, como no Gerenciador). Google: definida por ação de conversão (janelas e modelo em `get_reporting_config`).

## Ferramentas

### `list_clients`
Clientes, IDs e contas vinculadas (plataforma, ID da conta, objetivo e meta, última sincronização do painel).
Parâmetros: `include_inactive` (bool, padrão `false`).

### `get_reporting_config`
Objetivo e meta por plataforma, moeda, fuso, janela de atribuição, **definição do que conta como conversão** (e, no Google, a lista de ações de conversão com janelas e modelo), verba mensal, saldo/forma de pagamento do painel e **contexto do cliente**: briefing, produtos/serviços, preços, região atendida e metas.
Parâmetros: `client_id`.

### `get_performance`
Investimento, impressões, alcance, frequência, cliques, cliques no link, visitas, conversas, leads, vendas, valor de compra, conversões, CTR, CPC, CPM, custo por visita/conversa/lead/venda/conversão e ROAS.
Parâmetros: `client_id`; `platform` (`all`|`meta`|`google`); `level` (`account`|`campaign`|`adset`|`ad` — `adset` = conjunto no Meta, grupo de anúncios no Google); `from`, `to`; `daily` (série diária por item + total diário); `campaign_id`; `compare` (`none`|`previous_period`|`previous_year`) ou `compare_from`/`compare_to`; `page`, `page_size`.
Resposta: `platforms[]` (totais da conta, `comparison` com variação, `daily_totals`, `attribution`, `conversion_definition`, moeda e fuso), `rows[]` (itens com `metrics`, `previous`/`delta` e `daily`) e `pagination`.

### `get_search_terms`
Termos de pesquisa do Google (só Google): impressões, cliques, gasto, conversões, CTR, CPC e custo por conversão por termo e grupo.
Parâmetros: `client_id`, `from`, `to`, `campaign_id`, `min_cost`, `only_converting`, `order_by` (`cost`|`clicks`|`impressions`|`conversions`), `page`, `page_size`.
Obs.: o Google oculta termos de baixo volume; a soma dos listados é menor que o total.

### `get_creatives`
Textos principais, títulos, descrições, CTA, imagens/vídeo, página de destino (`landing_page_urls`), link de pré-visualização (`preview_link`, Meta) e desempenho opcional por anúncio.
Parâmetros: `client_id`, `platform`, `status` (`active`|`paused`|`all`), `from`, `to`, `campaign_id`, `include_performance` (padrão `true`), `page`, `page_size`.
Obs.: links de mídia do Meta são temporários. Google: anúncios responsivos de pesquisa e display (texto e imagens).

### `get_campaign_settings`
Configuração atual: objetivo, orçamento, estratégia de lance e metas (CPA/ROAS), segmentação (localização, público, idade, posicionamentos), redes, conjuntos/grupos, datas e status.
Parâmetros: `client_id`, `platform`, `status`, `campaign_id`.

### `get_change_history`
Alterações nas contas: quem, quando, o que mudou (valor anterior e novo). Google: `change_event`, últimos 30 dias. Meta: atividades da conta (cobranças diárias são filtradas).
Parâmetros: `client_id`, `platform`, `from` (padrão 14 dias atrás), `to`, `limit` (padrão 200).

### Não implementado
`get_sales_summary` (leads qualificados, vendas e receita do CRM): opcional e depende da integração com o CRM.

## Publicação
Veja [DEPLOY.md](DEPLOY.md) (variáveis de ambiente, backup, deploy e rollback).
