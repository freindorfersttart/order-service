import { APIGatewayProxyHandler } from "aws-lambda";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { verifyToken } from "@/middleware/authMiddleware";

const deleteOtcSchema = z.object({
  id: z.string().min(6), // order id
  reason: z.string().optional(), // motivo do "delete" (vai pra metadata)
  metadata: z.any().optional(), // operador/audit do lovable
});

function toMoney(n: number) {
  return Number(n.toFixed(2));
}

function pickOperator(metadata: any) {
  const name = metadata?.operator_name ? String(metadata.operator_name).trim() : null;
  const email = metadata?.operator_email ? String(metadata.operator_email).trim() : null;
  return { name: name || null, email: email || null };
}

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
      context: { ip, user_agent: ua },
      at: new Date().toISOString(),
    },
  };
}

export const deleteOrderOtc: APIGatewayProxyHandler = async (event) => {
  try {
    verifyToken(event);

    const body = JSON.parse(event.body || "{}");
    const parsed = deleteOtcSchema.safeParse(body);

    if (!parsed.success) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid payload", details: parsed.error.flatten() }),
      };
    }

    const data = parsed.data;
    const auditMeta = buildAudit(event);
    const operator = pickOperator(data.metadata);

    const result = await prisma.$transaction(async (tx) => {
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

      // 2) acha transação debit vinculada (mesma lógica do update)
      const trx = await tx.core_transactions.findFirst({
        where: {
          type: "debit" as any,
          customer_id: order.customer_id,
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

      // 3) saldo
      const bal = await tx.core_balances.findUnique({
        where: { customer_id: order.customer_id },
        select: { available_amount: true },
      });

      if (!bal) throw new Error("Saldo do customer não encontrado (core_balances).");

      const available = Number(bal.available_amount);
      const total = toMoney(Number(order.total_amount));

      // 4) reverte saldo (devolve o total da OTC)
      await tx.core_balances.update({
        where: { customer_id: order.customer_id },
        data: { available_amount: toMoney(available + total) as any },
      });

      // 5) deleta a transação pra sair do relatório
      await tx.core_transactions.delete({
        where: { id: trx.id },
      });

      // 6) opcional: marca na metadata da order que foi "voided" (não apaga a order)
      const prevMeta: any = (order.metadata as any) ?? {};
      const nowIso = new Date().toISOString();

      await tx.core_orders.update({
        where: { id: order.id },
        data: {
          updated_at: new Date() as any,
          metadata: {
            ...prevMeta,
            ...auditMeta,

            voided: true,
            voided_at: nowIso,
            void_reason: data.reason ?? null,

            operator,
            operator_name: operator.name,
            operator_email: operator.email,

            // pra rastrear o que foi removido
            voided_transaction_id: trx.id,
            voided_amount: total,
          },
        },
      });

      const newBal = await tx.core_balances.findUnique({
        where: { customer_id: order.customer_id },
        select: { available_amount: true, credit_limit: true, locked_amount: true },
      });

      const full = await tx.core_orders.findUnique({
        where: { id: order.id },
        include: { core_order_destinations: true, core_order_subtransactions: true },
      });

      return {
        order: full!,
        deleted_transaction_id: trx.id,
        refunded_amount: total,
        balance: newBal,
      };
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
  } catch (err: any) {
    const statusCode = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 500;
    console.error("deleteOrderOtc error:", err);
    return {
      statusCode,
      body: JSON.stringify({
        error: statusCode === 500 ? "Internal error" : "Request error",
        details: err?.message || String(err),
      }),
    };
  }
};