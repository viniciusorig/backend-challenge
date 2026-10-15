# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de provedores de jogos por **HTTP** e por **SQS**. O serviço continua correto com mensagens duplicadas, fora de ordem e processadas em paralelo por várias instâncias.

**Stack:** Bun 1.4 · TypeScript estrito · NestJS 11 · PostgreSQL 17 · MikroORM 6 · SQS (MiniStack, compatível com LocalStack) · Keycloak (OIDC) · Docker Compose.

As decisões técnicas, os trade-offs e as limitações estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Sumário

1. [Início rápido](#início-rápido)
2. [Rodando 3 instâncias](#rodando-3-instâncias-docker-compose)
3. [Testes](#testes)
4. [Teste de carga](#teste-de-carga)
5. [Autenticação](#autenticação)
6. [API — exemplos](#api--exemplos)
7. [Configuração](#configuração)
8. [Como ler este código](#como-ler-este-código)
9. [Estrutura de pastas](#estrutura-de-pastas)

---

## Início rápido

Pré-requisitos: **Bun ≥ 1.4** e **Docker** com Compose.

```bash
bun install
bun run infra:up        # PostgreSQL 17 + MiniStack (SQS) + Keycloak em containers
bun run migrate         # aplica as migrations versionadas (reversíveis)
bun run sqs:setup       # cria wager-transactions.fifo, a DLQ e wagering-events.fifo (idempotente)
bun run dev             # API em http://localhost:3000 (com watch)
```

Comandos úteis:

| Comando | O que faz |
|---|---|
| `bun run start` | sobe o serviço (HTTP + consumidor SQS + relay da outbox + worker de referências) |
| `bun run migrate` / `migrate:down` / `migrate:status` | aplica, reverte a última ou lista as migrations |
| `bun run typecheck` | `tsc --noEmit` em modo estrito (src, testes e scripts) |
| `bun run infra:down` | derruba os containers e apaga os volumes |

Em todas as instâncias o mesmo processo roda quatro coisas: a API HTTP, o consumidor SQS, o relay da outbox e o worker de referências pendentes. Cada uma pode ser desligada por variável de ambiente (ver [Configuração](#configuração)).

## Rodando 3 instâncias (Docker Compose)

```bash
docker compose --profile app up -d --build
# app-1 → http://localhost:3001   app-2 → :3002   app-3 → :3003
curl localhost:3002/health/ready
```

O profile `app` roda primeiro um job `migrate` e depois sobe três réplicas do serviço contra o mesmo PostgreSQL, o mesmo SQS e o mesmo Keycloak. `docker compose stop` envia SIGTERM; cada instância termina as mensagens em andamento e devolve as não iniciadas para a fila.

> **SQS local.** O compose usa `ministackorg/ministack:1.5.27`, emulador gratuito e compatível com a API e a porta (4566) da LocalStack. Para usar a LocalStack, troque a imagem do serviço `sqs` por `localstack/localstack` com `SERVICES=sqs`. Nada no código muda.

## Testes

```bash
bun run infra:up && bun test      # suíte completa: 141 testes, ~60 s
```

| Comando | Escopo |
|---|---|
| `bun run test:unit` | domínio e regras (sem I/O) |
| `bun run test:integration` | PostgreSQL e SQS **reais** em containers |
| `bun run test:concurrency` | **3 processos reais** do serviço, crash, restart |

Os testes de integração e de concorrência **nunca** substituem PostgreSQL nem SQS por mocks. Eles usam o banco `wagering_test` (criado pelo `docker/postgres-init.sql`) e filas com nome único por arquivo de teste. O fake em memória (`test/support/in-memory-store.ts`) só é usado nos testes de unidade.

Todo teste que mexe em saldo termina verificando a invariante `wallet.balance == Σ ledger == último balance_after` (`expectLedgerConsistent`).

<details>
<summary><b>Mapa: cenário obrigatório (seção 13) → teste</b></summary>

| Cenário | Onde |
|---|---|
| Money: escala, arredondamento, entradas inválidas | `test/unit/money.test.ts` |
| Invariantes da Wallet | `test/unit/wallet.test.ts` |
| Regras BET / WIN / LOSS / REFUND / ROLLBACK | `test/unit/wager-rules.test.ts`, `test/unit/wager-transaction.test.ts` |
| Conflito de moeda | `money.test.ts`, `wallet.test.ts`, `wager-rules.test.ts` |
| Idempotency key com payload divergente | `wager-rules.test.ts` › idempotency; `http.test.ts` (409) |
| Migrations (up/down) e constraints | `test/integration/schema.test.ts` (SQL cru contra o banco) |
| Atomicidade wallet + ledger + inbox + outbox | `test/integration/atomicity.test.ts` |
| Inbox e redelivery | `test/integration/sqs-consumer.test.ts` |
| Publishers concorrentes na mesma outbox | `test/integration/outbox.test.ts` |
| Retry e DLQ | `sqs-consumer.test.ts` (lock real segurado → `LOCK_TIMEOUT` → retry → DLQ) |
| Recuperação após reinicialização | `test/concurrency/multi-instance.test.ts` › 5 e 8 |
| **Concorrência 1**: mesma aposta 50× em paralelo | `multi-instance.test.ts` › 1 |
| **2**: duas apostas de 80 com saldo 100 (seção 8) | `multi-instance.test.ts` › 2 (repetido 10×) |
| **3**: wallets distintas em paralelo | `multi-instance.test.ts` › 3 |
| **4**: ≥ 3 processos simultâneos | o arquivo inteiro: 3 processos `bun src/main.ts` |
| **5**: worker morto depois do commit e antes do ack | `multi-instance.test.ts` › 5 (`process.exit(137)` injetado) |
| **6**: dois publishers na mesma outbox | `outbox.test.ts` + `multi-instance.test.ts` › 6 |
| **7**: ROLLBACK/REFUND antes da referência | `pending-reference.test.ts` + `multi-instance.test.ts` › 7 |
| **8**: reinício do serviço com consistência final | `multi-instance.test.ts` › 8 (SIGKILL nas 3 instâncias no meio da carga) |

</details>

## Teste de carga

```bash
bun run test:load    # LOAD_INSTANCES=3 LOAD_CONCURRENCY=64 LOAD_DURATION_SEC=20 LOAD_WALLETS=200
```

O script sobe N instâncias reais e aplica BETs por HTTP com concorrência fixa em dois perfis: carga espalhada entre muitas wallets e carga concentrada em uma única wallet ("quente"). Ao final ele audita o ledger de todas as wallets.

Resultado no ambiente de desenvolvimento (i9-12900KF, 24 threads, 31 GB, Docker local, 3 instâncias, 64 clientes, 20 s por perfil):

| Perfil | Req | Throughput | p50 | p95 | p99 | Erros | Lock conflicts | Outbox lag máx. |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 200 wallets | 20.533 | **1.021 req/s** | 46 ms | 136 ms | 165 ms | 0 % | 0 | 12,2 s |
| 1 wallet (quente) | 1.324 | **64 req/s** | 644 ms | 2.885 ms | 4.686 ms | 0 % | 0 | 28,6 s* |

Auditoria final: 201 wallets, **0 divergências** entre saldo e ledger.

A análise completa está em [ARCHITECTURE.md › Teste de carga](ARCHITECTURE.md#15-teste-de-carga). Em resumo, a wallet quente fica limitada pela latência de `fsync` do commit (~11 ms medidos neste volume Docker), porque cada aposta precisa esperar o commit da anterior. O lag da outbox mostra que o relay não acompanha 2.000 eventos/s sustentados e drena o acúmulo depois do pico.

\* Inclui o acúmulo herdado do perfil anterior.

## Autenticação

A autenticação usa um Identity Provider externo: o **Keycloak**, que sobe no compose com o realm importado de `docker/keycloak/wagering-realm.json`. A API não guarda usuário nem senha; ela só valida o token.

- Cada provedor é um client OAuth2 (`client_credentials`). O token traz o claim `provider_id`, e um provedor só consegue enviar ou consultar transações do próprio `providerId` (senão recebe `403`).
- `POST /wallets/:id/reconciliation` exige a role `operator` (client `backoffice`).
- `/health/*`, `/metrics` e `/auth/token` são públicos. Mensagens da fila SQS são canal interno e não usam token.

Credenciais de desenvolvimento:

| client | secret | pode |
|---|---|---|
| `provider-a` | `provider-a-secret` | enviar e consultar transações de `provider-a` |
| `provider-b` | `provider-b-secret` | enviar e consultar transações de `provider-b` |
| `backoffice` | `backoffice-secret` | consultar tudo e reconciliar |

```bash
# pede o token (a API repassa ao Keycloak); também aceita HTTP Basic
curl -s -XPOST localhost:3000/auth/token -H 'content-type: application/json' \
  -d '{"clientId":"provider-a","clientSecret":"provider-a-secret"}'
# → {"access_token":"eyJ...","token_type":"Bearer","expires_in":900}

TOKEN=...   # use em todas as rotas protegidas
curl -s localhost:3000/wallets/<id> -H "Authorization: Bearer $TOKEN"
```

O token também pode ser pedido direto ao Keycloak (`http://localhost:8080/realms/wagering/protocol/openid-connect/token`). Para rodar sem autenticação, use `AUTH_ENABLED=false`.

## API — exemplos

Os exemplos abaixo usam o `$TOKEN` da seção anterior.

```bash
# Criar wallet (saldo inicial vira uma transação OPENING + lançamento CREDIT, na mesma transação SQL)
curl -s -XPOST localhost:3000/wallets -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# Submeter aposta (Idempotency-Key obrigatório)
curl -s -XPOST localhost:3000/wagering/transactions -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
       "walletId":"<id>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
# → 201 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
# reenviar igual → 200 com o mesmo corpo e idempotentReplay:true

curl -s "localhost:3000/wallets/<id>/ledger?limit=50" -H "Authorization: Bearer $TOKEN"   # cursor opaco (nextCursor)
curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-123 -H "Authorization: Bearer $TOKEN"
curl -s -XPOST localhost:3000/wallets/<id>/reconciliation -H "Authorization: Bearer $OPERATOR_TOKEN"  # token do client backoffice
curl -s localhost:3000/health/ready                          # PostgreSQL + SQS
curl -s localhost:3000/metrics                               # Prometheus
```

| Situação | HTTP |
|---|---|
| Processada (nova) / replay | `201` / `200` |
| Aceita, aguardando referência (`PENDING_REFERENCE`) | `202` |
| Rejeitada por regra de negócio (`REJECTED` + `failureCode`) | `422` |
| Payload inválido / header ausente | `400` |
| Sem token, token inválido ou expirado | `401` |
| Token sem permissão (outro provider, sem role) | `403` |
| Wallet ou transação inexistente | `404` |
| Conflito de idempotência (mesma key, payload diferente) | `409` |
| Falha transitória (banco fora, lock timeout) | `503` + `Retry-After` |

Os detalhes e a taxonomia de `failureCode` estão em [ARCHITECTURE.md › Contratos](ARCHITECTURE.md#10-contratos-http-status-e-failurecode).

Mensagem SQS (fila `wager-transactions.fifo`, `MessageGroupId` = `walletId`):

```json
{ "messageId": "msg-123", "type": "WagerTransactionRequested", "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": { "providerId": "provider-a", "externalTransactionId": "transaction-123", "idempotencyKey": "provider-a:transaction-123",
            "playerId": "…", "walletId": "…", "roundId": "round-987", "gameId": "fortune-chimp",
            "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" } } }
```

## Configuração

Todas as variáveis têm default para o ambiente local (`src/shared/config.ts`). O Bun carrega `.env` automaticamente; há um exemplo em `.env.example`.

| Variável | Default | Uso |
|---|---|---|
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | |
| `DB_POOL_MAX` | `20` | conexões por instância |
| `DB_LOCK_TIMEOUT_MS` | `3000` | tempo máximo esperando o lock de uma wallet (vira `503`/retry) |
| `SQS_ENDPOINT` | `http://localhost:4566` | MiniStack / LocalStack |
| `SQS_MAX_RECEIVE_COUNT` | `5` | tentativas antes da DLQ |
| `SQS_VISIBILITY_TIMEOUT_SEC` | `30` | |
| `REFERENCE_RETRY_MAX_ATTEMPTS` | `10` | tentativas de resolver referência (≈ 14 min de janela) |
| `REFERENCE_RETRY_BASE_DELAY_MS` / `_MAX_DELAY_MS` | `1000` / `300000` | backoff exponencial com jitter |
| `OUTBOX_BATCH_SIZE` / `OUTBOX_LEASE_MS` | `200` / `30000` | relay da outbox |
| `CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED`, `PENDING_REFERENCE_WORKER_ENABLED` | `true` | liga/desliga cada worker |
| `SHUTDOWN_GRACE_MS` | `20000` | tempo para drenar mensagens no SIGTERM |
| `AUTH_ENABLED` | `true` | valida o Bearer token nas rotas protegidas |
| `AUTH_ISSUER` / `AUTH_AUDIENCE` | `http://localhost:8080/realms/wagering` / `wagering-api` | `iss` e `aud` esperados no token |
| `AUTH_JWKS_URI` / `AUTH_TOKEN_URL` | derivados do issuer | chaves públicas e endpoint de token do Keycloak |
| `LOG_LEVEL` | `info` | |
| `CHAOS_CRASH_AFTER_COMMIT_BEFORE_ACK` | `false` | **apenas testes**: injeta o crash depois do commit e antes do ack |

## Como ler este código

Ordem sugerida, do núcleo para as bordas (cerca de 30 minutos):

1. **`src/domain/money/money.ts`**: dinheiro como `bigint` de centavos, com parse estrito. Garante que nenhum `number` toque em dinheiro.
2. **`src/domain/wallet/wallet.ts`** e **`wallet-ledger-entry.ts`**: `debit`/`credit` devolvem o lançamento daquela mudança; o lançamento é imutável e confere a própria aritmética.
3. **`src/domain/wagering/wager-transaction.ts`**: a máquina de estados e as regras de referência (`checkReference`, `ledgerDirectionFor`).
4. **`src/application/use-cases/submit-wager-transaction.ts`**: o fluxo inteiro dentro de uma transação SQL (inbox → idempotência → lock da wallet → nova checagem → decisão).
5. **`src/application/wager-decision.ts`**: as regras de negócio da seção 7, num único lugar.
6. **`src/infrastructure/persistence/migrations/…initial_schema.ts`**: as invariantes **no banco** (CHECKs, índices únicos, triggers append-only, ledger encadeado, triggers adiadas que amarram saldo a ledger).
7. **`src/interface/sqs/wager-consumer.ts`** e **`src/infrastructure/sqs/outbox-publisher.ts`**: entrada e saída assíncronas.
8. **`test/concurrency/multi-instance.test.ts`**: a prova de que tudo isso se sustenta com 3 processos, crash e restart.

## Estrutura de pastas

```
src/
  domain/            regras puras: Money, Wallet, WagerTransaction, Ledger, Inbox/Outbox, eventos (sem Nest, sem ORM)
  application/       casos de uso, portas (UnitOfWork, repositórios, métricas, relógio), hash de payload
  infrastructure/    MikroORM (schemas, migrations, repositórios), SQS (gateway, relay da outbox), logs, métricas, workers
  interface/         adaptadores de entrada: HTTP (controllers, filtro de erros, auth OIDC) e SQS (consumidor), contratos zod
  app.module.ts      composição (Nest) · bootstrap.ts · main.ts
scripts/             migrate, sqs:setup, load-test
docker/              init do Postgres (banco de testes) e realm do Keycloak
test/
  unit/              domínio e regras (fake em memória)
  integration/       PostgreSQL + SQS reais
  concurrency/       3 processos reais, crash, restart
  support/           harness, instâncias, helpers de banco e auditoria do ledger
```
