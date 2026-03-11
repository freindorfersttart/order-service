import { APIGatewayProxyHandler } from "aws-lambda";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import crypto from "crypto";
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

const destinationTypeSchema = z.enum(["AUTO", "PIX", "WALLET", "IBAN", "ACCOUNT"]).optional();
const pixKeyTypeSchema = z.enum(["cpf", "cnpj", "email", "phone", "random"]).optional();

const beneficiaryInlineSchema = z.object({
  name: z.string().min(2),
  document: z.string().min(11),
  pix_key: z.string().min(3),
  key_type: pixKeyTypeSchema,
  label: z.string().optional(),
});

// ✅ V2: supplier_id (aceita supplier.id OU supplier.customer_id como fallback)
const createSupplierOrderV2Schema = z
  .object({
    id: z.string().min(6),
    supplier_id: z.string().min(6),

    bank_name: z.string().min(1),
    bank_account_id: z.string().min(6),

    type: orderTypeSchema.default("TRANSFERENCIA"),

    total_amount: z.number().positive(),
    sub_amount: z.number().positive(),

    base_amount: z.number().nonnegative().optional(),
    rate: z.number().positive().optional(),
    fees_amount: z.number().nonnegative().optional(),
    base_currency: z.string().optional(),
    settlement_currency: z.string().optional(),

    idempotency_key: z.string().optional(),
    metadata: z.any().optional(),

    destinations: z
      .array(
        z.object({
          destination: z.string().optional(),
          destination_pix_key: z.string().optional(),
          label: z.string().optional(),

          beneficiary_id: z.string().optional(),
          beneficiary: beneficiaryInlineSchema.optional(),

          amount: z.number().positive().optional(), // proibido aqui
          destination_type: destinationTypeSchema,
        })
      )
      .length(1),
  })
  .strict();

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
    throw new Error(`beneficiary.document deve ser CPF(11) ou CNPJ(14). Recebido: ${doc}`);
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

function normalizePixKey(key: string, keyType?: string | null) {
  const raw = (key || "").trim();
  if (!raw) return raw;

  const d = digitsOnly(raw);

  if (keyType === "cpf" || keyType === "cnpj") return d;

  if (keyType === "phone") {
    if (d.length < 10 || d.length > 15) {
      throw new Error(`beneficiary.pix_key phone inválida: ${key}`);
    }
    return `+${d}`;
  }

  if ((d.length === 11 || d.length === 14) && d !== raw) return d;

  return raw;
}

function pickOperator(metadata: any) {
  const name = metadata?.operator_name ? String(metadata.operator_name).trim() : null;
  const email = metadata?.operator_email ? String(metadata.operator_email).trim() : null;
  return { name: name || null, email: email || null };
}

function buildAudit(event: any, auth?: any) {
  const method = event?.requestContext?.http?.method || event?.httpMethod || null;
  const path = event?.requestContext?.http?.path || event?.path || null;
  const requestId = event?.requestContext?.requestId || null;
  const ip = event?.requestContext?.http?.sourceIp || null;
  const ua = event?.headers?.["user-agent"] || event?.headers?.["User-Agent"] || null;

  const actorUserId = auth?.sub || auth?.user_id || auth?.id || null;

  return {
    actor: actorUserId ? { type: "user", user_id: actorUserId } : { type: "unknown", user_id: null },
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

export const createSupplierV2: APIGatewayProxyHandler = async (event) => {
  try {
    const auth = (verifyToken(event) as any) || undefined;

    const body = JSON.parse(event.body || "{}");
    const parsed = createSupplierOrderV2Schema.safeParse(body);

    if (!parsed.success) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid payload", details: parsed.error.flatten() }),
      };
    }

    const data = parsed.data;

    if (data.type !== "TRANSFERENCIA") {
      return { statusCode: 400, body: JSON.stringify({ error: "SUPPLIER deve ser type TRANSFERENCIA (PIX)." }) };
    }

    const payer = await prisma.core_bank_accounts.findUnique({
      where: { id: data.bank_account_id },
      select: { id: true, active: true, purpose: true, provider: true },
    });

    if (!payer) return { statusCode: 404, body: JSON.stringify({ error: "bank_account_id não encontrado" }) };
    if (!payer.active) return { statusCode: 400, body: JSON.stringify({ error: "Conta pagadora está inativa" }) };
    if (payer.purpose !== "PAYOUT") {
      return { statusCode: 400, body: JSON.stringify({ error: "bank_account_id precisa ser uma conta PAYOUT" }) };
    }

    // ✅ resolve supplier por:
    // 1) core_suppliers.id (supplier_id real)
    // 2) core_suppliers.customer_id (quando o front manda customer.id do tipo supplier)
    let supplier = await prisma.core_suppliers.findUnique({
      where: { id: data.supplier_id },
      select: { id: true, name: true, customer_id: true, is_active: true },
    });

    if (!supplier) {
      supplier = await prisma.core_suppliers.findFirst({
        where: { customer_id: data.supplier_id },
        select: { id: true, name: true, customer_id: true, is_active: true },
      });
    }

    if (!supplier) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "supplier_id não encontrado (nem por id nem por customer_id)" }),
      };
    }
    if (!supplier.is_active) return { statusCode: 400, body: JSON.stringify({ error: "Fornecedor está inativo" }) };
    if (!supplier.customer_id) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Fornecedor sem customer_id vinculado (rode update supplier para curar)" }),
      };
    }

    const customerId = supplier.customer_id;

    const supplierCustomer = await prisma.core_customers.findUnique({
      where: { id: customerId },
      select: { id: true, type: true, is_active: true },
    });

    if (!supplierCustomer) {
      return { statusCode: 400, body: JSON.stringify({ error: "customer_id vinculado ao fornecedor não existe" }) };
    }
    if (supplierCustomer.type !== ("supplier" as any)) {
      return { statusCode: 400, body: JSON.stringify({ error: "customer vinculado não é do tipo supplier" }) };
    }
    if (!supplierCustomer.is_active) {
      return { statusCode: 400, body: JSON.stringify({ error: "customer (supplier) está inativo" }) };
    }

    const d0 = data.destinations[0];

    if (d0.amount != null) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Nesta versão não use amount em destinations. Use total_amount + sub_amount (fracionamento automático).",
        }),
      };
    }

    const hasPix = !!d0.destination_pix_key || !!d0.beneficiary?.pix_key;
    const hasGeneric = !!d0.destination;

    if (hasPix && hasGeneric) {
      return { statusCode: 400, body: JSON.stringify({ error: "Use destination_pix_key OU destination (não ambos)." }) };
    }
    if (!hasPix) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "TRANSFERENCIA exige destination_pix_key (ou beneficiary.pix_key)." }),
      };
    }

    if (!d0.beneficiary_id && !d0.beneficiary) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "TRANSFERENCIA exige beneficiary_id OU beneficiary {name, document, pix_key}." }),
      };
    }

    const total_amount = toMoney(data.total_amount);
    const orderIdempotency = data.idempotency_key ?? `order_${data.id}`;

    const existing = await prisma.core_orders.findFirst({
      where: { OR: [{ id: data.id }, { idempotency_key: orderIdempotency }] },
      include: { core_order_destinations: true, core_order_subtransactions: true },
    });

    if (existing) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, order: existing, idempotent: true }) };
    }

    const operator = pickOperator(data.metadata);
    const auditMeta = buildAudit(event, auth);

    const base_amount = data.base_amount ?? total_amount;
    const rate = data.rate ?? 1;
    const fees_amount = data.fees_amount ?? 0;

    const base_currency = data.base_currency ?? "BRL";
    const settlement_currency = data.settlement_currency ?? "BRL";

    const created = await prisma.$transaction(async (tx) => {
      const bal = await tx.core_balances.findUnique({
        where: { customer_id: customerId },
        select: {
          id: true,
          available_amount: true,
          credit_limit: true,
          locked_cash_amount: true,
          locked_credit_amount: true,
        },
      });

      if (!bal) throw new Error("Saldo do supplier (customer) não encontrado (core_balances).");

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
        where: { customer_id: customerId },
        data: {
          available_amount: newAvailable as any,
          locked_cash_amount: newLockedCash as any,
          locked_credit_amount: newLockedCredit as any,
          locked_amount: newLockedTotal as any,
          updated_at: new Date() as any,
        },
      });

      if (split.fromCash > 0) {
        await tx.core_transactions.create({
          data: {
            id: crypto.randomUUID(),
            customer_id: customerId,
            type: "lock" as any,
            amount: split.fromCash as any,
            description: `SUPPLIER - lock saldo`,
            metadata: {
              order_id: data.id,
              kind: "SUPPLIER",
              source: "cash",
              supplier_id: supplier.id,
              supplier_name: supplier.name,
              operator,
              ...auditMeta,
            },
          },
        });
      }
      if (split.fromCredit > 0) {
        await tx.core_transactions.create({
          data: {
            id: crypto.randomUUID(),
            customer_id: customerId,
            type: "lock" as any,
            amount: split.fromCredit as any,
            description: `SUPPLIER - lock limite`,
            metadata: {
              order_id: data.id,
              kind: "SUPPLIER",
              source: "credit",
              supplier_id: supplier.id,
              supplier_name: supplier.name,
              operator,
              ...auditMeta,
            },
          },
        });
      }

      let beneficiaryId: string | null = d0.beneficiary_id ?? null;
      let beneficiaryName: string | null = null;
      let beneficiaryDocument: string | null = null;

      if (!beneficiaryId && d0.beneficiary) {
        const docDigits = ensureCpfCnpjDigits(d0.beneficiary.document);
        const newBenefId = crypto.randomUUID();

        const normalizedPixKey = normalizePixKey(d0.beneficiary.pix_key, d0.beneficiary.key_type ?? null);

        await tx.core_beneficiaries.create({
          data: { id: newBenefId, customer_id: customerId, name: d0.beneficiary.name, document: docDigits },
        });

        await tx.core_beneficiary_pix_keys.create({
          data: {
            id: crypto.randomUUID(),
            beneficiary_id: newBenefId,
            key_type: (d0.beneficiary.key_type ?? "random") as any,
            key_value: normalizedPixKey,
            label: d0.beneficiary.label ?? d0.label ?? null,
            active: true,
          },
        });

        beneficiaryId = newBenefId;
      }

      if (beneficiaryId) {
        const b = await tx.core_beneficiaries.findFirst({
          where: { id: beneficiaryId, customer_id: customerId },
          select: { id: true, name: true, document: true },
        });

        if (!b) throw new Error(`beneficiary_id inválido (não encontrado ou não pertence ao supplier): ${beneficiaryId}`);

        beneficiaryName = b.name;
        beneficiaryDocument = ensureCpfCnpjDigits(b.document);
      }

      let destinationPixKey: string | null = d0.destination_pix_key ?? null;
      let destinationPixKeyType: string | null = null;

      if (!destinationPixKey && d0.beneficiary?.pix_key) {
        destinationPixKey = d0.beneficiary.pix_key;
        destinationPixKeyType = (d0.beneficiary.key_type as any) ?? null;
      }

      if (!destinationPixKey && beneficiaryId) {
        const k = await tx.core_beneficiary_pix_keys.findFirst({
          where: { beneficiary_id: beneficiaryId, active: true },
          orderBy: { created_at: "desc" },
          select: { key_value: true, key_type: true },
        });
        destinationPixKey = k?.key_value ?? null;
        destinationPixKeyType = (k?.key_type as any) ?? null;
      }

      if (!destinationPixKey) throw new Error("Não foi possível resolver destination_pix_key para o beneficiário.");

      destinationPixKey = normalizePixKey(destinationPixKey, destinationPixKeyType);

      const order = await tx.core_orders.create({
        data: {
          id: data.id,
          customer_id: customerId,
          customer_type: "supplier",
          bank_name: data.bank_name,

          type: "TRANSFERENCIA" as any,
          kind: "SUPPLIER" as any,

          supplier_id: supplier.id,

          total_amount: total_amount as any,
          sub_amount: data.sub_amount as any,

          base_amount: base_amount as any,
          rate: rate as any,
          fees_amount: fees_amount as any,

          base_currency,
          settlement_currency,

          status: "PENDING",
          idempotency_key: orderIdempotency,
          metadata: {
            ...(data.metadata ?? {}),
            operator,
            ...auditMeta,
            locks: {
              total: split.total,
              cash: split.fromCash,
              credit: split.fromCredit,
            },
            supplier: {
              supplier_id: supplier.id,
              supplier_name: supplier.name,
            },
          } as any,
          locked_amount_snapshot: newLockedTotal as any,
          started_at: null,
          completed_at: null,
          last_error: null,
          updated_at: new Date() as any,
        },
      });

      const destination = await tx.core_order_destinations.create({
        data: {
          id: crypto.randomUUID(),
          order_id: order.id,
          destination: d0.destination ?? "",
          destination_pix_key: destinationPixKey,
          label: d0.label ?? null,

          beneficiary_id: beneficiaryId,
          beneficiary_name: beneficiaryName,
          beneficiary_document: beneficiaryDocument,

          amount: total_amount as any,
          destination_type: (d0.destination_type ?? "PIX") as any,
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

            destination_id: destination.id,
            destination_pix_key: destination.destination_pix_key ?? null,
            destination: destination.destination ?? null,

            beneficiary_name: beneficiaryName,
            beneficiary_document: beneficiaryDocument,

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
    console.error("createSupplierV2 error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal error", details: err?.message || String(err) }),
    };
  }
};