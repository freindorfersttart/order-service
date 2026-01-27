"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const prisma_1 = require("../../lib/prisma");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jwt_1 = require("../../lib/jwt");
const handler = async (event) => {
    try {
        const adminId = (0, jwt_1.getUserIdFromEvent)(event);
        const admin = await prisma_1.prisma.auth_user.findUnique({ where: { id: adminId } });
        if (!admin || admin.role !== 'admin') {
            return {
                statusCode: 403,
                body: JSON.stringify({ message: 'Acesso negado' }),
            };
        }
        const userId = event.pathParameters?.id;
        if (!userId) {
            return {
                statusCode: 400,
                body: JSON.stringify({ message: 'ID do usuário não fornecido' }),
            };
        }
        const body = JSON.parse(event.body || '{}');
        const { name, email, password, role, permissions, is_active } = body;
        const dataToUpdate = {};
        if (name)
            dataToUpdate.name = name;
        if (email)
            dataToUpdate.email = email;
        if (role)
            dataToUpdate.role = role;
        if (permissions)
            dataToUpdate.permissions = permissions;
        if (typeof is_active === 'boolean')
            dataToUpdate.is_active = is_active;
        if (password)
            dataToUpdate.password = await bcryptjs_1.default.hash(password, 10);
        const updated = await prisma_1.prisma.auth_user.update({
            where: { id: userId },
            data: dataToUpdate,
        });
        return {
            statusCode: 200,
            body: JSON.stringify(updated),
        };
    }
    catch (error) {
        console.error(error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Erro ao atualizar usuário' }),
        };
    }
};
exports.handler = handler;
