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

const createSupplierOrderSchema = z.object({
  id: z.string().min(6),
  customer_id: z.string().min(6),
  customer_type: z.string().min(1),
  bank_name: z.string().min(1),

  // supplier é PIX
  type: orderTypeSchema.default("TRANSFERENCIA"),

  total_amount: z.number().positive(),
  sub_amount: z.number().positive(),

  bank_account_id: z.string().min(6),

  // opcional: mas você já suporta
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
});

function chunkAmount(total: number, chunk: number): number[] {
  const res: number[] = [];
  let remaining = Number(total.toFixed(2));
  const c = Number(chunk.toFixed(2));
  while (remaining > 0) {
    const part = remaining >= c ? c : remaining;
    res.push(Number(part.toFixed(2)));
    remaining = Number((remaining - part).toFixed(2));
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

export const createSupplier: APIGatewayProxyHandler = async (event) => {
  try {
    verifyToken(event);

    const body = JSON.parse(event.body || "{}");
    const parsed = createSupplierOrderSchema.safeParse(body);

    if (!parsed.success) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid payload", details: parsed.error.flatten() }),
      };
    }

    const data = parsed.data;
    const isPix = data.type === "TRANSFERENCIA";

    // Supplier: força PIX
    if (!isPix) {
      return { statusCode: 400, body: JSON.stringify({ error: "SUPPLIER deve ser type TRANSFERENCIA (PIX)." }) };
    }

    const base_amount = data.base_amount ?? data.total_amount;
    const rate = data.rate ?? 1;
    const fees_amount = data.fees_amount ?? 0;

    const base_currency = data.base_currency ?? "BRL";
    const settlement_currency = data.settlement_currency ?? "BRL";

    // conta pagadora PAYOUT
    const payer = await prisma.core_bank_accounts.findUnique({
      where: { id: data.bank_account_id },
      select: { id: true, active: true, purpose: true, provider: true },
    });

    if (!payer) return { statusCode: 404, body: JSON.stringify({ error: "bank_account_id não encontrado" }) };
    if (!payer.active) return { statusCode: 400, body: JSON.stringify({ error: "Conta pagadora está inativa" }) };
    if (payer.purpose !== "PAYOUT") {
      return { statusCode: 400, body: JSON.stringify({ error: "bank_account_id precisa ser uma conta PAYOUT" }) };
    }

    const d0 = data.destinations[0];

    // proíbe amount no destino
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
      return { statusCode: 400, body: JSON.stringify({ error: "TRANSFERENCIA exige destination_pix_key (ou beneficiary.pix_key)." }) };
    }

    // PIX exige beneficiário (id ou inline)
    if (!d0.beneficiary_id && !d0.beneficiary) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "TRANSFERENCIA exige beneficiary_id OU beneficiary {name, document, pix_key}." }),
      };
    }

    const orderIdempotency = data.idempotency_key ?? `order_${data.id}`;

    const existing = await prisma.core_orders.findFirst({
      where: { OR: [{ id: data.id }, { idempotency_key: orderIdempotency }] },
      include: { core_order_destinations: true, core_order_subtransactions: true },
    });

    if (existing) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, order: existing, idempotent: true }) };
    }

    const created = await prisma.$transaction(async (tx) => {
      let beneficiaryId: string | null = d0.beneficiary_id ?? null;
      let beneficiaryName: string | null = null;
      let beneficiaryDocument: string | null = null;

      // inline create beneficiary + pix key
      if (!beneficiaryId && d0.beneficiary) {
        const docDigits = ensureCpfCnpjDigits(d0.beneficiary.document);
        const newBenefId = crypto.randomUUID();

        await tx.core_beneficiaries.create({
          data: { id: newBenefId, customer_id: data.customer_id, name: d0.beneficiary.name, document: docDigits },
        });

        await tx.core_beneficiary_pix_keys.create({
          data: {
            id: crypto.randomUUID(),
            beneficiary_id: newBenefId,
            key_type: (d0.beneficiary.key_type ?? "random") as any,
            key_value: d0.beneficiary.pix_key,
            label: d0.beneficiary.label ?? d0.label ?? null,
            active: true,
          },
        });

        beneficiaryId = newBenefId;
      }

      // snapshot beneficiary
      if (beneficiaryId) {
        const b = await tx.core_beneficiaries.findFirst({
          where: { id: beneficiaryId, customer_id: data.customer_id },
          select: { id: true, name: true, document: true },
        });

        if (!b) throw new Error(`beneficiary_id inválido (não encontrado ou não pertence ao customer): ${beneficiaryId}`);

        beneficiaryName = b.name;
        beneficiaryDocument = ensureCpfCnpjDigits(b.document);
      }

      // resolve pix key
      let destinationPixKey: string | null = d0.destination_pix_key ?? null;
      if (!destinationPixKey && d0.beneficiary?.pix_key) destinationPixKey = d0.beneficiary.pix_key;

      if (!destinationPixKey && beneficiaryId) {
        const k = await tx.core_beneficiary_pix_keys.findFirst({
          where: { beneficiary_id: beneficiaryId, active: true },
          orderBy: { created_at: "desc" },
          select: { key_value: true },
        });
        destinationPixKey = k?.key_value ?? null;
      }

      if (!destinationPixKey) throw new Error("Não foi possível resolver destination_pix_key para o beneficiário.");

      // cria order (kind SUPPLIER)
      const order = await tx.core_orders.create({
        data: {
          id: data.id,
          customer_id: data.customer_id,
          customer_type: data.customer_type,
          bank_name: data.bank_name,

          type: "TRANSFERENCIA" as any,
          kind: "SUPPLIER" as any,

          total_amount: data.total_amount as any,
          sub_amount: data.sub_amount as any,

          base_amount: base_amount as any,
          rate: rate as any,
          fees_amount: fees_amount as any,

          base_currency,
          settlement_currency,

          status: "PENDING",
          idempotency_key: orderIdempotency,
          metadata: data.metadata ?? null,
          locked_amount_snapshot: null,
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

          amount: null,
          destination_type: (d0.destination_type ?? "AUTO") as any,
        },
      });

      const parts = chunkAmount(data.total_amount, data.sub_amount);

      await Promise.all(
        parts.map((part, i) =>
          tx.core_order_subtransactions.create({
            data: {
              id: crypto.randomUUID(),
              order_id: order.id,
              status: "PENDING",
              amount: part as any,
              index: i + 1,
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
            },
          })
        )
      );

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
    console.error("createSupplierOrder error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Internal error", details: err?.message || String(err) }) };
  }
};
