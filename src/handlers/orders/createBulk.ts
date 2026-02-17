import { APIGatewayProxyHandler } from "aws-lambda";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import crypto from "crypto";
import { verifyToken } from "@/middleware/authMiddleware";

const pixKeyTypeSchema = z.enum(["cpf", "cnpj", "email", "phone", "random"]).optional();

const bulkItemSchema = z.object({
  amount: z.number().positive(),
  destination_pix_key: z.string().min(3).optional(),
  pix_key: z.string().min(3).optional(), // alias

  label: z.string().optional(),

  // snapshots para receipt/OnlyUp
  beneficiary_name: z.string().min(2).optional(),
  beneficiary_document: z.string().min(11).optional(),
  key_type: pixKeyTypeSchema,
});

const createBulkSchema = z.object({
  id: z.string().min(6),
  customer_id: z.string().min(6),
  customer_type: z.string().min(1),
  bank_name: z.string().min(1),

  bank_account_id: z.string().min(6),

  // chunk (ex 14900)
  sub_amount: z.number().positive(),

  // se não vier, somamos dos items
  total_amount: z.number().positive().optional(),

  idempotency_key: z.string().optional(),
  metadata: z.any().optional(),

  items: z.array(bulkItemSchema).min(1),
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
    throw new Error(`beneficiary_document deve ser CPF(11) ou CNPJ(14). Recebido: ${doc}`);
  }
  return d;
}

// ✅ NOVO: normaliza PIX key (remove prefixos tipo "cnpj:" e ajusta conforme key_type)
function normalizePixKey(raw: string, keyType?: "cpf" | "cnpj" | "email" | "phone" | "random") {
  const v = String(raw || "").trim();
  if (!v) throw new Error("pix_key vazia");

  // remove prefixos comuns: "cnpj:", "cpf:", "email:", "phone:", "random:" (case-insensitive)
  const noPrefix = v.replace(/^(cpf|cnpj|email|phone|random)\s*:\s*/i, "").trim();

  // se o caller informou key_type, respeita
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

  if (keyType === "random") {
    // EVP costuma vir com hífens; mantém como está (só tira espaços/prefixo)
    return noPrefix;
  }

  // fallback por heurística (quando key_type não vier)
  const maybeDigits = digitsOnly(noPrefix);
  if (maybeDigits.length === 11 || maybeDigits.length === 14) return maybeDigits; // cpf/cnpj
  if (noPrefix.includes("@")) return noPrefix.toLowerCase(); // email
  if (maybeDigits.length >= 10 && maybeDigits.length <= 13) return maybeDigits; // phone
  return noPrefix; // random/evp
}

export const createBulk: APIGatewayProxyHandler = async (event) => {
  try {
    verifyToken(event);

    const body = JSON.parse(event.body || "{}");
    const parsed = createBulkSchema.safeParse(body);

    if (!parsed.success) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid payload", details: parsed.error.flatten() }),
      };
    }

    const data = parsed.data;

    // valida conta pagadora PAYOUT
    const payer = await prisma.core_bank_accounts.findUnique({
      where: { id: data.bank_account_id },
      select: { id: true, active: true, purpose: true, provider: true },
    });

    if (!payer) return { statusCode: 404, body: JSON.stringify({ error: "bank_account_id não encontrado" }) };
    if (!payer.active) return { statusCode: 400, body: JSON.stringify({ error: "Conta pagadora está inativa" }) };
    if (payer.purpose !== "PAYOUT") {
      return { statusCode: 400, body: JSON.stringify({ error: "bank_account_id precisa ser uma conta PAYOUT" }) };
    }

    const total_amount =
      data.total_amount ??
      Number(data.items.reduce((sum, it) => sum + Number(it.amount), 0).toFixed(2));

    const orderIdempotency = data.idempotency_key ?? `order_${data.id}`;

    const existing = await prisma.core_orders.findFirst({
      where: { OR: [{ id: data.id }, { idempotency_key: orderIdempotency }] },
      include: { core_order_destinations: true, core_order_subtransactions: true },
    });

    if (existing) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, order: existing, idempotent: true }) };
    }

    const created = await prisma.$transaction(async (tx) => {
      // cria order BULK
      const order = await tx.core_orders.create({
        data: {
          id: data.id,
          customer_id: data.customer_id,
          customer_type: data.customer_type,
          bank_name: data.bank_name,

          type: "TRANSFERENCIA" as any,
          kind: "BULK" as any,

          total_amount: total_amount as any,
          sub_amount: data.sub_amount as any,

          base_amount: total_amount as any,
          rate: 1 as any,
          fees_amount: 0 as any,

          base_currency: "BRL",
          settlement_currency: "BRL",

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

      // index global das subtransactions
      let globalIndex = 1;

      for (const item of data.items) {
        const pixKeyRaw = item.destination_pix_key ?? item.pix_key;
        if (!pixKeyRaw) throw new Error("Item inválido: precisa destination_pix_key ou pix_key.");

        // ✅ aplica normalização (remove "cnpj:" etc)
        const pixKey = normalizePixKey(pixKeyRaw, item.key_type as any);

        const benDoc = item.beneficiary_document ? ensureCpfCnpjDigits(item.beneficiary_document) : null;
        const benName = item.beneficiary_name ?? null;

        // cria destination por linha da planilha (com amount permitido)
        const dest = await tx.core_order_destinations.create({
          data: {
            id: crypto.randomUUID(),
            order_id: order.id,
            destination: "",
            destination_pix_key: pixKey,
            label: item.label ?? null,

            beneficiary_id: null,
            beneficiary_name: benName,
            beneficiary_document: benDoc,

            amount: item.amount as any,
            destination_type: "PIX" as any,
          },
        });

        // cria subtransactions (se item.amount > sub_amount, fraciona por linha)
        const parts = chunkAmount(item.amount, data.sub_amount);

        for (const part of parts) {
          await tx.core_order_subtransactions.create({
            data: {
              id: crypto.randomUUID(),
              order_id: order.id,
              status: "PENDING",
              amount: part as any,
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
            },
          });
        }
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
    console.error("createBulk error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal error", details: err?.message || String(err) }),
    };
  }
};
