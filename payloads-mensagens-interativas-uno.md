# Payloads de mensagens interativas para Uno

Arquivo para validar os formatos de envio de mensagens interativas contra o branch `addbuttonsupport`.

Estrutura base esperada nos exemplos:

```json
{
  "jid": "5511999999999@s.whatsapp.net",
  "message": {}
}
```

## 1. Botoes legados

```json
{
  "jid": "5511999999999@s.whatsapp.net",
  "message": {
    "text": "Escolha uma opcao:",
    "footer": "Viper",
    "buttons": [
      {
        "buttonId": "opcao_1",
        "buttonText": { "displayText": "Opcao 1" },
        "type": 1
      },
      {
        "buttonId": "opcao_2",
        "buttonText": { "displayText": "Opcao 2" },
        "type": 1
      }
    ]
  }
}
```

## 2. Lista legacy

No Baileys deste branch, `sections` sem `listType` vira `PRODUCT_LIST` por padrao para gerar o node `biz > list type="product_list"`.

```json
{
  "jid": "5511999999999@s.whatsapp.net",
  "message": {
    "text": "Escolha um item da lista:",
    "title": "Menu principal",
    "buttonText": "Ver opcoes",
    "footer": "Viper",
    "sections": [
      {
        "title": "Categoria 1",
        "rows": [
          {
            "rowId": "item_1",
            "title": "Item 1",
            "description": "Descricao do item 1"
          },
          {
            "rowId": "item_2",
            "title": "Item 2",
            "description": "Descricao do item 2"
          }
        ]
      }
    ]
  }
}
```

## 3. Lista legacy com override SINGLE_SELECT

`listType: 1` = `SINGLE_SELECT`; `listType: 2` = `PRODUCT_LIST`.

```json
{
  "jid": "5511999999999@s.whatsapp.net",
  "message": {
    "text": "Escolha um item:",
    "title": "Menu",
    "buttonText": "Abrir lista",
    "footer": "Viper",
    "listType": 1,
    "sections": [
      {
        "title": "Opcoes",
        "rows": [
          {
            "rowId": "single_1",
            "title": "Single 1",
            "description": "Teste SINGLE_SELECT"
          }
        ]
      }
    ]
  }
}
```

## 4. Native Flow list

O send path converte `nativeFlowMessage` com botao `single_select` para `listMessage` direto antes do envio.

```json
{
  "jid": "5511999999999@s.whatsapp.net",
  "message": {
    "viewOnce": true,
    "interactiveMessage": {
      "body": { "text": "Escolha uma opcao:" },
      "footer": { "text": "Viper" },
      "header": {
        "title": "Menu",
        "hasMediaAttachment": false
      },
      "nativeFlowMessage": {
        "buttons": [
          {
            "name": "single_select",
            "buttonParamsJson": "{\"title\":\"Abrir lista\",\"sections\":[{\"title\":\"Categoria\",\"rows\":[{\"id\":\"nf_1\",\"title\":\"Native 1\",\"description\":\"Linha native flow 1\"},{\"id\":\"nf_2\",\"title\":\"Native 2\",\"description\":\"Linha native flow 2\"}]}]}"
          }
        ]
      }
    }
  }
}
```

## 5. Native Flow CTA URL

```json
{
  "jid": "5511999999999@s.whatsapp.net",
  "message": {
    "viewOnce": true,
    "interactiveMessage": {
      "body": { "text": "Abrir link externo" },
      "footer": { "text": "Viper" },
      "header": {
        "title": "CTA",
        "hasMediaAttachment": false
      },
      "nativeFlowMessage": {
        "buttons": [
          {
            "name": "cta_url",
            "buttonParamsJson": "{\"display_text\":\"Abrir site\",\"url\":\"https://example.com\",\"merchant_url\":\"https://example.com\"}"
          }
        ]
      }
    }
  }
}
```

## 6. Native Flow quick reply

```json
{
  "jid": "5511999999999@s.whatsapp.net",
  "message": {
    "viewOnce": true,
    "interactiveMessage": {
      "body": { "text": "Confirmar acao?" },
      "footer": { "text": "Viper" },
      "header": {
        "title": "Confirmacao",
        "hasMediaAttachment": false
      },
      "nativeFlowMessage": {
        "buttons": [
          {
            "name": "quick_reply",
            "buttonParamsJson": "{\"display_text\":\"Confirmar\",\"id\":\"confirmar_1\"}"
          }
        ]
      }
    }
  }
}
```

## 7. Native carousel alto nivel

Formato novo neste branch. Carousel com imagem tem mais chance de renderizar no WhatsApp Web.

```json
{
  "jid": "5511999999999@s.whatsapp.net",
  "message": {
    "text": "Produtos em destaque",
    "nativeCarousel": {
      "title": "Catalogo",
      "text": "Arraste para ver os produtos",
      "footer": "Viper",
      "cards": [
        {
          "title": "Produto 1",
          "body": "Descricao do produto 1",
          "footer": "R$ 99,90",
          "image": {
            "url": "https://example.com/produto-1.jpg"
          },
          "buttons": [
            {
              "type": "url",
              "text": "Abrir",
              "url": "https://example.com/produto-1"
            }
          ]
        },
        {
          "title": "Produto 2",
          "body": "Descricao do produto 2",
          "footer": "R$ 149,90",
          "image": {
            "url": "https://example.com/produto-2.jpg"
          },
          "buttons": [
            {
              "type": "reply",
              "text": "Escolher",
              "id": "produto_2"
            }
          ]
        }
      ]
    }
  }
}
```

## 8. Native carousel sem imagem

Pode ser usado para teste negativo. A chance de nao renderizar no Web e maior.

```json
{
  "jid": "5511999999999@s.whatsapp.net",
  "message": {
    "text": "Carousel sem midia",
    "nativeCarousel": {
      "cards": [
        {
          "title": "Card 1",
          "body": "Texto do card 1",
          "buttons": [
            {
              "type": "reply",
              "text": "Card 1",
              "id": "card_1"
            }
          ]
        },
        {
          "title": "Card 2",
          "body": "Texto do card 2",
          "buttons": [
            {
              "type": "reply",
              "text": "Card 2",
              "id": "card_2"
            }
          ]
        }
      ]
    }
  }
}
```

## 9. Carousel raw interactive

Formato baixo nivel, caso a Uno ja gere `interactiveMessage` direto.

```json
{
  "jid": "5511999999999@s.whatsapp.net",
  "message": {
    "interactiveMessage": {
      "header": {
        "title": "Catalogo",
        "hasMediaAttachment": false
      },
      "body": {
        "text": "Produtos em destaque"
      },
      "footer": {
        "text": "Viper"
      },
      "carouselMessage": {
        "messageVersion": 1,
        "cards": [
          {
            "header": {
              "title": "Card 1",
              "subtitle": "R$ 99,90",
              "hasMediaAttachment": false
            },
            "body": {
              "text": "Descricao do card 1"
            },
            "footer": {
              "text": "Rodape 1"
            },
            "nativeFlowMessage": {
              "buttons": [
                {
                  "name": "quick_reply",
                  "buttonParamsJson": "{\"display_text\":\"Escolher\",\"id\":\"card_1\"}"
                }
              ]
            }
          },
          {
            "header": {
              "title": "Card 2",
              "subtitle": "R$ 149,90",
              "hasMediaAttachment": false
            },
            "body": {
              "text": "Descricao do card 2"
            },
            "footer": {
              "text": "Rodape 2"
            },
            "nativeFlowMessage": {
              "buttons": [
                {
                  "name": "cta_url",
                  "buttonParamsJson": "{\"display_text\":\"Abrir\",\"url\":\"https://example.com\",\"merchant_url\":\"https://example.com\"}"
                }
              ]
            }
          }
        ]
      }
    }
  }
}
```

## 10. Resposta de botao

```json
{
  "jid": "5511999999999@s.whatsapp.net",
  "message": {
    "type": "plain",
    "buttonReply": {
      "displayText": "Opcao 1",
      "id": "opcao_1",
      "index": 0
    }
  }
}
```

## 11. Resposta de template button

```json
{
  "jid": "5511999999999@s.whatsapp.net",
  "message": {
    "type": "template",
    "buttonReply": {
      "displayText": "Confirmar",
      "id": "confirmar_1",
      "index": 0
    }
  }
}
```

## 12. Resposta de lista

```json
{
  "jid": "5511999999999@s.whatsapp.net",
  "message": {
    "listReply": {
      "title": "Item 1",
      "description": "Descricao do item 1",
      "singleSelectReply": {
        "selectedRowId": "item_1"
      },
      "listType": 1
    }
  }
}
```

## Pontos para validacao

- Lista comum: testar `sections` sem `listType`; este branch deve enviar como `PRODUCT_LIST`.
- Native Flow list: testar `interactiveMessage.nativeFlowMessage.buttons[0].name = "single_select"`; o send path deve converter para `listMessage`.
- Carousel: testar primeiro o payload `nativeCarousel` com imagem.
- Carousel sem imagem deve ser tratado como teste negativo ou compatibilidade limitada.
- O resultado final precisa ser confirmado em dispositivo real, porque renderizacao de interativos depende do WhatsApp Web/servidor.

# Recebimento e decodificacao

No Baileys, o evento recebido normalmente chega como `messages.upsert` com `messages[].message`.

Para decodificar corretamente:

1. Normalizar wrappers antes de ler o tipo real:
   - `ephemeralMessage.message`
   - `viewOnceMessage.message`
   - `viewOnceMessageV2.message`
   - `viewOnceMessageV2Extension.message`
   - `documentWithCaptionMessage.message`
   - `editedMessage.message`
   - `associatedChildMessage.message`
2. Depois da normalizacao, procurar estes campos:
   - `buttonsResponseMessage`
   - `listResponseMessage`
   - `interactiveResponseMessage.nativeFlowResponseMessage`
   - `interactiveMessage`
   - `listMessage`
   - `buttonsMessage`
3. Este branch ja normaliza `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson` para:
   - `listResponseMessage`, quando for `single_select`/lista
   - `buttonsResponseMessage`, quando for `quick_reply`/botao

## 13. Recebido: resposta de botao legado

```json
{
  "messages": [
    {
      "key": {
        "remoteJid": "5511999999999@s.whatsapp.net",
        "fromMe": false,
        "id": "MSG_ID"
      },
      "message": {
        "buttonsResponseMessage": {
          "selectedButtonId": "opcao_1",
          "selectedDisplayText": "Opcao 1",
          "type": 1
        }
      },
      "messageTimestamp": 1710000000,
      "pushName": "Cliente"
    }
  ],
  "type": "notify"
}
```

Contrato para Uno:

```json
{
  "interactive": {
    "kind": "button_reply",
    "id": "opcao_1",
    "title": "Opcao 1",
    "description": null
  }
}
```

## 14. Recebido: resposta de lista legacy

```json
{
  "messages": [
    {
      "key": {
        "remoteJid": "5511999999999@s.whatsapp.net",
        "fromMe": false,
        "id": "MSG_ID"
      },
      "message": {
        "listResponseMessage": {
          "title": "Item 1",
          "description": "Descricao do item 1",
          "singleSelectReply": {
            "selectedRowId": "item_1"
          },
          "listType": 1
        }
      },
      "messageTimestamp": 1710000000,
      "pushName": "Cliente"
    }
  ],
  "type": "notify"
}
```

Contrato para Uno:

```json
{
  "interactive": {
    "kind": "list_reply",
    "id": "item_1",
    "title": "Item 1",
    "description": "Descricao do item 1"
  }
}
```

## 15. Recebido: native flow quick reply

Entrada bruta possivel:

```json
{
  "messages": [
    {
      "key": {
        "remoteJid": "5511999999999@s.whatsapp.net",
        "fromMe": false,
        "id": "MSG_ID"
      },
      "message": {
        "interactiveResponseMessage": {
          "body": {
            "text": "Confirmar"
          },
          "nativeFlowResponseMessage": {
            "name": "quick_reply",
            "paramsJson": "{\"id\":\"confirmar_1\",\"display_text\":\"Confirmar\"}",
            "version": 3
          }
        }
      },
      "messageTimestamp": 1710000000,
      "pushName": "Cliente"
    }
  ],
  "type": "notify"
}
```

Depois de `normalizeMessageContent`, este branch tambem preenche:

```json
{
  "buttonsResponseMessage": {
    "selectedButtonId": "confirmar_1",
    "selectedDisplayText": "Confirmar",
    "type": 1
  }
}
```

Contrato para Uno:

```json
{
  "interactive": {
    "kind": "button_reply",
    "id": "confirmar_1",
    "title": "Confirmar",
    "description": null,
    "source": "interactiveResponseMessage"
  }
}
```

## 16. Recebido: native flow single_select/lista

Entrada bruta possivel:

```json
{
  "messages": [
    {
      "key": {
        "remoteJid": "5511999999999@s.whatsapp.net",
        "fromMe": false,
        "id": "MSG_ID"
      },
      "message": {
        "interactiveResponseMessage": {
          "body": {
            "text": "Native 1"
          },
          "nativeFlowResponseMessage": {
            "name": "single_select",
            "paramsJson": "{\"selected_row_id\":\"nf_1\",\"title\":\"Native 1\",\"description\":\"Linha native flow 1\"}",
            "version": 3
          }
        }
      },
      "messageTimestamp": 1710000000,
      "pushName": "Cliente"
    }
  ],
  "type": "notify"
}
```

Depois de `normalizeMessageContent`, este branch tambem preenche:

```json
{
  "listResponseMessage": {
    "listType": 1,
    "singleSelectReply": {
      "selectedRowId": "nf_1"
    },
    "title": "Native 1",
    "description": "Linha native flow 1"
  }
}
```

Contrato para Uno:

```json
{
  "interactive": {
    "kind": "list_reply",
    "id": "nf_1",
    "title": "Native 1",
    "description": "Linha native flow 1",
    "source": "interactiveResponseMessage"
  }
}
```

## 17. Recebido: native flow com params alternativos

O normalizador aceita estes aliases dentro de `paramsJson`:

- ID: `id`, `button_id`, `selected_row_id`, `row_id`, `selection_id`, `list_reply_id`
- Titulo: `title`, `display_text`, `text`
- Descricao: `description`

Exemplo:

```json
{
  "interactiveResponseMessage": {
    "nativeFlowResponseMessage": {
      "name": "single_select",
      "paramsJson": "{\"row_id\":\"linha_123\",\"display_text\":\"Linha 123\",\"description\":\"Descricao 123\"}"
    }
  }
}
```

Contrato para Uno:

```json
{
  "interactive": {
    "kind": "list_reply",
    "id": "linha_123",
    "title": "Linha 123",
    "description": "Descricao 123"
  }
}
```

## 18. Recebido: mensagem de lista enviada por outra pessoa

Quando alguem envia uma lista, nao e resposta; e o conteudo da mensagem interativa em si.

```json
{
  "messages": [
    {
      "key": {
        "remoteJid": "5511999999999@s.whatsapp.net",
        "fromMe": false,
        "id": "MSG_ID"
      },
      "message": {
        "listMessage": {
          "title": "Menu principal",
          "description": "Escolha um item",
          "buttonText": "Ver opcoes",
          "listType": 2,
          "sections": [
            {
              "title": "Categoria",
              "rows": [
                {
                  "rowId": "item_1",
                  "title": "Item 1",
                  "description": "Descricao do item 1"
                }
              ]
            }
          ]
        }
      }
    }
  ],
  "type": "notify"
}
```

Contrato para Uno:

```json
{
  "interactive": {
    "kind": "list_message",
    "title": "Menu principal",
    "body": "Escolha um item",
    "buttonText": "Ver opcoes",
    "sections": [
      {
        "title": "Categoria",
        "rows": [
          {
            "id": "item_1",
            "title": "Item 1",
            "description": "Descricao do item 1"
          }
        ]
      }
    ]
  }
}
```

## 19. Recebido: carousel enviado por outra pessoa

Quando alguem envia carousel, procurar `interactiveMessage.carouselMessage`.

```json
{
  "messages": [
    {
      "key": {
        "remoteJid": "5511999999999@s.whatsapp.net",
        "fromMe": false,
        "id": "MSG_ID"
      },
      "message": {
        "interactiveMessage": {
          "header": {
            "title": "Catalogo",
            "hasMediaAttachment": false
          },
          "body": {
            "text": "Produtos em destaque"
          },
          "footer": {
            "text": "Viper"
          },
          "carouselMessage": {
            "messageVersion": 1,
            "cards": [
              {
                "header": {
                  "title": "Produto 1",
                  "subtitle": "R$ 99,90",
                  "hasMediaAttachment": true,
                  "imageMessage": {
                    "url": "https://mmg.whatsapp.net/...",
                    "mimetype": "image/jpeg"
                  }
                },
                "body": {
                  "text": "Descricao do produto 1"
                },
                "footer": {
                  "text": "Rodape"
                },
                "nativeFlowMessage": {
                  "buttons": [
                    {
                      "name": "cta_url",
                      "buttonParamsJson": "{\"display_text\":\"Abrir\",\"url\":\"https://example.com\",\"merchant_url\":\"https://example.com\"}"
                    }
                  ]
                }
              }
            ]
          }
        }
      }
    }
  ],
  "type": "notify"
}
```

Contrato para Uno:

```json
{
  "interactive": {
    "kind": "carousel_message",
    "title": "Catalogo",
    "body": "Produtos em destaque",
    "footer": "Viper",
    "cards": [
      {
        "title": "Produto 1",
        "subtitle": "R$ 99,90",
        "body": "Descricao do produto 1",
        "footer": "Rodape",
        "buttons": [
          {
            "type": "cta_url",
            "text": "Abrir",
            "url": "https://example.com"
          }
        ]
      }
    ]
  }
}
```

## 20. Recebido com wrapper viewOnce/documentWithCaption

Interativos podem vir dentro de wrappers. A Uno deve desembrulhar antes de decidir o tipo.

```json
{
  "messages": [
    {
      "key": {
        "remoteJid": "5511999999999@s.whatsapp.net",
        "fromMe": false,
        "id": "MSG_ID"
      },
      "message": {
        "viewOnceMessage": {
          "message": {
            "interactiveMessage": {
              "body": {
                "text": "Clique no botao"
              },
              "nativeFlowMessage": {
                "buttons": [
                  {
                    "name": "quick_reply",
                    "buttonParamsJson": "{\"display_text\":\"OK\",\"id\":\"ok_1\"}"
                  }
                ]
              }
            }
          }
        }
      }
    }
  ],
  "type": "notify"
}
```

Depois de desembrulhar:

```json
{
  "interactiveMessage": {
    "body": {
      "text": "Clique no botao"
    },
    "nativeFlowMessage": {
      "buttons": [
        {
          "name": "quick_reply",
          "buttonParamsJson": "{\"display_text\":\"OK\",\"id\":\"ok_1\"}"
        }
      ]
    }
  }
}
```

## Ordem sugerida de decodificacao na Uno

Pseudo-regra:

```txt
content = unwrap(message)

if content.buttonsResponseMessage:
  kind = button_reply
  id = selectedButtonId
  title = selectedDisplayText

else if content.listResponseMessage:
  kind = list_reply
  id = singleSelectReply.selectedRowId
  title = title
  description = description

else if content.interactiveResponseMessage.nativeFlowResponseMessage:
  params = JSON.parse(paramsJson)
  id = params.id || params.button_id || params.selected_row_id || params.row_id || params.selection_id || params.list_reply_id
  title = params.title || params.display_text || params.text
  description = params.description
  kind = name contains single_select/list or params has row id ? list_reply : button_reply

else if content.interactiveMessage.carouselMessage:
  kind = carousel_message
  parse cards, card headers, bodies, footers and nativeFlow buttons

else if content.listMessage:
  kind = list_message
  parse sections and rows

else if content.buttonsMessage:
  kind = buttons_message
  parse buttons
```

# Nota futura: view-once indisponivel

Contexto observado:

- O PR WhiskeySockets/Baileys #2435 ja esta aplicado neste branch.
- Quando o WhatsApp entrega o stanza real `enc` com a midia, o codigo consegue decodificar `viewOnceMessage.message.imageMessage/videoMessage/audioMessage` e marca `key.isViewOnce = true`.
- Quando o WhatsApp entrega apenas o placeholder `<unavailable type="view_once" />` ou fanout equivalente, nao existe `mediaKey`, `directPath`, `url` ou payload criptografado para baixar/decriptar.

Texto atual gerado pelo proprio Baileys deste branch:

```txt
Mensagem de visualizacao unica indisponivel aqui, confira no aparelho.
```

Esse texto nao e a midia real. Ele vem do fallback em `src/Socket/messages-recv.ts` quando o stub contem:

```json
{
  "messageStubParameters": ["view_once_unavailable"]
}
```

## Limite tecnico

Nao ha como decodificar a midia se o servidor nao entregou o conteudo real. Para funcionar de verdade, uma destas condicoes precisa acontecer:

1. O WhatsApp entrega um stanza `enc` com a midia real.
2. O aparelho principal responde um `placeholder resend` com o conteudo real.

Se nenhum dos dois acontecer, o melhor comportamento para integracao e emitir um evento estruturado, nao uma mensagem de texto comum.

## Plano experimental para retomar

Objetivo: trocar o fallback textual por um fluxo estruturado e, opcionalmente, tentar recuperar a midia.

Proposta:

1. Adicionar config para controlar o comportamento:

```ts
emitViewOnceUnavailableEvent?: boolean
attemptViewOncePlaceholderResend?: boolean
sendViewOnceUnavailableText?: boolean
```

2. Quando receber `view_once_unavailable`, emitir evento/atualizacao estruturada:

```json
{
  "type": "view_once_unavailable",
  "key": {
    "id": "MSG_ID",
    "remoteJid": "5511999999999@s.whatsapp.net",
    "fromMe": true
  },
  "reason": "server_delivered_unavailable_placeholder",
  "canRetryPlaceholderResend": true
}
```

3. Testar tentativa de `requestPlaceholderResend` mesmo em cenarios hoje pulados, especialmente:

```txt
view_once_unavailable_fanout
```

4. Logar sinais decisivos:

```txt
requested placeholder resend for unavailable message
skipping placeholder resend for excluded unavailable type
failed to request placeholder resend for unavailable message
```

5. Se o aparelho responder com conteudo real, publicar a midia view-once normalmente com:

```json
{
  "key": {
    "isViewOnce": true
  },
  "message": {
    "viewOnceMessage": {
      "message": {
        "imageMessage": {}
      }
    }
  }
}
```

6. Se nao responder, publicar apenas o evento estruturado `view_once_unavailable`.

## Cuidado

Nao tratar a frase atual como mensagem normal de usuario. Ela e fallback local, nao conteudo enviado pelo contato.

Tambem nao assumir que retry sempre funcionara. View-once depende do servidor/aparelho principal e pode variar entre:

- conta normal
- WhatsApp Business
- dispositivo companion
- grupo
- conversa 1:1
