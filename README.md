# A Ponte: agente A2A com MCP por dentro

Implementação do desafio do MBA de Engenharia de Software com IA. A solução tem dois processos independentes: o servidor MCP expõe o domínio de salas em Streamable HTTP, e o agente consome esse servidor por HTTP enquanto publica sua capacidade pelo binding JSON-RPC 2.0 do A2A v1.0.

Não há LLM, banco de dados, sessão de protocolo ou regra de negócio duplicada no agente. Reservas e Tasks vivem em memória; o estado necessário para retomar um MRTR viaja no `requestState` assinado.

## Como rodar

Pré-requisitos:

- Node.js 20 ou superior;
- npm;
- Python 3.10 ou superior, apenas para o validador.

A partir de um clone limpo, instale as versões travadas no `package-lock.json`:

```bash
npm ci
```

Em um primeiro terminal, gere uma chave de 32 bytes e suba o servidor MCP:

```bash
export REQUEST_STATE_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
npm run start:mcp
```

Guarde o mesmo valor de `REQUEST_STATE_SECRET` se for reiniciar o MCP durante um fluxo pausado. É a estabilidade dessa chave, e não memória do processo, que permite validar o `requestState` depois do restart.

Em um segundo terminal, suba o agente A2A:

```bash
npm run start:agente
```

Em um terceiro terminal, execute o validador com ambos os processos recém-iniciados:

```bash
python3 validador/validar.py --agente http://localhost:7300 --mcp http://localhost:7301
```

O Agent Card fica em `http://localhost:7300/.well-known/agent-card.json`, o endpoint A2A em `http://localhost:7300/a2a` e o endpoint MCP em `http://localhost:7301/mcp`.

As configurações opcionais são:

| Variável | Padrão | Uso |
| --- | --- | --- |
| `MCP_PORT` | `7301` | Porta do servidor MCP |
| `AGENT_PORT` | `7300` | Porta do agente A2A |
| `MCP_URL` | `http://127.0.0.1:7301/mcp` | Servidor MCP consumido pelo agente |
| `AGENT_PUBLIC_URL` | `http://127.0.0.1:7300` | URL publicada no Agent Card |
| `REQUEST_STATE_SECRET` | sem padrão | Chave obrigatória de integridade do `requestState` |

## Onde a ponte acontece

A ponte está em [`agente/index.js`](agente/index.js). `pauseTask` recebe o resultado MCP `input_required`, extrai a chave e o enum da elicitation, guarda o `requestState` opaco somente no registro interno da Task e publica `TASK_STATE_INPUT_REQUIRED` com a linha exata de alternativas. Quando chega outro `SendMessage` com `taskId`, `continueTask` recupera esse registro e faz um novo `tools/call`, com um novo id JSON-RPC, ecoando sem alteração o `requestState` e a mesma chave em `inputResponses`. O retorno completo vira `TASK_STATE_COMPLETED`; uma resposta `decline` vira `TASK_STATE_CANCELED`. A estrutura interna `bridge` nunca faz parte da Task serializada, portanto o `requestState` não vaza pela API A2A.

O agente executa `tools/list` antes do primeiro `tools/call`, lê `politica://uso` por `resources/read` e extrai a versão da primeira linha. Todos os requests MCP incluem a revisão, as capabilities por request, os headers espelhados e o `traceparent` da Task.

## Decisões técnicas

- O servidor usa `@modelcontextprotocol/server` v2 em ESM e cria uma instância MCP nova por request por meio de `createMcpHandler`, mantendo apenas as reservas do domínio em memória compartilhada pelo processo.
- O `requestState` é assinado com HMAC-SHA256 pelo `createRequestStateCodec` oficial. A chave vem exclusivamente de `REQUEST_STATE_SECRET`, precisa ter pelo menos 32 bytes e nunca possui fallback no código.
- A validade do estado é de 600 segundos (10 minutos), dentro da janela exigida de 5 a 30 minutos. O selo também é vinculado ao método e ao `Mcp-Name`, impedindo seu reaproveitamento em outra operação.
- O payload selado contém o pedido original e as alternativas. No retry, os argumentos do cliente são ignorados em favor do conteúdo verificado; assim, argumentos adulterados não produzem efeito.
- O estado público e o estado privado das Tasks ficam em um `Map` no processo do agente. Cada Task pausada possui seu próprio `requestState`, chave de elicitation, alternativas, pedido original e trace context.
- As reservas criadas ficam em memória e partem novamente de `dados/reservas.json` após restart, como permitido. O servidor não mantém estado de MRTR entre as pernas: um retry sobrevive ao restart desde que a mesma chave de ambiente seja reutilizada.
- O log MCP é escrito em `stderr` e registra método, id e `traceparent` de cada request. O agente usa ids crescentes, de modo que o retry sempre tem id diferente da chamada inicial.
- O Agent Card segue a forma v1.0, usando `supportedInterfaces`, `protocolBinding: JSONRPC` e `protocolVersion: 1.0`.

## Saída do validador

Execução feita com os dois processos recém-iniciados:

```text
trace-id desta execucao: b2b9c1924dd7ef060d5a380901940674
procure esse valor no stderr do servidor MCP para conferir a propagacao do traceparent.

PASS 01 tools/list traz as tres tools
PASS 02 toda tool tem inputSchema de objeto
PASS 03 listar_salas devolve structuredContent e o mesmo JSON em texto
PASS 04 _meta sem protocolVersion devolve -32602 e HTTP 400
PASS 05 _meta sem clientCapabilities devolve -32602 e HTTP 400
PASS 06 tool inexistente e recusada, por -32602 ou por isError
PASS 07 resources/read de politica://uso devolve a politica
PASS 08 resources/read de URI inexistente devolve -32602
PASS 09 sala inexistente devolve isError com a mensagem exata
PASS 10 fora da janela devolve isError com a mensagem exata
PASS 11 duracao acima de 2h devolve isError com a mensagem exata
PASS 12 intervalo invertido devolve isError com a mensagem exata
PASS 13 conflito devolve input_required com inputRequests e requestState
PASS 14 a elicitation e form mode e oferece as alternativas na ordem certa
PASS 15 conflito sem a capability elicitation devolve -32021 e HTTP 400
PASS 16 retry com inputResponses e requestState conclui a reserva
PASS 17 requestState adulterado e rejeitado com -32602
PASS 18 argumentos adulterados no retry nao tomam efeito
PASS 19 recusa conclui sem reservar e sem isError
PASS 20 conflito sem alternativa possivel devolve isError com a mensagem exata

PASS 21 agent card responde 200 no well-known com JSON
PASS 22 o card declara a interface JSON-RPC com url e versao 1.0
PASS 23 o card declara a skill reservar-sala
PASS 24 SendMessage com sala livre conclui a Task
PASS 25 o artifact chama reserva e traz a versao da politica
PASS 26 GetTask devolve id, contextId e estado corrente
PASS 27 SendMessage com sala ocupada pausa a Task
PASS 28 a Task pausada lista as alternativas na ordem certa
PASS 29 escolha fora do enum mantem a Task pausada
PASS 30 a continuacao conclui a Task na sala escolhida
PASS 31 SendMessage em Task terminal e recusado
PASS 32 a recusa termina a Task em CANCELED
PASS 33 duas Tasks pausadas ao mesmo tempo concluem cada uma com a sua reserva
PASS 34 nenhuma resposta A2A carrega o requestState
PASS 35 sala inexistente termina a Task em FAILED com a mensagem da tool
PASS 36 o agente e deterministico: o mesmo pedido produz a mesma pausa

resumo: 36 passaram, 0 falharam, de 36 verificacoes
```

Além das 36 verificações, foi testado manualmente o fluxo não automatizado pelo validador: um `requestState` foi emitido, o processo MCP foi encerrado e iniciado de novo com a mesma `REQUEST_STATE_SECRET`, e o retry concluiu com `complete`, reservando `sala-fusca`. O log também confirmou `tools/list` antes do primeiro `tools/call`, o trace-id `b2b9c1924dd7ef060d5a380901940674` propagado e ids distintos entre chamada inicial e retry.

## Estrutura

```text
.
├── agente/index.js         # servidor A2A e host/cliente MCP
├── servidor-mcp/index.js   # servidor MCP Streamable HTTP
├── dados/                  # dados originais, sem alterações
├── exemplos/               # exemplos originais, sem alterações
├── validador/              # validador original, sem alterações
├── package.json
└── package-lock.json
```
