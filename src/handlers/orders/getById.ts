import { APIGatewayProxyHandler } from "aws-lambda";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/middleware/authMiddleware";

export const getById: APIGatewayProxyHandler = async (event) => {
  try {
    verifyToken(event);

    const id = event.pathParameters?.id;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: "Order id is required" }) };

    const order = await prisma.core_orders.findUnique({
      where: { id },
      include: {
        core_order_destinations: true,
        core_order_subtransactions: {
          orderBy: { index: "asc" },
          include: {
            core_bank_accounts: true,
            core_order_destinations: true,
          },
        },
      },
    });

    if (!order) return { statusCode: 404, body: JSON.stringify({ error: "Order not found" }) };

    const subs = order.core_order_subtransactions;

    const totalSubs = subs.length;
    const success = subs.filter((s) => s.status === "SUCCESS").length;
    const failed = subs.filter((s) => s.status === "FAILED").length;
    const pending = subs.filter((s) => s.status === "PENDING").length;
    const processing = subs.filter((s) => s.status === "PROCESSING").length;

    const progress = totalSubs === 0 ? 0 : Math.round((success / totalSubs) * 100);

    return {
      statusCode: 200,
      body: JSON.stringify({
        order,
        stats: { totalSubs, success, failed, pending, processing, progress },
      }),
    };
  } catch (err: any) {
    console.error("getOrderById error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Internal error", details: err?.message || String(err) }) };
  }
};
