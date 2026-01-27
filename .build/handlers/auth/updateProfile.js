"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const jwt_1 = require("../../lib/jwt");
const prisma_1 = require("../../lib/prisma");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const handler = async (event) => {
    try {
        const userId = (0, jwt_1.getUserIdFromEvent)(event);
        const body = JSON.parse(event.body || '{}');
        const { name, currentPassword, newPassword, confirmPassword } = body;
        const user = await prisma_1.prisma.auth_user.findUnique({ where: { id: userId } });
        if (!user) {
            return {
                statusCode: 404,
                body: JSON.stringify({ message: 'Usuário não encontrado' }),
            };
        }
        const dataToUpdate = {};
        if (name)
            dataToUpdate.name = name;
        if (currentPassword || newPassword || confirmPassword) {
            if (!currentPassword || !newPassword || !confirmPassword) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ message: 'Todos os campos de senha são obrigatórios.' }),
                };
            }
            const passwordMatches = await bcryptjs_1.default.compare(currentPassword, user.password);
            if (!passwordMatches) {
                return {
                    statusCode: 401,
                    body: JSON.stringify({ message: 'Senha atual incorreta.' }),
                };
            }
            if (newPassword !== confirmPassword) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ message: 'Nova senha e confirmação não coincidem.' }),
                };
            }
            dataToUpdate.password = await bcryptjs_1.default.hash(newPassword, 10);
        }
        const updatedUser = await prisma_1.prisma.auth_user.update({
            where: { id: userId },
            data: dataToUpdate,
        });
        return {
            statusCode: 200,
            body: JSON.stringify({
                id: updatedUser.id,
                email: updatedUser.email,
                name: updatedUser.name,
                role: updatedUser.role,
                permissions: updatedUser.permissions,
            }),
        };
    }
    catch (error) {
        console.error(error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Erro ao atualizar perfil' }),
        };
    }
};
exports.handler = handler;
