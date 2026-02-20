// src/handlers/orders/getOrderReceipts.ts

import { APIGatewayProxyHandler } from "aws-lambda";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/middleware/authMiddleware";
import { z } from "zod";

const pathSchema = z.object({
  id: z.string().min(6),
});

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),

  // filtros opcionais
  status: z.enum(["RECEIVED", "PROCESSING", "LIQUIDATED", "FAILED", "CANCELED", "UNKNOWN"]).optional(),
  subtransaction_id: z.string().optional(),
});

export const getOrderReceipts: APIGatewayProxyHandler = async (event) => {
  try {
    verifyToken(event);

    const parsedPath = pathSchema.safeParse({
      id: event.pathParameters?.id,
    });

    if (!parsedPath.success) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid path params", details: parsedPath.error.flatten() }),
      };
    }

    const parsedQuery = querySchema.safeParse({
      page: event.queryStringParameters?.page,
      pageSize: event.queryStringParameters?.pageSize,
      status: event.queryStringParameters?.status,
      subtransaction_id: event.queryStringParameters?.subtransaction_id,
    });

    if (!parsedQuery.success) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid query params", details: parsedQuery.error.flatten() }),
      };
    }

    const { id: orderId } = parsedPath.data;
    const { page, pageSize, status, subtransaction_id } = parsedQuery.data;

    // garante que a order existe (e permite retornar 404 elegante)
    const orderExists = await prisma.core_orders.findUnique({
      where: { id: orderId },
      select: { id: true, kind: true, type: true, status: true, created_at: true },
    });

    if (!orderExists) {
      return { statusCode: 404, body: JSON.stringify({ error: "Order not found" }) };
    }

    const where: any = {
      // ✅ FIX: relation field no Prisma Client é core_order_subtransactions
      core_order_subtransactions: {
        order_id: orderId,
      },
    };

    if (status) where.status = status;
    if (subtransaction_id) where.subtransaction_id = subtransaction_id;

    const skip = (page - 1) * pageSize;
    const take = pageSize;

    const [total, receipts] = await Promise.all([
      prisma.core_payment_receipts.count({ where }),
      prisma.core_payment_receipts.findMany({
        where,
        orderBy: [{ received_at: "desc" }],
        skip,
        take,
        select: {
          id: true,
          provider: true,
          webhook_type: true,
          provider_payment_id: true,
          provider_status: true,
          status: true,
          idempotency_key: true,
          end_to_end_id: true,
          remittance_information: true,
          pix_key: true,
          amount: true,
          currency: true,
          debtor_document: true,
          debtor_name: true,
          creditor_document: true,
          creditor_name: true,
          subtransaction_id: true,
          received_at: true,
          created_at: true,
          updated_at: true,

          // ajuda muito no UI: index/amount/status da sub
          // ✅ FIX: mesmo nome aqui
          core_order_subtransactions: {
            select: {
              id: true,
              index: true,
              amount: true,
              status: true,
              settlement_status: true,
              provider_status: true,
              end_to_end_id: true,
              destination_pix_key: true,
              beneficiary_name: true,
              beneficiary_document: true,
              executed_at: true,
              settled_at: true,
            },
          },
        },
      }),
    ]);

    // stats rápidos pra UI (sem custo alto)
    const summary = receipts.reduce(
      (acc, r) => {
        const st = String(r.status || "").toUpperCase();
        acc.total += 1;
        if (st === "LIQUIDATED") acc.liquidated += 1;
        else if (st === "FAILED") acc.failed += 1;
        else if (st === "CANCELED") acc.canceled += 1;
        else if (st === "PROCESSING") acc.processing += 1;
        else if (st === "RECEIVED") acc.received += 1;
        else acc.unknown += 1;
        return acc;
      },
      {
        total: 0,
        liquidated: 0,
        failed: 0,
        canceled: 0,
        processing: 0,
        received: 0,
        unknown: 0,
      }
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        order: orderExists,
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
        summary,
        items: receipts,
      }),
    };
  } catch (err: any) {
    console.error("getOrderReceipts error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal error", details: err?.message || String(err) }),
    };
  }
};
