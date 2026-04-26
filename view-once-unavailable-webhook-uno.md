# Contrato Uno: view-once unavailable

Este documento define como a Uno deve tratar mensagens de visualizacao unica que chegam ao Baileys apenas como indisponiveis.

## Regra principal

Quando o Baileys receber `view_once_unavailable`, a Uno deve **enviar somente webhook para as aplicacoes integradas** informando que a midia nao esta disponivel.

A Uno **nao deve enviar mensagem de texto de volta para o contato no WhatsApp**.

## Por que isso existe

Em alguns cenarios, principalmente em dispositivo companion, historico/importacao ou fanout de visualizacao unica, o WhatsApp nao entrega a midia real para o Baileys.

Em vez da midia, o servidor entrega apenas um placeholder/stub, por exemplo:

```xml
<unavailable type="view_once" />
```

ou um fanout indisponivel equivalente.

Nesse caso nao existem dados suficientes para baixar ou descriptografar a midia:

- nao vem `mediaKey`
- nao vem `url`
- nao vem `directPath`
- nao vem payload criptografado de midia

Portanto, a Uno nao deve tentar tratar isso como imagem/video/audio real.

## Como detectar

O Baileys emite a mensagem com:

```json
{
  "messageStubParameters": ["view_once_unavailable"]
}
```

Normalmente tambem vem:

```json
{
  "key": {
    "isViewOnce": true
  },
  "messageStubType": "FUTUREPROOF"
}
```

Regra recomendada:

```ts
const isViewOnceUnavailable =
  msg.key?.isViewOnce === true &&
  msg.messageStubParameters?.includes('view_once_unavailable')
```

Regra tolerante, caso `key.isViewOnce` nao venha em algum payload antigo:

```ts
const isViewOnceUnavailable =
  msg.messageStubParameters?.includes('view_once_unavailable')
```

## Webhook que a Uno deve enviar

Enviar um webhook tecnico para a aplicacao consumidora:

```json
{
  "event": "message",
  "message_type": "view_once_unavailable",
  "type": "view_once_unavailable",
  "is_view_once": true,
  "is_available": false,
  "content": null,
  "text": null,
  "media": null,
  "reason": "server_delivered_unavailable_placeholder",
  "key": {
    "id": "MSG_ID",
    "remoteJid": "5511999999999@s.whatsapp.net",
    "fromMe": true,
    "participant": null
  },
  "timestamp": 1710000000
}
```

Campos importantes:

- `message_type`: usar `view_once_unavailable`.
- `is_view_once`: `true`.
- `is_available`: `false`.
- `content`: `null`.
- `text`: `null`.
- `media`: `null`.
- `reason`: motivo tecnico da indisponibilidade.
- `key.id`: manter para rastreio/idempotencia.

## O que nao fazer

A Uno nao deve:

- enviar mensagem de texto para o contato no WhatsApp
- criar texto como se o contato tivesse enviado
- transformar em mensagem comum no chat
- tentar baixar midia sem `mediaKey`, `url` ou `directPath`
- tratar como falha de processamento da Uno
- gerar retry infinito

Texto que nao deve ser enviado ao contato:

```txt
Mensagem de visualizacao unica indisponivel aqui, confira no aparelho.
```

Esse texto era um fallback local antigo e foi removido do Baileys deste branch.

## Como exibir para a aplicacao/operador

A aplicacao consumidora pode mostrar algo como:

```txt
Midia de visualizacao unica indisponivel neste dispositivo.
```

Mas isso deve ser apenas UI interna da aplicacao, nunca uma mensagem enviada ao WhatsApp.

## Diferenca para view-once real

### View-once real disponivel

Quando a midia real vem do WhatsApp, o payload tera `viewOnceMessage` com `imageMessage`, `videoMessage` ou `audioMessage`.

Exemplo:

```json
{
  "key": {
    "id": "MSG_ID",
    "remoteJid": "5511999999999@s.whatsapp.net",
    "fromMe": false,
    "isViewOnce": true
  },
  "message": {
    "viewOnceMessage": {
      "message": {
        "imageMessage": {
          "url": "https://mmg.whatsapp.net/...",
          "mimetype": "image/jpeg",
          "mediaKey": "BASE64_OR_BUFFER",
          "directPath": "/v/t62..."
        }
      }
    }
  }
}
```

Neste caso a Uno pode tratar como midia view-once real.

### View-once indisponivel

Quando so existe stub:

```json
{
  "key": {
    "id": "MSG_ID",
    "remoteJid": "5511999999999@s.whatsapp.net",
    "fromMe": true,
    "isViewOnce": true
  },
  "messageStubType": "FUTUREPROOF",
  "messageStubParameters": ["view_once_unavailable"]
}
```

Neste caso a Uno deve enviar apenas o webhook tecnico de indisponibilidade.

## Importacao de historico

Durante importacao/sincronizacao de historico, podem chegar varios `view_once_unavailable` em sequencia.

Comportamento esperado:

- emitir webhook para cada evento, respeitando idempotencia por `key.id`
- nao enviar mensagens ao contato
- nao tentar recuperar midia automaticamente em loop
- nao poluir o chat com textos de fallback

## Idempotencia

Usar a chave da mensagem para evitar duplicidade:

```txt
remoteJid + id + participant
```

Exemplo:

```json
{
  "dedupe_key": "5511999999999@s.whatsapp.net:MSG_ID:"
}
```

## Logs recomendados na Uno

Ao detectar:

```txt
view_once_unavailable detected
```

Com campos:

```json
{
  "msgId": "MSG_ID",
  "remoteJid": "5511999999999@s.whatsapp.net",
  "fromMe": true,
  "hasMediaKey": false,
  "hasDirectPath": false,
  "reason": "server_delivered_unavailable_placeholder"
}
```

## Plano futuro opcional

Uma melhoria futura pode tentar `placeholder resend` para recuperar a midia pelo aparelho principal.

Mesmo assim, o comportamento padrao deve continuar seguro:

1. Detectar `view_once_unavailable`.
2. Emitir webhook tecnico.
3. Nao enviar texto ao contato.
4. Se uma tentativa futura recuperar midia real, emitir uma atualizacao ou novo webhook com a midia recuperada.
