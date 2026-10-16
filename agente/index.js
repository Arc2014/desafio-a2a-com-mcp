import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const PROTOCOL_VERSION = "2026-07-28";
const PORT = Number(process.env.AGENT_PORT ?? 7300);
const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:7301/mcp";
const AGENT_PUBLIC_URL = (process.env.AGENT_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const TERMINAL_STATES = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_FAILED",
]);

const taskRecords = new Map();
let mcpRequestId = 0;
let discoveredTools;
let policyVersion;
let discoveryPromise;

function id(prefix) {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

function clientMeta(traceparent) {
  return {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "agente-central-de-salas", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
    ...(traceparent ? { traceparent } : {}),
  };
}

async function mcpRequest(method, params, name, traceparent) {
  const requestId = ++mcpRequestId;
  const body = {
    jsonrpc: "2.0",
    id: requestId,
    method,
    params: { ...params, _meta: clientMeta(traceparent) },
  };
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      "Mcp-Method": method,
      ...(name ? { "Mcp-Name": name } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (payload.error) {
    const error = new Error(payload.error.message ?? "Erro MCP");
    error.rpc = payload.error;
    throw error;
  }
  return payload.result;
}

async function discoverMcp(traceparent) {
  const listed = await mcpRequest("tools/list", {}, undefined, traceparent);
  discoveredTools = new Set((listed.tools ?? []).map((tool) => tool.name));
  const policy = await mcpRequest("resources/read", { uri: "politica://uso" }, "politica://uso", traceparent);
  const text = policy.contents?.[0]?.text ?? "";
  policyVersion = /^versao:\s*(\S+)/m.exec(text)?.[1];
  if (!policyVersion) throw new Error("Versao da politica ausente no resource MCP");
}

async function ensureMcpReady(traceparent) {
  discoveryPromise ??= discoverMcp(traceparent).catch((error) => {
    discoveryPromise = undefined;
    throw error;
  });
  await discoveryPromise;
}

function parseReservationRequest(text) {
  const match = /^reservar sala=(\S+) inicio=(\S+) fim=(\S+) responsavel=(.+)$/.exec(text);
  if (!match) return null;
  return { sala: match[1], inicio: match[2], fim: match[3], responsavel: match[4] };
}

function textOf(message) {
  return (message?.parts ?? []).map((part) => part.text ?? "").join(" ");
}

function agentMessage(record, text) {
  return {
    messageId: id("msg"),
    role: "ROLE_AGENT",
    parts: [{ text }],
    taskId: record.task.id,
    contextId: record.task.contextId,
  };
}

function transition(record, state, text) {
  const message = text === undefined ? undefined : agentMessage(record, text);
  record.task.status = { state, ...(message ? { message } : {}) };
  if (message) record.task.history.push(message);
}

function publicTask(record) {
  return structuredClone(record.task);
}

function failTask(record, message) {
  transition(record, "TASK_STATE_FAILED", message);
}

function completeTask(record, result) {
  const artifactValue = {
    reserva: result.reserva,
    sala: result.sala,
    inicio: result.inicio,
    fim: result.fim,
    responsavel: result.responsavel,
    politica: policyVersion,
  };
  record.task.artifacts = [{
    artifactId: id("art"),
    name: "reserva",
    parts: [{ text: JSON.stringify(artifactValue) }],
  }];
  transition(record, "TASK_STATE_COMPLETED", `Reserva ${result.reserva} confirmada na ${result.sala}.`);
  record.bridge = undefined;
}

function pauseTask(record, result, args, traceparent) {
  const [inputKey, inputRequest] = Object.entries(result.inputRequests ?? {})[0] ?? [];
  const field = inputRequest?.params?.requestedSchema?.properties?.sala ?? {};
  const alternatives = field.enum ?? (field.const ? [field.const] : []);
  if (!inputKey || !result.requestState || alternatives.length === 0) {
    failTask(record, "Resposta MCP input_required invalida");
    return;
  }
  record.bridge = {
    args,
    inputKey,
    requestState: result.requestState,
    alternatives,
    traceparent,
  };
  transition(record, "TASK_STATE_INPUT_REQUIRED", `alternativas: ${alternatives.join(", ")}`);
}

async function handleToolResult(record, result, args, traceparent) {
  if (result.resultType === "input_required") {
    pauseTask(record, result, args, traceparent);
    return;
  }
  if (result.isError) {
    const message = (result.content ?? []).map((part) => part.text ?? "").join(" ");
    failTask(record, message);
    return;
  }
  const data = result.structuredContent ?? {};
  if (data.reservado === false) {
    transition(record, "TASK_STATE_CANCELED", data.motivo ?? "recusado");
    record.bridge = undefined;
    return;
  }
  completeTask(record, data);
}

async function openTask(message, traceparent) {
  const task = {
    id: id("task"),
    contextId: id("ctx"),
    status: { state: "TASK_STATE_SUBMITTED" },
    history: [structuredClone(message)],
    artifacts: [],
  };
  const record = { task, bridge: undefined };
  taskRecords.set(task.id, record);
  transition(record, "TASK_STATE_WORKING");

  const args = parseReservationRequest(textOf(message));
  if (!args) {
    failTask(record, "Pedido invalido: use reservar sala=<id> inicio=<iso8601> fim=<iso8601> responsavel=<nome>");
    return record;
  }

  try {
    await ensureMcpReady(traceparent);
    if (!discoveredTools.has("reservar_sala")) {
      throw new Error("A tool reservar_sala nao foi descoberta no servidor MCP");
    }
    const result = await mcpRequest(
      "tools/call",
      { name: "reservar_sala", arguments: args },
      "reservar_sala",
      traceparent,
    );
    await handleToolResult(record, result, args, traceparent);
  } catch (error) {
    failTask(record, error.message);
  }
  return record;
}

async function continueTask(record, message, incomingTraceparent) {
  if (TERMINAL_STATES.has(record.task.status.state)) {
    const error = new Error("Task em estado terminal nao pode ser retomada");
    error.code = -32602;
    throw error;
  }
  if (record.task.status.state !== "TASK_STATE_INPUT_REQUIRED" || !record.bridge) {
    const error = new Error("Task nao aguarda entrada");
    error.code = -32602;
    throw error;
  }

  record.task.history.push(structuredClone(message));
  const match = /^escolha=(\S+)$/.exec(textOf(message));
  const choice = match?.[1];
  if (!choice || (choice !== "recusar" && !record.bridge.alternatives.includes(choice))) {
    transition(record, "TASK_STATE_INPUT_REQUIRED", `alternativas: ${record.bridge.alternatives.join(", ")}`);
    return record;
  }

  transition(record, "TASK_STATE_WORKING");
  const bridge = record.bridge;
  const traceparent = bridge.traceparent ?? incomingTraceparent;
  const inputResponse = choice === "recusar"
    ? { action: "decline" }
    : { action: "accept", content: { sala: choice } };

  try {
    const result = await mcpRequest(
      "tools/call",
      {
        name: "reservar_sala",
        arguments: bridge.args,
        inputResponses: { [bridge.inputKey]: inputResponse },
        requestState: bridge.requestState,
      },
      "reservar_sala",
      traceparent,
    );
    await handleToolResult(record, result, bridge.args, traceparent);
  } catch (error) {
    failTask(record, error.message);
  }
  return record;
}

async function sendMessage(params, traceparent) {
  const message = params?.message;
  if (!message || message.role !== "ROLE_USER" || !message.messageId || !Array.isArray(message.parts)) {
    const error = new Error("Mensagem A2A invalida");
    error.code = -32602;
    throw error;
  }
  const taskId = message.taskId;
  const record = taskId ? taskRecords.get(taskId) : undefined;
  if (taskId && !record) {
    const error = new Error("Task nao encontrada");
    error.code = -32602;
    throw error;
  }
  const updated = record
    ? await continueTask(record, message, traceparent)
    : await openTask(message, traceparent);
  return { task: publicTask(updated) };
}

function getTask(params) {
  const record = taskRecords.get(params?.id);
  if (!record) {
    const error = new Error("Task nao encontrada");
    error.code = -32602;
    throw error;
  }
  return { task: publicTask(record) };
}

const agentCard = {
  name: "Central de Salas",
  description: "Reserva salas de reuniao da Hill Valley Tech.",
  provider: { organization: "Hill Valley Tech", url: "https://hillvalley.example" },
  version: "1.0.0",
  supportedInterfaces: [{
    url: `${AGENT_PUBLIC_URL}/a2a`,
    protocolBinding: "JSONRPC",
    protocolVersion: "1.0",
  }],
  capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{
    id: "reservar-sala",
    name: "Reservar sala",
    description: "Reserva uma sala em um intervalo. Se houver conflito, pergunta qual alternativa usar.",
    tags: ["salas", "agenda"],
    inputModes: ["text/plain"],
    outputModes: ["text/plain"],
    examples: ["reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty"],
  }],
};

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

const httpServer = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/.well-known/agent-card.json") {
    json(response, 200, agentCard);
    return;
  }
  if (request.method !== "POST" || request.url !== "/a2a") {
    json(response, 404, { error: "not found" });
    return;
  }

  let rpc;
  try {
    rpc = await readJson(request);
  } catch {
    json(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  try {
    let result;
    if (rpc.method === "SendMessage") result = await sendMessage(rpc.params, request.headers.traceparent);
    else if (rpc.method === "GetTask") result = getTask(rpc.params);
    else {
      const error = new Error("Method not found");
      error.code = -32601;
      throw error;
    }
    json(response, 200, { jsonrpc: "2.0", id: rpc.id, result });
  } catch (error) {
    json(response, 200, {
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      error: { code: error.code ?? -32603, message: error.message ?? "Internal error" },
    });
  }
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.error(`[agente] ouvindo em ${AGENT_PUBLIC_URL}/a2a; MCP em ${MCP_URL}`);
});

