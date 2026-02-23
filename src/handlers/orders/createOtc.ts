import { APIGatewayProxyHandler } from "aws-lambda";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import crypto from "crypto";
import { verifyToken } from "@/middleware/authMiddleware";

const orderTypeSchema = z.enum([
  "TRX",
  "WIRE",
  "USDT",
  "EFETIVO",
  "TRANSFERENCIA",
  "AJUSTE_SALDO",
  "ACERTO_IMPOSTO",
]);

const createOtcSchema = z.object({
  id: z.string().min(6),
  customer_id: z.string().min(6),
  customer_type: z.string().min(1),
  bank_name: z.string().min(1).default("OTC"),

  // OTC manual: tipo da operação (USDT, WIRE, TRX etc)
  type: orderTypeSchema.default("USDT"),

  base_amount: z.number().positive(), // ex: 100000 (USD)
  rate: z.number().positive(), // ex: 1.5
  fees_amount: z.number().nonnegative().default(0),
  base_currency: z.string().default("USD"),
  settlement_currency: z.string().default("BRL"),

  // se vier, usamos. Se não vier, calculamos: base_amount*rate + fees
  total_amount: z.number().positive().optional(),

  description: z.string().optional(),
  reason_code: z.string().optional(), // opcional p/ relatório

  idempotency_key: z.string().optional(),
  metadata: z.any().optional(),
});

function toMoney(n: number) {
  return Number(n.toFixed(2));
}

function pickOperator(metadata: any) {
  const name = metadata?.operator_name ? String(metadata.operator_name).trim() : null;
  const email = metadata?.operator_email ? String(metadata.operator_email).trim() : null;
  return { name: name || null, email: email || null };
}

function buildAudit(event: any, auth?: any) {
  const method = event?.requestContext?.http?.method || event?.httpMethod || null;
  const path = event?.requestContext?.http?.path || event?.path || null;
  const requestId = event?.requestContext?.requestId || null;
  const ip = event?.requestContext?.http?.sourceIp || null;
  const ua = event?.headers?.["user-agent"] || event?.headers?.["User-Agent"] || null;

  const actorUserId = auth?.sub || auth?.user_id || auth?.id || null;

  return {
    actor: actorUserId ? { type: "user", user_id: actorUserId } : { type: "unknown", user_id: null },
    audit: {
      source: {
        service: "order-service",
        route: method && path ? `${method} ${path}` : null,
        request_id: requestId,
      },
      context: {
        ip,
        user_agent: ua,
      },
      at: new Date().toISOString(),
    },
  };
}

export const createOtc: APIGatewayProxyHandler = async (event) => {
  try {
    const auth = (verifyToken(event) as any) || undefined;

    const body = JSON.parse(event.body || "{}");
    const parsed = createOtcSchema.safeParse(body);

    if (!parsed.success) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid payload", details: parsed.error.flatten() }) };
    }

    const data = parsed.data;

    const computedTotal = toMoney(data.total_amount ?? data.base_amount * data.rate + data.fees_amount);

    const orderIdempotency = data.idempotency_key ?? `order_${data.id}`;

    const existing = await prisma.core_orders.findFirst({
      where: { OR: [{ id: data.id }, { idempotency_key: orderIdempotency }] },
      include: { core_order_destinations: true, core_order_subtransactions: true },
    });

    if (existing) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, order: existing, idempotent: true }) };
    }

    // ✅ operador vindo do lovable
    const operator = pickOperator(data.metadata);
    // ✅ audit/actor (actor só se o token retornar algo)
    const auditMeta = buildAudit(event, auth);

    // ✅ metadata final padronizado
    const finalMetadata =
      data.metadata == null
        ? { operator, ...auditMeta }
        : {
            ...(data.metadata ?? {}),
            operator,
            ...auditMeta,
          };

    const created = await prisma.$transaction(async (tx) => {
      // carrega saldo
      const bal = await tx.core_balances.findUnique({
        where: { customer_id: data.customer_id },
        select: { id: true, available_amount: true, locked_amount: true, credit_limit: true },
      });

      if (!bal) throw new Error("Saldo do customer não encontrado (core_balances).");

      const available = Number(bal.available_amount);
      const credit = Number(bal.credit_limit);
      const locked = Number(bal.locked_amount);

      // regra mínima: disponível + limite >= total
      const utilizable = toMoney(available + credit); // locked já está separado
      if (utilizable < computedTotal) {
        throw new Error(`Saldo insuficiente. Utilizável: ${utilizable} < Total: ${computedTotal}`);
      }

      // cria order COMPLETED (OTC manual não tem execução)
      const order = await tx.core_orders.create({
        data: {
          id: data.id,
          customer_id: data.customer_id,
          customer_type: data.customer_type,
          bank_name: data.bank_name,

          type: data.type as any,
          kind: "OTC" as any,

          total_amount: computedTotal as any,
          sub_amount: 0 as any,

          base_amount: data.base_amount as any,
          rate: data.rate as any,
          fees_amount: data.fees_amount as any,

          base_currency: data.base_currency,
          settlement_currency: data.settlement_currency,

          status: "COMPLETED",
          idempotency_key: orderIdempotency,
          metadata: {
            ...(finalMetadata as any),
            description: data.description ?? null,
            calculation: {
              base_amount: data.base_amount,
              rate: data.rate,
              fees_amount: data.fees_amount,
              total_amount: computedTotal,
            },
          },
          locked_amount_snapshot: locked as any,
          started_at: new Date() as any,
          completed_at: new Date() as any,
          last_error: null,
          updated_at: new Date() as any,
        },
      });

      // debita saldo (direto no available_amount)
      await tx.core_balances.update({
        where: { customer_id: data.customer_id },
        data: { available_amount: (available - computedTotal) as any },
      });

      // registra transação (✅ agora com operator + audit também)
      await tx.core_transactions.create({
        data: {
          id: crypto.randomUUID(),
          customer_id: data.customer_id,
          type: "debit" as any,
          amount: computedTotal as any,
          description: data.description ?? `OTC ${data.type} - débito`,
          reason_code: data.reason_code ?? null,
          metadata: {
            order_id: order.id,
            kind: "OTC",
            base_amount: data.base_amount,
            rate: data.rate,
            fees_amount: data.fees_amount,
            base_currency: data.base_currency,
            settlement_currency: data.settlement_currency,

            // ✅ importante pro relatório
            operator,
            ...auditMeta,

            // opcional, ajuda o Lovable
            notes: data.metadata?.notes ?? null,
            pair: data.metadata?.pair ?? null,
            screen: data.metadata?.screen ?? null,
            source: data.metadata?.source ?? null,
          },
        },
      });

      const full = await tx.core_orders.findUnique({
        where: { id: order.id },
        include: { core_order_destinations: true, core_order_subtransactions: true },
      });

      return full!;
    });

    return { statusCode: 201, body: JSON.stringify({ ok: true, order: created }) };
  } catch (err: any) {
    console.error("createOtc error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Internal error", details: err?.message || String(err) }) };
  }
};