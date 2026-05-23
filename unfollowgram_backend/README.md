# UnfollowGram Backend (EvoPay)

Servidor HTTP simples para integrar o `unfollowgram_v9.html` com a EvoPay sem expor token no frontend.

## Rotas

- `POST /api/checkout`: cria checkout na EvoPay por plano (`starter`, `pro`, `vip`)
- `GET /api/checkout/claim`: valida link de retorno do checkout e libera a key quando aprovado
- `GET /api/getkey/direct?plan=starter|pro|vip`: gera key direta por plano para links de produto
- `POST /api/payment/confirm`: confirma pagamento e gera codigo quando aprovado
- `POST /api/webhook/evopay`: recebe webhook da EvoPay e gera codigo quando aprovado
- `GET /`: serve `../unfollowgram_v9.html`

## Configuracao

1. Copie `.env.example` para `.env`
2. Preencha:
   - `EVOPAY_API_KEY` (token privado da EvoPay)
   - `EVOPAY_CHECKOUT_PATH` e `EVOPAY_PAYMENT_PATH` conforme documentacao da sua conta
   - Opcional: use `EVOPAY_CHECKOUT_URL` e `EVOPAY_PAYMENT_URL_TEMPLATE` para informar URL completa do endpoint

## Executar

```powershell
cd C:\Users\cipelli\Desktop\unfollowgram_backend
node .\server.js
```

Abra: `http://127.0.0.1:3000`

## Seguranca

- O token da EvoPay fica so no backend (`EVOPAY_API_KEY`).
- Nenhuma variavel sensivel e enviada para o frontend.
- Nao use `NEXT_PUBLIC_` para token da EvoPay.
- Rotacione o token periodicamente (recomendado: a cada 90 dias) e revogue em caso de suspeita de vazamento.
