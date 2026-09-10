# TechLar — Mock da API de Logística (US 04)

Servidor HTTP **sem dependências** (Node puro) que simula a API de rastreio da Sprint 3.
Implementa o contrato consumido pelo Salesforce e traz endpoints de controle para os
cenários da banca (derrubar, restabelecer e simular lentidão).

## Requisitos

- Node.js >= 18 (testado no v24).

## Como rodar

```bash
cd techlar-logistica-mock
npm start          # ou: node server.js
# porta customizada:
PORT=4000 node server.js
```

Vai subir em `http://localhost:3000`.

## Contrato (o que o Salesforce consome)

`GET /tracking/:trackingCode`

Sucesso (HTTP 200):

```json
{
  "trackingCode": "BR123456789",
  "status": "Em trânsito",
  "updatedAt": "2026-07-04T21:17:13.498Z",
  "carrier": "Total Express",
  "eta": "2026-07-11"
}
```

Indisponível (HTTP 503), quando a API está "derrubada":

```json
{ "error": "Serviço temporariamente indisponível." }
```

> Os dados são **determinísticos por código**: o mesmo `trackingCode` sempre retorna o mesmo
> status/carrier/eta, o que deixa a demo previsível.

## Controle da demo (não faz parte do contrato)

| Ação | Comando |
| --- | --- |
| Derrubar a API (passa a dar 503) | `curl -X POST http://localhost:3000/admin/down` |
| Restabelecer a API | `curl -X POST http://localhost:3000/admin/up` |
| Simular lentidão (testa o timeout de 10s) | `curl -X POST "http://localhost:3000/admin/delay?ms=12000"` |
| Ver estado atual | `curl http://localhost:3000/admin/status` |

Roteiro dos 3 cenários obrigatórios:

1. **Sucesso** — API no ar → `GET /tracking/BR123` retorna 200.
2. **Falha** — `POST /admin/down` → o Salesforce mostra a mensagem amigável e grava o log.
3. **Retentativa** — `POST /admin/up` → clicar "Atualizar Status" volta a trazer 200.
4. **Timeout (bônus)** — `POST /admin/delay?ms=12000` → o callout de 10s estoura e cai no fallback.

## Mock de ERP (Estoque) — projeto Agentforce

O **mesmo servidor** também simula um ERP de estoque terceirizado. Os SKUs **refletem os produtos
reais do site** (fonte: `techlar-ecommerce` → `server/src/db/products.js`, que espelha o Price Book
da org), então a demo do Agentforce fica coerente com o catálogo. O **estoque é mutável em memória**:
uma compra baixa o saldo, e o mock é a **fonte da verdade** do inventário para o site e para a org.

### Contrato

`GET /estoque/:sku`

Sucesso (HTTP 200):

```json
{
  "sku": "GSGH2J23213",
  "nome": "iPhone 17",
  "precoUnitario": 8608.0,
  "moeda": "BRL",
  "quantidadeDisponivel": 5,
  "disponivel": true,
  "updatedAt": "2026-09-10T12:00:00.000Z"
}
```

Indisponível (HTTP 503), quando o ERP está "derrubado":

```json
{ "error": "ERP temporariamente indisponível." }
```

`POST /estoque/baixa` — baixa o estoque numa compra. Corpo:

```json
{ "itens": [{ "sku": "GSGH2J23213", "qtd": 2 }] }
```

- **200** `{ ok: true, itens: [{ sku, quantidadeDisponivel }] }` quando há saldo.
- **409** `{ error, faltantes: [{ sku, solicitado, disponivel }] }` se faltar — e **nada** é baixado
  (operação atômica: ou baixa todos os itens, ou nenhum).

`POST /estoque/entrada` — repõe/estorna estoque (mesmo formato do body). Útil para restock manual ou
para compensar uma baixa durante a demo.

### Estoque inicial (seed da demo)

| SKU | Produto | preço (BRL) | estoque |
| --- | --- | --- | --- |
| `GSGH2J23213` | iPhone 17 | 8608.00 | 5 |
| `GSGH2J232111` | iPhone 17 Pro Max | 18902.00 | 3 |
| `MacBookM4Air` | MacBook Air M4 | 10000.00 | 4 |
| `GSGH2J232xxsssssss` | MacBook Air M5 | 18902.00 | 2 |
| `IMP-3D-PREMIUM` | Impressora 3D Premium | 5500.00 | 6 |
| `IMP-3D-PLUS` | Impressora 3D Plus Premium | 7865.00 | 4 |
| `CABO-USB` | Cabo USB | 20.00 | 50 |

### Controle da demo do ERP (não faz parte do contrato)

| Ação | Comando |
| --- | --- |
| Ver estado + estoque atual | `curl http://localhost:3000/admin/erp/status` |
| Derrubar o ERP (passa a dar 503) | `curl -X POST http://localhost:3000/admin/erp/down` |
| Restabelecer o ERP | `curl -X POST http://localhost:3000/admin/erp/up` |
| Simular lentidão (testa timeout) | `curl -X POST "http://localhost:3000/admin/erp/delay?ms=12000"` |
| Resetar o estoque para o seed | `curl -X POST http://localhost:3000/admin/erp/reset` |

Roteiro de demonstração ao vivo:

1. **Consulta** — `GET /estoque/GSGH2J23213` → 200 com `quantidadeDisponivel`.
2. **Compra baixa o estoque** — uma compra (site/org) chama `POST /estoque/baixa` → o saldo cai.
3. **Sem estoque** — repita a baixa até zerar → `409` e a venda é bloqueada com mensagem amigável.
4. **Repetir** — `POST /admin/erp/reset` volta ao seed para rodar a demo de novo.

> O ERP tem estado **independente** da logística: `POST /admin/erp/down` não afeta `/tracking`, e
> `POST /admin/down` não afeta `/estoque`.

Na org, o consumo segue o mesmo padrão da logística: um Named Credential (ex.: `ErpAPI`) apontando
para a URL pública do túnel + uma classe Service em Apex montando `callout:ErpAPI/estoque/<sku>`.

## Expor para o Salesforce (importante)

A org **não enxerga `localhost`**. Para o callout funcionar, o Salesforce precisa de uma URL
HTTPS pública. Escolha conforme o seu momento:

**Recomendado para desenvolver o Apex (URL estável, sem cold start) — ngrok com domínio fixo**

O plano free do ngrok dá 1 domínio estático. Assim a URL não muda a cada restart e você não
precisa reconfigurar o Named Credential toda hora.

```bash
# uma vez: crie a conta e rode `ngrok config add-authtoken <seu-token>`
ngrok http --domain=SEU-NOME.ngrok-free.app 3000
```

**Rápido e sem cadastro (URL muda a cada execução) — Cloudflare Tunnel**

```bash
cloudflared tunnel --url http://localhost:3000
# copie a URL https://xxxx.trycloudflare.com que aparece
```

> **Atenção com "deploy free" (Render/Heroku free etc.):** esses planos dormem por inatividade e
> o primeiro request demora ~30s para acordar — isso **estoura o timeout de 10s** do callout e
> quebra o cenário de sucesso na banca. Para demo, prefira servidor local + túnel (sem cold start).

> Dica de banca: mantenha o servidor e o túnel abertos o tempo todo e faça o "derrubar/subir"
> pelos endpoints `/admin/down` e `/admin/up` — assim você não mata o processo nem troca a URL.

### Depois de ter a URL pública

1. Teste-a direto no navegador/Postman: `https://SUA-URL/tracking/BR123` deve voltar 200.
2. Use essa URL como base no Named Credential `LogisticaAPI` (ver seção abaixo).
3. No Apex, o endpoint fica `callout:LogisticaAPI/tracking/<codigo>` — a URL nunca aparece no código.

## Configuração do Named Credential (US 04)

1. Setup → Named Credentials → **New Legacy** ou o modelo novo (External Credential + Named Credential).
2. Nome: `LogisticaAPI`.
3. URL: a URL pública do túnel (ex.: `https://xxxx.ngrok-free.app`).
4. Autenticação: **No Authentication** (a mock é aberta).
5. No Apex, montar o endpoint como `callout:LogisticaAPI/tracking/` + o código — sem URL hard-coded.

## Alternativa sem rodar nada local

Se preferir um serviço hospedado, dá para reproduzir o mesmo contrato no
[Beeceptor](https://beeceptor.com) ou [MockAPI](https://mockapi.io): crie a rota
`/tracking/:code` com a resposta 200 acima e uma regra para responder 503 quando quiser
demonstrar a falha. O servidor local, porém, dá controle mais fino (down/up/delay por endpoint).
