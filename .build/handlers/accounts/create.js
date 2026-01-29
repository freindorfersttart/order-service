"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.create = void 0;
const prisma_1 = require("@/lib/prisma");
const zod_1 = require("zod");
const schema = zod_1.z.object({
    bank_code: zod_1.z.string(),
    bank_name: zod_1.z.string(),
    account_number: zod_1.z.string(),
    agency_number: zod_1.z.string(),
    ispb: zod_1.z.string(),
    cnpj: zod_1.z.string(),
    pix_keys: zod_1.z.array(zod_1.z.string()),
    daily_limit: zod_1.z.number(),
    nightly_limit: zod_1.z.number(),
    per_operation_limit: zod_1.z.number(),
    integration_status: zod_1.z.string(),
    active: zod_1.z.boolean()
});
const create = async (event) => {
    try {
        const data = schema.parse(JSON.parse(event.body || '{}'));
        const account = await prisma_1.prisma.core_bank_accounts.create({ data });
        return {
            statusCode: 201,
            body: JSON.stringify(account)
        };
    }
    catch (err) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: err.message })
        };
    }
};
exports.create = create;
