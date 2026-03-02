import { APIGatewayProxyHandler } from "aws-lambda";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/middleware/authMiddleware";
import crypto from "crypto";

function asObject(v: any) {
  if (!v) return undefined;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

export const registerDebitsFromSuccessSubs: APIGatewayProxyHandler = async (
  event
) => {
  try {
    verifyToken(event);

    const orderId =
      event.pathParameters?.orderId ||
      event.pathParameters?.id ||
      event.pathParameters?.order_id;

    if (!orderId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "Missing path param: orderId" }),
      };
    }

    const order = await prisma.core_orders.findUnique({
      where: { id: orderId },
      select: { id: true, customer_id: true },
    });

    if (!order) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: "Order not found", orderId }),
      };
    }

    const successSubs = await prisma.core_order_subtransactions.findMany({
      where: { order_id: orderId, status: "SUCCESS" },
      select: {
        id: true,
        amount: true,
        bank_account_id: true,
        destination_pix_key: true,
        provider_ref: true,
        execution_metadata: true,
        executed_at: true, // ✅ precisa pra setar created_at da transaction
        created_at: true,  // ✅ fallback caso executed_at esteja null
      },
      orderBy: [{ created_at: "asc" }],
    });

    if (successSubs.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          orderId,
          customer_id: order.customer_id,
          successSubs: 0,
          created: 0,
          skippedExisting: 0,
          message: "No SUCCESS subtransactions to reconcile",
        }),
      };
    }

    const subIds = successSubs.map((s) => s.id);

    const existing = await prisma.core_transactions.findMany({
      where: {
        customer_id: order.customer_id,
        type: "debit",
        reason_code: "AUTO_PIX_DEBIT",
        subtransaction_id: { in: subIds },
      },
      select: { subtransaction_id: true },
    });

    const existingSet = new Set(
      existing.map((e) => String(e.subtransaction_id || ""))
    );

    const missing = successSubs.filter((s) => !existingSet.has(s.id));

    if (missing.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          orderId,
          customer_id: order.customer_id,
          successSubs: successSubs.length,
          created: 0,
          skippedExisting: successSubs.length,
          message: "All SUCCESS subtransactions already have AUTO_PIX_DEBIT",
        }),
      };
    }

    // cria as transações faltantes
    const createdIds: string[] = [];

    await prisma.$transaction(
      async (tx) => {
        for (const sub of missing) {
          const id = crypto.randomUUID();

          const execMeta = asObject(sub.execution_metadata);
          // No CSV de subs, execution_metadata costuma vir como {"data": {...}}
          // No CSV de tx, o padrão é metadata.raw.data = {...}
          const rawData =
            execMeta?.data ??
            execMeta ??
            undefined;

          const metadata = {
            raw: rawData ? { data: rawData } : undefined,
            source: { service: "order-service", operation: "debit_reconcile" },
            order_id: orderId,
            provider: "ONLYUP",
            provider_ref: sub.provider_ref ?? undefined,
            bank_account_id: sub.bank_account_id ?? undefined,
            subtransaction_id: sub.id,
            destination_pix_key: sub.destination_pix_key ?? undefined,
          };

          await tx.core_transactions.create({
            data: {
              id,
              customer_id: order.customer_id,
              type: "debit",
              amount: sub.amount,
              description: `SttartPay payout ${orderId} sub=${sub.id}`,
              reason_code: "AUTO_PIX_DEBIT",
              subtransaction_id: sub.id,
              metadata,
              created_at: (sub.executed_at ?? sub.created_at) as any, // ✅ igual executed_at da sub
            },
          });

          createdIds.push(id);
        }
      },
      // isolamento padrão ok; se quiser travar mais contra corrida, dá pra subir pra Serializable depois
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        orderId,
        customer_id: order.customer_id,
        successSubs: successSubs.length,
        created: createdIds.length,
        skippedExisting: successSubs.length - missing.length,
        created_transaction_ids: createdIds,
      }),
    };
  } catch (err: any) {
    console.error("registerDebitsFromSuccessSubs error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal error",
        error: err?.message || String(err),
      }),
    };
  }
};