import { APIGatewayProxyHandler } from "aws-lambda";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/middleware/authMiddleware";
import { z } from "zod";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),

  status: z.enum(["PENDING", "IN_PROGRESS", "PAUSED", "COMPLETED", "FAILED"]).optional(),
  type: z
    .enum(["TRX", "WIRE", "USDT", "EFETIVO", "TRANSFERENCIA", "AJUSTE_SALDO", "ACERTO_IMPOSTO"])
    .optional(),
  customer_id: z.string().optional(),
});

export const getAll: APIGatewayProxyHandler = async (event) => {
  try {
    verifyToken(event);

    const parsed = querySchema.safeParse({
      page: event.queryStringParameters?.page,
      pageSize: event.queryStringParameters?.pageSize,
      status: event.queryStringParameters?.status,
      type: event.queryStringParameters?.type,
      customer_id: event.queryStringParameters?.customer_id,
    });

    if (!parsed.success) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid query params", details: parsed.error.flatten() }) };
    }

    const { page, pageSize, status, type, customer_id } = parsed.data;

    const where: any = {};
    if (status) where.status = status;
    if (type) where.type = type;
    if (customer_id) where.customer_id = customer_id;

    const skip = (page - 1) * pageSize;
    const take = pageSize;

    const [total, orders] = await Promise.all([
      prisma.core_orders.count({ where }),
      prisma.core_orders.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip,
        take,
        select: {
          id: true,
          customer_id: true,
          customer_type: true,
          bank_name: true,
          type: true,
          total_amount: true,
          sub_amount: true,
          base_amount: true,
          rate: true,
          fees_amount: true,
          base_currency: true,
          settlement_currency: true,
          status: true,
          created_at: true,
          updated_at: true,
          started_at: true,
          completed_at: true,
          last_error: true,
          idempotency_key: true,

          core_order_destinations: {
            select: {
              id: true,
              destination: true,
              destination_pix_key: true,
              label: true,
              amount: true,
              destination_type: true,
            },
            take: 3,
          },

          _count: { select: { core_order_subtransactions: true } },
        },
      }),
    ]);

    const orderIds = orders.map((o) => o.id);

    const subs = await prisma.core_order_subtransactions.findMany({
      where: { order_id: { in: orderIds } },
      select: { order_id: true, status: true },
    });

    const statsByOrder: Record<
      string,
      { totalSubs: number; success: number; failed: number; pending: number; processing: number; progress: number }
    > = {};

    for (const id of orderIds) {
      statsByOrder[id] = { totalSubs: 0, success: 0, failed: 0, pending: 0, processing: 0, progress: 0 };
    }

    for (const s of subs) {
      const st = statsByOrder[s.order_id];
      if (!st) continue;

      st.totalSubs += 1;
      if (s.status === "SUCCESS") st.success += 1;
      else if (s.status === "FAILED") st.failed += 1;
      else if (s.status === "PENDING") st.pending += 1;
      else if (s.status === "PROCESSING") st.processing += 1;
    }

    for (const id of orderIds) {
      const st = statsByOrder[id];
      st.progress = st.totalSubs === 0 ? 0 : Math.round((st.success / st.totalSubs) * 100);
    }

    const items = orders.map((o) => ({
      ...o,
      stats: statsByOrder[o.id] ?? {
        totalSubs: o._count.core_order_subtransactions,
        success: 0,
        failed: 0,
        pending: 0,
        processing: 0,
        progress: 0,
      },
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
        items,
      }),
    };
  } catch (err: any) {
    console.error("getOrders error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Internal error", details: err?.message || String(err) }) };
  }
};
