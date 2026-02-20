import { APIGatewayProxyHandler } from "aws-lambda";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import crypto from "crypto";
import { verifyToken } from "@/middleware/authMiddleware";

const pixKeyTypeSchema = z.enum(["cpf", "cnpj", "email", "phone", "random"]).optional();

const createAdhocSchema = z.object({
  id: z.string().min(6),
  customer_id: z.string().min(6),
  customer_type: z.string().min(1),
  bank_name: z.string().min(1),
  bank_account_id: z.string().min(6),

  sub_amount: z.number().positive(),
  amount: z.number().positive(), // 👈 avulsa é 1 pagamento só

  pix_key: z.string().min(3),
  key_type: pixKeyTypeSchema,

  label: z.string().optional(),
  beneficiary_name: z.string().min(2).optional(),
  beneficiary_document: z.string().min(11).optional(),

  idempotency_key: z.string().optional(),
  metadata: z.any().optional(),
});

function toMoney(n: number) {
  return Number(Number(n).toFixed(2));
}

function chunkAmount(total: number, chunk: number): number[] {
  const res: number[] = [];
  let remaining = toMoney(total);
  const c = toMoney(chunk);

  while (remaining > 0) {
    const part = remaining >= c ? c : remaining;
    res.push(toMoney(part));
    remaining = toMoney(remaining - part);
  }
  return res;
}

function digitsOnly(v: string) {
  return (v || "").replace(/\D/g, "");
}

function ensureCpfCnpjDigits(doc: string) {
  const d = digitsOnly(doc);
  if (!(d.length === 11 || d.length === 14)) {
    throw new Error(`beneficiary_document deve ser CPF(11) ou CNPJ(14). Recebido: ${doc}`);
  }
  return d;
}

type LockResult = {
  total: number;
  fromCash: number;
  fromCredit: number;
};

function calcLockSplit(params: {
  amount: number;
  available: number;
  creditLimit: number;
  lockedCredit: number;
}): LockResult {
  const { amount, available, creditLimit, lockedCredit } = params;

  const total = toMoney(amount);
  const av = toMoney(available);

  const creditFree = toMoney(creditLimit - lockedCredit);

  const utilizable = toMoney(av + creditFree);
  if (utilizable < total) {
    throw new Error(`Saldo insuficiente. Utilizável: ${utilizable} < Total: ${total}`);
  }

  const fromCash = toMoney(Math.min(av, total));
  const fromCredit = toMoney(total - fromCash);

  if (fromCredit > creditFree) {
    throw new Error(`Limite insuficiente. Crédito livre: ${creditFree} < Necessário: ${fromCredit}`);
  }

  return { total, fromCash, fromCredit };
}

// ✅ normaliza PIX key (remove prefixos tipo "cnpj:" e ajusta conforme key_type)
function normalizePixKey(raw: string, keyType?: "cpf" | "cnpj" | "email" | "phone" | "random") {
  const v = String(raw || "").trim();
  if (!v) throw new Error("pix_key vazia");

  const noPrefix = v.replace(/^(cpf|cnpj|email|phone|random)\s*:\s*/i, "").trim();

  if (keyType === "cpf" || keyType === "cnpj") {
    const d = digitsOnly(noPrefix);
    if (keyType === "cpf" && d.length !== 11) throw new Error(`PIX CPF inválida: ${raw}`);
    if (keyType === "cnpj" && d.length !== 14) throw new Error(`PIX CNPJ inválida: ${raw}`);
    return d;
  }

  if (keyType === "phone") {
    const d = digitsOnly(noPrefix);
    if (d.length < 10 || d.length > 13) throw new Error(`PIX phone inválida: ${raw}`);
    return d;
  }

  if (keyType === "email") {
    const e = noPrefix.toLowerCase();
    if (!e.includes("@")) throw new Error(`PIX email inválida: ${raw}`);
    return e;
  }

  if (keyType === "random") return noPrefix;

  const maybeDigits = digitsOnly(noPrefix);
  if (maybeDigits.length === 11 || maybeDigits.length === 14) return maybeDigits;
  if (noPrefix.includes("@")) return noPrefix.toLowerCase();
  if (maybeDigits.length >= 10 && maybeDigits.length <= 13) return maybeDigits;
  return noPrefix;
}

export const createAdhoc: APIGatewayProxyHandler = async (event) => {
  try {
    verifyToken(event);

    const body = JSON.parse(event.body || "{}");
    const parsed = createAdhocSchema.safeParse(body);

    if (!parsed.success) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid payload", details: parsed.error.flatten() }),
      };
    }

    const data = parsed.data;

    const payer = await prisma.core_bank_accounts.findUnique({
      where: { id: data.bank_account_id },
      select: { id: true, active: true, purpose: true, provider: true },
    });

    if (!payer) return { statusCode: 404, body: JSON.stringify({ error: "bank_account_id não encontrado" }) };
    if (!payer.active) return { statusCode: 400, body: JSON.stringify({ error: "Conta pagadora está inativa" }) };
    if (payer.purpose !== "PAYOUT") {
      return { statusCode: 400, body: JSON.stringify({ error: "bank_account_id precisa ser uma conta PAYOUT" }) };
    }

    const total_amount = toMoney(data.amount);
    const orderIdempotency = data.idempotency_key ?? `order_${data.id}`;

    const existing = await prisma.core_orders.findFirst({
      where: { OR: [{ id: data.id }, { idempotency_key: orderIdempotency }] },
      include: { core_order_destinations: true, core_order_subtransactions: true },
    });

    if (existing) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, order: existing, idempotent: true }) };
    }

    const created = await prisma.$transaction(async (tx) => {
      // =========================================================
      // ✅ trava saldo do customer usando saldo + limite
      // =========================================================
      const bal = await tx.core_balances.findUnique({
        where: { customer_id: data.customer_id },
        select: {
          id: true,
          available_amount: true,
          credit_limit: true,
          locked_amount: true,
          locked_cash_amount: true,
          locked_credit_amount: true,
        },
      });

      if (!bal) throw new Error("Saldo do customer não encontrado (core_balances).");

      const available = Number(bal.available_amount);
      const creditLimit = Number(bal.credit_limit);
      const lockedCash = Number((bal as any).locked_cash_amount ?? 0);
      const lockedCredit = Number((bal as any).locked_credit_amount ?? 0);

      const split = calcLockSplit({
        amount: total_amount,
        available,
        creditLimit,
        lockedCredit,
      });

      const newAvailable = toMoney(available - split.fromCash);
      const newLockedCash = toMoney(lockedCash + split.fromCash);
      const newLockedCredit = toMoney(lockedCredit + split.fromCredit);
      const newLockedTotal = toMoney(newLockedCash + newLockedCredit);

      await tx.core_balances.update({
        where: { customer_id: data.customer_id },
        data: {
          available_amount: newAvailable as any,
          locked_cash_amount: newLockedCash as any,
          locked_credit_amount: newLockedCredit as any,
          locked_amount: newLockedTotal as any,
        },
      });

      // registra transações lock (cash e/ou credit)
      if (split.fromCash > 0) {
        await tx.core_transactions.create({
          data: {
            id: crypto.randomUUID(),
            customer_id: data.customer_id,
            type: "lock" as any,
            amount: split.fromCash as any,
            description: `ADHOC - lock saldo`,
            metadata: { order_id: data.id, kind: "ADHOC", source: "cash" },
          },
        });
      }
      if (split.fromCredit > 0) {
        await tx.core_transactions.create({
          data: {
            id: crypto.randomUUID(),
            customer_id: data.customer_id,
            type: "lock" as any,
            amount: split.fromCredit as any,
            description: `ADHOC - lock limite`,
            metadata: { order_id: data.id, kind: "ADHOC", source: "credit" },
          },
        });
      }

      // =========================================================
      // cria order ADHOC (continua PENDING; só COMPLETED com baixa financeira)
      // =========================================================
      const order = await tx.core_orders.create({
        data: {
          id: data.id,
          customer_id: data.customer_id,
          customer_type: data.customer_type,
          bank_name: data.bank_name,

          type: "TRANSFERENCIA" as any,
          kind: "ADHOC" as any,

          total_amount: total_amount as any,
          sub_amount: data.sub_amount as any,

          base_amount: total_amount as any,
          rate: 1 as any,
          fees_amount: 0 as any,

          base_currency: "BRL",
          settlement_currency: "BRL",

          status: "PENDING",
          idempotency_key: orderIdempotency,
          metadata: {
            ...(data.metadata ?? {}),
            locks: {
              total: split.total,
              cash: split.fromCash,
              credit: split.fromCredit,
            },
            adhoc: {
              label: data.label ?? null,
            },
          },
          locked_amount_snapshot: newLockedTotal as any,
          started_at: null,
          completed_at: null,
          last_error: null,
          updated_at: new Date() as any,
        },
      });

      // =========================================================
      // destination + subtransactions
      // =========================================================
      const pixKey = normalizePixKey(data.pix_key, data.key_type as any);

      const benDoc = data.beneficiary_document ? ensureCpfCnpjDigits(data.beneficiary_document) : null;
      const benName = data.beneficiary_name ?? null;

      const dest = await tx.core_order_destinations.create({
        data: {
          id: crypto.randomUUID(),
          order_id: order.id,
          destination: "",
          destination_pix_key: pixKey,
          label: data.label ?? null,

          beneficiary_id: null,
          beneficiary_name: benName,
          beneficiary_document: benDoc,

          amount: total_amount as any,
          destination_type: "PIX" as any,
        },
      });

      const parts = chunkAmount(total_amount, data.sub_amount);

      let globalIndex = 1;
      let remainingCash = toMoney(split.fromCash);
      let remainingCredit = toMoney(split.fromCredit);

      for (const part of parts) {
        const partMoney = toMoney(part);

        const fromCash = toMoney(Math.min(remainingCash, partMoney));
        const fromCredit = toMoney(partMoney - fromCash);

        remainingCash = toMoney(remainingCash - fromCash);
        remainingCredit = toMoney(remainingCredit - fromCredit);

        if (remainingCash < -0.0001 || remainingCredit < -0.0001) {
          throw new Error("Erro ao alocar lock por subtransaction (saldo/limite ficou negativo).");
        }

        await tx.core_order_subtransactions.create({
          data: {
            id: crypto.randomUUID(),
            order_id: order.id,
            status: "PENDING",
            amount: partMoney as any,
            index: globalIndex++,
            bank_account_id: data.bank_account_id,

            destination_id: dest.id,
            destination_pix_key: dest.destination_pix_key ?? null,
            destination: null,

            beneficiary_name: benName,
            beneficiary_document: benDoc,

            idempotency_key: crypto.randomUUID(),

            attempts: 0,
            next_retry_at: null,
            execution_metadata: null,
            last_error: null,
            provider_ref: null,
            executed_at: null,
            updated_at: new Date() as any,

            locked_from_available: fromCash as any,
            locked_from_credit: fromCredit as any,
            financial_settled_at: null,
            financial_settlement_receipt_id: null,
            financial_settlement_status: null,
          },
        });
      }

      const cashAbs = Math.abs(toMoney(remainingCash));
      const creditAbs = Math.abs(toMoney(remainingCredit));
      if (cashAbs > 0.01 || creditAbs > 0.01) {
        throw new Error(
          `Erro de alocação do lock. Sobra cash=${remainingCash} credit=${remainingCredit} (tolerância 0.01)`
        );
      }

      const full = await tx.core_orders.findUnique({
        where: { id: order.id },
        include: {
          core_order_destinations: true,
          core_order_subtransactions: { orderBy: { index: "asc" } },
        },
      });

      return full!;
    });

    return { statusCode: 201, body: JSON.stringify({ ok: true, order: created }) };
  } catch (err: any) {
    console.error("createAdhoc error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal error", details: err?.message || String(err) }),
    };
  }
};
