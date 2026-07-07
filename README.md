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
{ "error": "Service Unavailable" }
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
