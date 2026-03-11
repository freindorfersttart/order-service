import { APIGatewayProxyHandler } from "aws-lambda";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/middleware/authMiddleware";
import { z } from "zod";

const querySchema = z.object({
  limit: z.string().optional(), // limite de "últimas transações"
});

function toInt(v: any, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function toMoney(n: number) {
  return Number(n.toFixed(2));
}

/**
 * Brasil (SP) hoje: UTC-03 (sem DST atualmente).
 * Range do "dia local" convertido para UTC:
 * - início local 00:00 => 03:00 UTC
 */
function getSaoPauloDayRange(offsetDays: number) {
  const now = new Date();
  const offsetMs = 3 * 60 * 60 * 1000;

  // "agora" em horário local SP, usando campos UTC pra evitar timezone do runtime
  const localNow = new Date(now.getTime() - offsetMs);
  const y = localNow.getUTCFullYear();
  const m = localNow.getUTCMonth();
  const d = localNow.getUTCDate() + offsetDays;

  // local midnight => UTC +03:00
  const start = new Date(Date.UTC(y, m, d, 3, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, d + 1, 3, 0, 0, 0));

  return { start, end };
}

function pctChange(today: number, yesterday: number) {
  if (!Number.isFinite(today) || !Number.isFinite(yesterday)) return null;
  if (yesterday === 0) return today === 0 ? 0 : 100;
  return Number((((today - yesterday) / yesterday) * 100).toFixed(1));
}

export const getDashboardOverview: APIGatewayProxyHandler = async (event) => {
  try {
    verifyToken(event);

    const q = event.queryStringParameters || {};
    const parsedQ = querySchema.safeParse(q);
    if (!parsedQ.success) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid query", details: parsedQ.error.flatten() }) };
    }

    const limit = Math.min(Math.max(toInt(parsedQ.data.limit, 8), 5), 20);

    const today = getSaoPauloDayRange(0);
    const yesterday = getSaoPauloDayRange(-1);

    const [
      // Saldo disponível total
      sumBalances,
      // Clientes ativos
      activeCustomers,
      activeCustomersNoSupplier,

      // Recebimentos hoje/ontem (por status)
      incomingToday,
      incomingYesterday,

      // Ordens hoje/ontem
      ordersToday,
      ordersYesterday,

      // Últimas transações + customer name
      lastTransactions,
    ] = await prisma.$transaction([
      prisma.core_balances.aggregate({
        _sum: { available_amount: true },
      }),

      prisma.core_customers.count({
        where: { is_active: true },
      }),

      prisma.core_customers.count({
        where: { is_active: true, type: { in: ["pf", "pj"] as any } },
      }),

      prisma.core_incoming_pix.groupBy({
        by: ["status"],
        where: { created_at: { gte: today.start, lt: today.end } },
        _sum: { amount: true },
        _count: { _all: true },
      }),

      prisma.core_incoming_pix.groupBy({
        by: ["status"],
        where: { created_at: { gte: yesterday.start, lt: yesterday.end } },
        _sum: { amount: true },
        _count: { _all: true },
      }),

      prisma.core_orders.groupBy({
        by: ["kind", "status"],
        where: {
          created_at: { gte: today.start, lt: today.end },
          // opcional: no dashboard "Orders Hoje" normalmente é saída, então exclui OTC
          kind: { in: ["BULK", "ADHOC", "SUPPLIER"] as any },
        },
        _sum: { total_amount: true },
        _count: { _all: true },
      }),

      prisma.core_orders.groupBy({
        by: ["kind", "status"],
        where: {
          created_at: { gte: yesterday.start, lt: yesterday.end },
          kind: { in: ["BULK", "ADHOC", "SUPPLIER"] as any },
        },
        _sum: { total_amount: true },
        _count: { _all: true },
      }),

      prisma.core_transactions.findMany({
        orderBy: { created_at: "desc" as any },
        take: limit,
        select: {
          id: true,
          customer_id: true,
          type: true,
          amount: true,
          description: true,
          reason_code: true,
          created_at: true,
          metadata: true,
          subtransaction_id: true,
          core_customers: { select: { name: true } },
        },
      }),
    ]);

    const saldoDisponivel = toMoney(Number(sumBalances?._sum?.available_amount ?? 0));

    const mapGroup = (rows: any[]) =>
      rows.reduce(
        (acc: any, r: any) => {
          const key = String(r.status);
          acc.byStatus[key] = {
            count: r._count?._all ?? 0,
            amount: toMoney(Number(r._sum?.amount ?? 0)),
          };
          acc.totalCount += r._count?._all ?? 0;
          acc.totalAmount = toMoney(acc.totalAmount + Number(r._sum?.amount ?? 0));
          return acc;
        },
        { totalCount: 0, totalAmount: 0, byStatus: {} as Record<string, { count: number; amount: number }> }
      );

    const incT = mapGroup(incomingToday as any);
    const incY = mapGroup(incomingYesterday as any);

    const mapOrders = (rows: any[]) =>
      rows.reduce(
        (acc: any, r: any) => {
          const kind = String(r.kind);
          const status = String(r.status);
          const amount = toMoney(Number(r._sum?.total_amount ?? 0));
          const count = r._count?._all ?? 0;

          if (!acc.byKind[kind]) acc.byKind[kind] = { totalAmount: 0, totalCount: 0, byStatus: {} as any };
          acc.byKind[kind].byStatus[status] = { count, amount };
          acc.byKind[kind].totalAmount = toMoney(acc.byKind[kind].totalAmount + amount);
          acc.byKind[kind].totalCount += count;

          acc.totalAmount = toMoney(acc.totalAmount + amount);
          acc.totalCount += count;

          return acc;
        },
        { totalAmount: 0, totalCount: 0, byKind: {} as any }
      );

    const ordT = mapOrders(ordersToday as any);
    const ordY = mapOrders(ordersYesterday as any);

    const txs = (lastTransactions as any[]).map((t) => {
      const customerName = t.core_customers?.name ?? "—";
      const amount = toMoney(Number(t.amount ?? 0));
      const direction = t.type === "credit" || t.type === "hide_credit" ? "IN" : "OUT";

      // tentativas de extrair “banco” e “status” de metadata (pra UI)
      const meta = (t.metadata ?? {}) as any;
      const bankLabel =
        meta?.bank_name ||
        meta?.bank ||
        meta?.provider ||
        meta?.integration ||
        (direction === "IN" ? "Recebimento" : "Saída");

      const uiStatus =
        meta?.provider_status ||
        meta?.settlement_status ||
        meta?.status ||
        (t.type === "debit" ? "Confirmado" : "Confirmado");

      return {
        id: t.id,
        customer_id: t.customer_id,
        customer_name: customerName,
        direction, // IN | OUT
        amount,
        created_at: t.created_at,
        description: t.description ?? null,
        reason_code: t.reason_code ?? null,
        bank_label: bankLabel,
        status_label: uiStatus,
      };
    });

    const payload = {
      ok: true,
      generated_at: new Date().toISOString(),

      ranges: {
        today: { start: today.start.toISOString(), end: today.end.toISOString() },
        yesterday: { start: yesterday.start.toISOString(), end: yesterday.end.toISOString() },
      },

      cards: {
        saldo_disponivel_total: {
          value: saldoDisponivel,
          vs_yesterday_pct: null, // saldo não faz sentido vs ontem sem snapshot; deixa null
        },

        clientes_ativos: {
          value: activeCustomersNoSupplier,
          value_including_suppliers: activeCustomers,
          vs_yesterday_pct: null, // opcional implementar se quiser (count ontem)
        },

        recebimentos_hoje: {
          value: incT.totalAmount,
          count: incT.totalCount,
          by_status: incT.byStatus,
          vs_ontem_pct: pctChange(incT.totalAmount, incY.totalAmount),
        },

        ordens_hoje: {
          value: ordT.totalAmount,
          count: ordT.totalCount,
          by_kind: ordT.byKind,
          vs_ontem_pct: pctChange(ordT.totalAmount, ordY.totalAmount),
        },
      },

      last_transactions: txs,
    };

    return { statusCode: 200, body: JSON.stringify(payload) };
  } catch (err: any) {
    console.error("getDashboardOverview error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Internal error", details: err?.message || String(err) }) };
  }
};