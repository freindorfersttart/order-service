import { APIGatewayProxyHandler } from "aws-lambda";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
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

const updateOtcSchema = z.object({
  id: z.string().min(6), // order id

  // campos editáveis
  type: orderTypeSchema.optional(),

  base_amount: z.number().positive().optional(),
  rate: z.number().positive().optional(),
  fees_amount: z.number().nonnegative().optional(),
  base_currency: z.string().optional(),
  settlement_currency: z.string().optional(),

  total_amount: z.number().positive().optional(), // se vier, sobrescreve cálculo

  description: z.string().optional(),
  reason_code: z.string().optional(),

  // retroativo pro relatório
  completed_at: z.string().optional(),

  // metadata extra do lovable
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

function parseOptionalDate(v?: string) {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

// audit leve (não depende de JWT)
function buildAudit(event: any) {
  const method = event?.requestContext?.http?.method || event?.httpMethod || null;
  const path = event?.requestContext?.http?.path || event?.path || null;
  const requestId = event?.requestContext?.requestId || null;
  const ip = event?.requestContext?.http?.sourceIp || null;
  const ua = event?.headers?.["user-agent"] || event?.headers?.["User-Agent"] || null;

  return {
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

export const updateOtc: APIGatewayProxyHandler = async (event) => {
  try {
    verifyToken(event);

    const body = JSON.parse(event.body || "{}");
    const parsed = updateOtcSchema.safeParse(body);

    if (!parsed.success) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid payload", details: parsed.error.flatten() }),
      };
    }

    const data = parsed.data;

    const completedAt = parseOptionalDate(data.completed_at);
    if (data.completed_at && !completedAt) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid completed_at (date parse failed)" }) };
    }
    if (completedAt && completedAt.getTime() > Date.now()) {
      return { statusCode: 400, body: JSON.stringify({ error: "completed_at não pode ser no futuro" }) };
    }

    const auditMeta = buildAudit(event);
    const operator = pickOperator(data.metadata);

    const updated = await prisma.$transaction(async (tx) => {
      // 1) carrega order + valida OTC
      const order = await tx.core_orders.findUnique({
        where: { id: data.id },
        include: { core_order_destinations: true, core_order_subtransactions: true },
      });

      if (!order) {
        const e: any = new Error("Order não encontrada.");
        e.statusCode = 404;
        throw e;
      }

      if ((order.kind as any) !== "OTC") {
        const e: any = new Error("Order não é OTC.");
        e.statusCode = 400;
        throw e;
      }

      // 2) acha a transação debit vinculada
      // (pelo createOtc: metadata.order_id = order.id)
      const trx = await tx.core_transactions.findFirst({
        where: {
          type: "debit" as any,
          customer_id: order.customer_id,
          // Prisma JSON filter: path depende do provider; mantendo simples via contains
          // Se teu Prisma suporta path: { path: ["order_id"], equals: order.id }
    AND: [
      { metadata: { path: ["order_id"], equals: order.id } as any },
      { metadata: { path: ["kind"], equals: "OTC" } as any },
    ],
  },
        orderBy: { created_at: "desc" as any },
      });

      if (!trx) {
        const e: any = new Error("Transação debit da OTC não encontrada (metadata.order_id).");
        e.statusCode = 404;
        throw e;
      }

      // 3) saldo atual
      const bal = await tx.core_balances.findUnique({
        where: { customer_id: order.customer_id },
        select: { available_amount: true, credit_limit: true, locked_amount: true },
      });

      if (!bal) throw new Error("Saldo do customer não encontrado (core_balances).");

      const available = Number(bal.available_amount);
      const credit = Number(bal.credit_limit);
      const locked = Number(bal.locked_amount);

      const oldTotal = toMoney(Number(order.total_amount));

      // 4) monta novos valores (fallback pros atuais)
      const newBaseAmount = data.base_amount ?? (order.base_amount != null ? Number(order.base_amount) : undefined);
      const newRate = data.rate ?? (order.rate != null ? Number(order.rate) : undefined);
      const newFees = data.fees_amount ?? (order.fees_amount != null ? Number(order.fees_amount) : 0);

      // sanity: se não mandou total_amount, precisa ter base+rate disponíveis
      if (data.total_amount == null) {
        if (newBaseAmount == null || newRate == null) {
          const e: any = new Error("Para recalcular total, base_amount e rate precisam existir (no payload ou na ordem).");
          e.statusCode = 400;
          throw e;
        }
      }

      const computedTotal = toMoney(
        data.total_amount ?? (Number(newBaseAmount) * Number(newRate) + Number(newFees))
      );

      // 5) delta no saldo (positivo = precisa debitar mais; negativo = devolver)
      const delta = toMoney(computedTotal - oldTotal);

      if (delta > 0) {
        const utilizable = toMoney(available + credit);
        if (utilizable < delta) {
          const e: any = new Error(`Saldo insuficiente para aumentar OTC. Utilizável: ${utilizable} < Delta: ${delta}`);
          e.statusCode = 400;
          throw e;
        }
        await tx.core_balances.update({
          where: { customer_id: order.customer_id },
          data: { available_amount: toMoney(available - delta) as any },
        });
      } else if (delta < 0) {
        // devolve diferença
        await tx.core_balances.update({
          where: { customer_id: order.customer_id },
          data: { available_amount: toMoney(available + Math.abs(delta)) as any },
        });
      }

      // 6) metadata final (merge leve, preservando o que já existe)
      const prevMeta: any = (order.metadata as any) ?? {};
      const finalMetadata = {
        ...prevMeta,
        ...(data.metadata ?? {}),
        operator,
        operator_name: operator.name,
        operator_email: operator.email,
        ...auditMeta,
        // marca retroativo quando veio completed_at
        backdated: Boolean(completedAt),
        backdated_completed_at: completedAt ? completedAt.toISOString() : (prevMeta?.backdated_completed_at ?? null),
        description: data.description ?? prevMeta?.description ?? null,
        calculation: {
          base_amount: newBaseAmount ?? prevMeta?.calculation?.base_amount ?? null,
          rate: newRate ?? prevMeta?.calculation?.rate ?? null,
          fees_amount: newFees ?? prevMeta?.calculation?.fees_amount ?? 0,
          total_amount: computedTotal,
        },
      };

      const now = new Date();
      const stamp = completedAt ?? (order.completed_at ? new Date(order.completed_at as any) : now);

      // 7) atualiza order
      await tx.core_orders.update({
        where: { id: order.id },
        data: {
          type: (data.type ?? order.type) as any,

          total_amount: computedTotal as any,

          base_amount: (newBaseAmount ?? order.base_amount) as any,
          rate: (newRate ?? order.rate) as any,
          fees_amount: (newFees ?? order.fees_amount) as any,

          base_currency: data.base_currency ?? (order.base_currency as any),
          settlement_currency: data.settlement_currency ?? (order.settlement_currency as any),

          // ✅ opcional: manter started_at como estava; completed_at pode ser retroativo
          completed_at: stamp as any,
          updated_at: now as any,

          locked_amount_snapshot: locked as any,

          metadata: finalMetadata,
        },
      });

      // 8) atualiza transação debit espelhando novo total/metadata
      const prevTrxMeta: any = (trx.metadata as any) ?? {};
      const trxMeta = {
        ...prevTrxMeta,

        order_id: order.id,
        kind: "OTC",

        base_amount: newBaseAmount ?? prevTrxMeta?.base_amount ?? null,
        rate: newRate ?? prevTrxMeta?.rate ?? null,
        fees_amount: newFees ?? prevTrxMeta?.fees_amount ?? 0,
        base_currency: data.base_currency ?? prevTrxMeta?.base_currency ?? order.base_currency ?? "USD",
        settlement_currency:
          data.settlement_currency ?? prevTrxMeta?.settlement_currency ?? order.settlement_currency ?? "BRL",

        operator,
        operator_name: operator.name,
        operator_email: operator.email,

        ...auditMeta,

        // retroativo p/ relatórios
        backdated: Boolean(completedAt),
        completed_at: completedAt ? completedAt.toISOString() : (prevTrxMeta?.completed_at ?? null),
      };

      await tx.core_transactions.update({
        where: { id: trx.id },
        data: {
          amount: computedTotal as any,
          description: data.description ?? trx.description ?? `OTC ${(data.type ?? order.type) as any} - débito`,
          reason_code: data.reason_code ?? trx.reason_code ?? null,
          metadata: trxMeta,
          // opcional: se você usa created_at do trx pra relatório retroativo, NÃO mexa.
          // se quiser um carimbo específico, dá pra guardar só em metadata.completed_at como já tá.
        },
      });

      const full = await tx.core_orders.findUnique({
        where: { id: order.id },
        include: { core_order_destinations: true, core_order_subtransactions: true },
      });

      const newBal = await tx.core_balances.findUnique({
        where: { customer_id: order.customer_id },
        select: { available_amount: true, credit_limit: true, locked_amount: true },
      });

      return {
        order: full!,
        delta,
        old_total: oldTotal,
        new_total: computedTotal,
        balance: newBal,
        transaction_id: trx.id,
      };
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, ...updated }) };
  } catch (err: any) {
    const statusCode = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 500;
    console.error("updateOtc error:", err);
    return {
      statusCode,
      body: JSON.stringify({ error: statusCode === 500 ? "Internal error" : "Request error", details: err?.message || String(err) }),
    };
  }
};