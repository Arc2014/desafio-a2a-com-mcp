import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createMcpHandler,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  McpServer,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const PROTOCOL_VERSION = "2026-07-28";
const PORT = Number(process.env.MCP_PORT ?? 7301);
const REQUEST_STATE_TTL_SECONDS = 600;
const ELICITATION_KEY = "escolha_de_sala";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const rooms = JSON.parse(readFileSync(`${ROOT}dados/salas.json`, "utf8"));
const reservations = JSON.parse(readFileSync(`${ROOT}dados/reservas.json`, "utf8"));
const policyText = readFileSync(`${ROOT}dados/politica-de-uso.md`, "utf8");
const policyVersion = /^versao:\s*(\S+)/m.exec(policyText)?.[1];

if (!policyVersion) {
  throw new Error("A versao nao foi encontrada na primeira linha da politica");
}

function requestStateKey() {
  const value = process.env.REQUEST_STATE_SECRET;
  if (!value) {
    throw new Error("REQUEST_STATE_SECRET e obrigatoria; consulte o README para gerar uma chave");
  }
  const key = /^[0-9a-fA-F]{64,}$/.test(value) && value.length % 2 === 0
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "utf8");
  if (key.byteLength < 32) {
    throw new Error("REQUEST_STATE_SECRET precisa ter no minimo 32 bytes");
  }
  return key;
}

const stateCodec = createRequestStateCodec({
  key: requestStateKey(),
  ttlSeconds: REQUEST_STATE_TTL_SECONDS,
  bind: (ctx) => `${ctx.mcpReq.method}\0${ctx.http?.req?.headers.get("Mcp-Name") ?? ""}`,
});

let nextReservation = reservations.reduce((largest, reservation) => {
  const number = Number(/^res-(\d+)$/.exec(reservation.id)?.[1] ?? 0);
  return Math.max(largest, number);
}, 0) + 1;

const roomSchema = z.object({
  id: z.string(),
  nome: z.string(),
  capacidade: z.number().int(),
  recursos: z.array(z.string()),
});
const listRoomsOutput = z.object({ salas: z.array(roomSchema) });
const intervalInput = z.object({ sala: z.string(), inicio: z.string(), fim: z.string() });
const availabilityOutput = z.object({
  sala: z.string(),
  livre: z.boolean(),
  conflitos: z.array(z.object({
    id: z.string(),
    inicio: z.string(),
    fim: z.string(),
    responsavel: z.string(),
  })),
});
const reserveInput = intervalInput.extend({ responsavel: z.string() });
const reserveOutput = z.object({
  reserva: z.string().nullable(),
  reservado: z.boolean(),
  sala: z.string().nullable(),
  inicio: z.string().nullable(),
  fim: z.string().nullable(),
  responsavel: z.string().nullable(),
  politica: z.string().nullable(),
  motivo: z.string().nullable(),
});

function textResult(structuredContent, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError,
  };
}

function errorResult(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function saoPauloClock(instant) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function validateInterval({ sala, inicio, fim }) {
  if (!rooms.some((room) => room.id === sala)) {
    return `Sala inexistente: ${sala}`;
  }
  const start = new Date(inicio);
  const end = new Date(fim);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    return "Intervalo invalido: fim deve ser posterior a inicio";
  }
  if (end.getTime() - start.getTime() > 2 * 60 * 60 * 1000) {
    return "Duracao acima do limite: a politica permite no maximo 2 horas";
  }
  const startMinutes = saoPauloClock(start);
  const endMinutes = saoPauloClock(end);
  if (startMinutes < 8 * 60 || endMinutes > 20 * 60 || endMinutes === 0) {
    return "Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00";
  }
  return null;
}

function conflicts(roomId, inicio, fim) {
  const start = new Date(inicio).getTime();
  const end = new Date(fim).getTime();
  return reservations.filter((reservation) => (
    reservation.sala === roomId
    && new Date(reservation.inicio).getTime() < end
    && new Date(reservation.fim).getTime() > start
  ));
}

function alternativesFor(roomId, inicio, fim) {
  const requested = rooms.find((room) => room.id === roomId);
  return rooms
    .filter((room) => (
      room.id !== roomId
      && room.capacidade >= requested.capacidade
      && conflicts(room.id, inicio, fim).length === 0
    ))
    .sort((a, b) => a.capacidade - b.capacidade || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((room) => room.id);
}

function createReservation({ sala, inicio, fim, responsavel }) {
  const id = `res-${String(nextReservation++).padStart(4, "0")}`;
  reservations.push({ id, sala, inicio, fim, responsavel });
  return {
    reserva: id,
    reservado: true,
    sala,
    inicio,
    fim,
    responsavel,
    politica: policyVersion,
    motivo: null,
  };
}

function buildMcpServer() {
  const server = new McpServer(
    { name: "central-de-salas", version: "1.0.0" },
    {
      capabilities: { tools: {}, resources: {} },
      requestState: { verify: stateCodec.verify },
    },
  );

  server.registerTool(
    "listar_salas",
    {
      description: "Lista todas as salas com capacidade e recursos.",
      inputSchema: z.object({}),
      outputSchema: listRoomsOutput,
    },
    async () => textResult({ salas: rooms }),
  );

  server.registerTool(
    "consultar_disponibilidade",
    {
      description: "Diz se uma sala esta livre no intervalo, e quais reservas conflitam.",
      inputSchema: intervalInput,
      outputSchema: availabilityOutput,
    },
    async (args) => {
      const error = validateInterval(args);
      if (error) return errorResult(error);
      const conflicting = conflicts(args.sala, args.inicio, args.fim).map(({ id, inicio, fim, responsavel }) => ({
        id, inicio, fim, responsavel,
      }));
      return textResult({ sala: args.sala, livre: conflicting.length === 0, conflitos: conflicting });
    },
  );

  server.registerTool(
    "reservar_sala",
    {
      description: "Reserva uma sala. Se o intervalo estiver ocupado, pergunta qual alternativa usar.",
      inputSchema: reserveInput,
      outputSchema: reserveOutput,
    },
    async (untrustedArgs, ctx) => {
      const sealed = ctx.mcpReq.requestState();
      const args = sealed?.pedido ?? untrustedArgs;
      const error = validateInterval(args);
      if (error) return errorResult(error);

      if (sealed) {
        const response = inputResponse(ctx.mcpReq.inputResponses, ELICITATION_KEY);
        if (response.kind === "elicit" && ["decline", "cancel"].includes(response.action)) {
          return textResult({
            reserva: null,
            reservado: false,
            sala: null,
            inicio: null,
            fim: null,
            responsavel: null,
            politica: null,
            motivo: "recusado",
          });
        }
        const selected = response.kind === "elicit" && response.action === "accept"
          ? response.content?.sala
          : undefined;
        if (typeof selected !== "string" || !sealed.alternativas.includes(selected)) {
          return errorResult("Resposta de elicitation invalida");
        }
        if (conflicts(selected, args.inicio, args.fim).length > 0) {
          return errorResult("Sem alternativas disponiveis no intervalo");
        }
        return textResult(createReservation({ ...args, sala: selected }));
      }

      if (conflicts(args.sala, args.inicio, args.fim).length === 0) {
        return textResult(createReservation(args));
      }

      const alternatives = alternativesFor(args.sala, args.inicio, args.fim);
      if (alternatives.length === 0) {
        return errorResult("Sem alternativas disponiveis no intervalo");
      }
      const requestedSchema = z.object({ sala: z.enum(alternatives) });
      return inputRequired({
        inputRequests: {
          [ELICITATION_KEY]: inputRequired.elicit({
            message: "A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.",
            requestedSchema,
          }),
        },
        requestState: await stateCodec.mint({ pedido: args, alternativas: alternatives }, ctx),
      });
    },
  );

  server.registerResource(
    "politica-de-uso",
    "politica://uso",
    { title: "Politica de uso das salas", mimeType: "text/markdown" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: policyText }],
    }),
  );

  return server;
}

const mcpHandler = createMcpHandler(buildMcpServer, {
  legacy: "reject",
  onerror: (error) => console.error(`[mcp:error] ${error.message}`),
});

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

const httpServer = createServer(async (incoming, outgoing) => {
  if (incoming.url !== "/mcp") {
    outgoing.writeHead(404, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: "not found" }));
    return;
  }

  try {
    const rawBody = await readBody(incoming);
    let parsedBody;
    try {
      parsedBody = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : undefined;
    } catch {
      parsedBody = undefined;
    }
    const meta = parsedBody?.params?._meta ?? {};
    console.error(JSON.stringify({
      method: parsedBody?.method ?? incoming.method,
      id: parsedBody?.id ?? null,
      traceparent: meta.traceparent ?? null,
    }));

    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const request = new Request(`http://${incoming.headers.host ?? `127.0.0.1:${PORT}`}${incoming.url}`, {
      method: incoming.method,
      headers,
      body: rawBody.length ? rawBody : undefined,
    });
    const response = await mcpHandler.fetch(request, { parsedBody });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(`[mcp:http] ${error.stack ?? error}`);
    outgoing.writeHead(500, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }));
  }
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.error(`[mcp] ouvindo em http://127.0.0.1:${PORT}/mcp (protocolo ${PROTOCOL_VERSION})`);
});
