// src/handlers/orders/retry.ts
import { APIGatewayProxyHandler } from "aws-lambda";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/middleware/authMiddleware";

export const retry: APIGatewayProxyHandler = async (event) => {
  try {
    verifyToken(event);

    const orderId = event.pathParameters?.id;
    if (!orderId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "order_id é obrigatório" }) };
    }

    // garante que existe
    const order = await prisma.core_orders.findUnique({
      where: { id: orderId },
      select: { id: true, status: true },
    });

    if (!order) {
      return { statusCode: 404, body: JSON.stringify({ ok: false, error: "Order not found", order_id: orderId }) };
    }

    // before counts
    const before = await prisma.core_order_subtransactions.groupBy({
      by: ["status"],
      where: { order_id: orderId },
      _count: { _all: true },
    });

    const beforeCounts = before.reduce((acc: any, row) => {
      acc[row.status] = row._count._all;
      return acc;
    }, {});

    // ✅ reset (tudo que não é SUCCESS)
    const updated = await prisma.core_order_subtransactions.updateMany({
      where: {
        order_id: orderId,
        NOT: { status: "SUCCESS" },
      },
      data: {
        status: "PENDING",
        attempts: 0,
        next_retry_at: null,
        last_error: null,
        executed_at: null,
        provider_ref: null,
        execution_metadata: null,
        idempotency_key: null, // ✅ importantíssimo pra não reusar idempotency
        updated_at: new Date(),
      },
    });

    // after counts
    const after = await prisma.core_order_subtransactions.groupBy({
      by: ["status"],
      where: { order_id: orderId },
      _count: { _all: true },
    });

    const afterCounts = after.reduce((acc: any, row) => {
      acc[row.status] = row._count._all;
      return acc;
    }, {});

    // (opcional) seta order como IN_PROGRESS se ainda não COMPLETED
    if (order.status !== "COMPLETED") {
      await prisma.core_orders.update({
        where: { id: orderId },
        data: { status: "IN_PROGRESS", updated_at: new Date(), last_error: null },
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        order_id: orderId,
        before: beforeCounts,
        after: afterCounts,
        updated_subtransactions: updated.count,
        reset_attempts: true,
        message: "Subtransactions não-SUCCESS voltaram para PENDING e serão reprocessadas pelo worker.",
      }),
    };
  } catch (err: any) {
    console.error("retryOrder error:", err);
    const msg = err?.message || String(err);
    const code = msg === "Unauthorized" ? 401 : 500;
    return { statusCode: code, body: JSON.stringify({ ok: false, error: msg }) };
  }
};
