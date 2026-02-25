import { APIGatewayProxyHandler } from "aws-lambda";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/middleware/authMiddleware";

function toInt(v: any, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

type Agg = Record<
  string,
  {
    totalSubs: number;
    success: number;
    failed: number;
    pending: number;
    processing: number;
  }
>;

export const getByCustomer: APIGatewayProxyHandler = async (event) => {
  try {
    verifyToken(event);

    const customerId = event.pathParameters?.customerId;
    if (!customerId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "customerId is required" }),
      };
    }

    const qs = event.queryStringParameters || {};
    const page = Math.max(1, toInt(qs.page, 1));
    const pageSize = Math.min(100, Math.max(1, toInt(qs.pageSize, 20)));
    const skip = (page - 1) * pageSize;

    const [total, orders] = await Promise.all([
      prisma.core_orders.count({
        where: { customer_id: customerId },
      }),
      prisma.core_orders.findMany({
        where: { customer_id: customerId },
        orderBy: { created_at: "desc" }, // mesmo padrão do getAll (ajuste se teu campo for outro)
        skip,
        take: pageSize,
        include: {
          core_order_destinations: true,
          _count: { select: { core_order_subtransactions: true } },
        },
      }),
    ]);

    const orderIds = orders.map((o) => o.id);

    // agrega status das subtransactions por order_id
    const grouped =
      orderIds.length === 0
        ? []
        : await prisma.core_order_subtransactions.groupBy({
            by: ["order_id", "status"],
            where: { order_id: { in: orderIds } },
            _count: { _all: true },
          });

    const agg: Agg = {};
    for (const row of grouped as any[]) {
      const order_id = row.order_id as string;
      const status = row.status as string;
      const c = row._count?._all ?? 0;

      if (!agg[order_id]) {
        agg[order_id] = {
          totalSubs: 0,
          success: 0,
          failed: 0,
          pending: 0,
          processing: 0,
        };
      }

      agg[order_id].totalSubs += c;

      if (status === "SUCCESS") agg[order_id].success += c;
      else if (status === "FAILED") agg[order_id].failed += c;
      else if (status === "PENDING") agg[order_id].pending += c;
      else if (status === "PROCESSING") agg[order_id].processing += c;
    }

    const items = orders.map((order: any) => {
      const a = agg[order.id] || {
        totalSubs: order._count?.core_order_subtransactions || 0,
        success: 0,
        failed: 0,
        pending: 0,
        processing: 0,
      };

      const totalSubs = a.totalSubs;
      const success = a.success;
      const failed = a.failed;
      const pending = a.pending;
      const processing = a.processing;

      // progress igual teu exemplo (baseado em SUCCESS)
      const progress = totalSubs === 0 ? 0 : Math.round((success / totalSubs) * 100);

      /**
       * Regras alinhadas com o payload que você mostrou:
       * - liquidated só “liga” quando a order estiver COMPLETED (senão fica 0 mesmo com SUCCESS=totalSubs)
       * - hasSettlement true quando liquidated > 0
       * - isSettled true quando COMPLETED e success==totalSubs
       * - hasReceipts segue o mesmo comportamento do teu exemplo (true quando settled)
       */
      const isCompleted = order.status === "COMPLETED";
      const liquidated = isCompleted ? success : 0;
      const hasSettlement = liquidated > 0;
      const isSettled = totalSubs > 0 && isCompleted && success === totalSubs;
      const hasReceipts = isSettled;

      return {
        ...order,
        stats: {
          totalSubs,
          success,
          failed,
          pending,
          processing,
          liquidated,
          hasSettlement,
          progress,
          isSettled,
          hasReceipts,
        },
      };
    });

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return {
      statusCode: 200,
      body: JSON.stringify({
        page,
        pageSize,
        total,
        totalPages,
        items,
      }),
    };
  } catch (err: any) {
    console.error("getOrdersByCustomer error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal error",
        details: err?.message || String(err),
      }),
    };
  }
};